import { requestUrl, RequestUrlParam } from 'obsidian';
import { JiraDashboardIssue, PluginSettings } from '../types';

type Listener = () => void;

type TeamState =
	| { kind: 'empty' }
	| { kind: 'loading' }
	| { kind: 'fresh'; issues: JiraDashboardIssue[]; fetchedAt: number }
	| { kind: 'error'; message: string; fetchedAt: number };

/**
 * JIRA Team service.
 *
 * Sibling of `JiraDashboardService` but scoped to team-wide work rather than "mine".
 * Runs one JQL per refresh:
 *
 *   assignee in ("email1", "email2", …)
 *   [AND project in (configured)]
 *   AND (resolution = Unresolved OR resolutiondate >= -7d)
 *   ORDER BY updated DESC
 *
 * Why a separate service rather than a second cached result set on JiraDashboardService?
 *   - Different scope = different failure modes (empty team list, member without JIRA
 *     access, email → accountId mismatch). Isolating the team state keeps the personal
 *     dashboard untouched when the team fetch fails.
 *   - The dashboard view can render the personal part even if the team part errors.
 *
 * Fetch mechanics mirror JiraDashboardService — GET /rest/api/3/search/jql, explicit
 * field list (no `*all`), defensive JSON parsing, in-flight dedup. Never writes to
 * disk; cache cleared on every settings save.
 */
export class JiraTeamService {
	private state: TeamState = { kind: 'empty' };
	private inFlight: Promise<JiraDashboardIssue[] | null> | null = null;
	private listeners = new Set<Listener>();
	private _version = 0;

	constructor(private getSettings: () => PluginSettings) {}

	/** True if the master JIRA toggle AND the team toggle are on AND there's at least
	 *  one active team member with a valid-looking email. Everything else is a no-op. */
	isEnabled(): boolean {
		const s = this.getSettings();
		if (!s.jiraEnabled || !s.jiraTeamEnabled) return false;
		if (!s.jiraBaseUrl || !s.jiraEmail || !s.jiraApiToken) return false;
		return this.activeEmails(s).length > 0;
	}

	get version(): number { return this._version; }

	getIssues(): JiraDashboardIssue[] | null {
		return this.state.kind === 'fresh' ? this.state.issues : null;
	}

	getFetchedAt(): number | null {
		return this.state.kind === 'fresh' || this.state.kind === 'error' ? this.state.fetchedAt : null;
	}

	getError(): string | null {
		return this.state.kind === 'error' ? this.state.message : null;
	}

	isLoading(): boolean {
		return this.state.kind === 'loading';
	}

	isStale(): boolean {
		if (this.state.kind !== 'fresh') return true;
		const ttlMs = Math.max(0, this.getSettings().jiraDashboardTtlMinutes) * 60_000;
		return Date.now() - this.state.fetchedAt > ttlMs;
	}

	async refresh(): Promise<JiraDashboardIssue[] | null> {
		if (!this.isEnabled()) return null;
		if (this.inFlight) return this.inFlight;

		this.state = { kind: 'loading' };
		this.bump();

		const p = this.doFetch();
		this.inFlight = p;
		try {
			return await p;
		} finally {
			this.inFlight = null;
		}
	}

	clearCache(): void {
		this.state = { kind: 'empty' };
		this.inFlight = null;
		this.bump();
	}

	// ── Events ────────────────────────────────────────────────────

	on(listener: Listener): void { this.listeners.add(listener); }
	off(listener: Listener): void { this.listeners.delete(listener); }
	private bump(): void {
		this._version++;
		for (const l of this.listeners) {
			try { l(); } catch { /* swallow listener errors */ }
		}
	}

	// ── Internals ─────────────────────────────────────────────────

	private activeEmails(s: PluginSettings): string[] {
		return (s.teamMembers || [])
			.filter(m => m.active && m.email && m.email.includes('@'))
			.map(m => m.email.trim());
	}

	private buildJql(s: PluginSettings): string {
		const emails = this.activeEmails(s);
		// JQL accepts `assignee = "email"` on Cloud — Atlassian resolves to accountId.
		// Quote each email; strip any rogue double-quotes defensively.
		const userClause = `assignee in (${emails.map(e => `"${e.replace(/"/g, '')}"`).join(', ')})`;
		const projectClause = s.jiraDashboardProjects.length > 0
			? `AND project in (${s.jiraDashboardProjects.map(k => `"${k.replace(/"/g, '')}"`).join(', ')})`
			: '';
		const staleClause = 'AND (resolution = Unresolved OR resolutiondate >= -7d)';
		return `${userClause} ${projectClause} ${staleClause} ORDER BY updated DESC`.replace(/\s+/g, ' ').trim();
	}

	private async doFetch(): Promise<JiraDashboardIssue[] | null> {
		const s = this.getSettings();
		const jql = this.buildJql(s);
		const sprintField = (s.jiraSprintFieldId || 'customfield_10020').trim();

		const fields = [
			'summary', 'status', 'priority', 'assignee', 'reporter',
			'duedate', 'resolutiondate', 'updated', 'labels',
			'parent', 'issuetype', 'timespent', 'timeestimate',
			sprintField,
			'customfield_10021',
		];

		// Teams can have 50+ issues across 10 people, bump maxResults vs personal (100).
		// The endpoint caps at 100 anyway; paging is a future concern if the team is huge.
		const params = new URLSearchParams();
		params.set('jql', jql);
		params.set('fields', fields.join(','));
		params.set('maxResults', '100');

		console.log('[JIRA Team] JQL:', jql);

		try {
			const req: RequestUrlParam = {
				url: s.jiraBaseUrl.replace(/\/+$/, '') + '/rest/api/3/search/jql?' + params.toString(),
				method: 'GET',
				headers: {
					'Authorization': `Basic ${btoa(`${s.jiraEmail}:${s.jiraApiToken}`)}`,
					'Accept': 'application/json',
					'X-Atlassian-Token': 'no-check',
				},
				throw: false,
			};
			const resp = await requestUrl(req);
			const parsedJson = this.safeParseJson(resp.text);

			if (resp.status < 200 || resp.status >= 300) {
				const msg = this.formatHttpError(resp.status, resp.text, parsedJson);
				console.error('[JIRA Team] HTTP error:', resp.status, resp.text?.slice(0, 500));
				this.state = { kind: 'error', message: msg, fetchedAt: Date.now() };
				this.bump();
				return null;
			}

			const raw = (parsedJson?.issues ?? []) as any[];
			const issues = raw.map(r => this.parseIssue(r, s.jiraBaseUrl, sprintField));
			this.state = { kind: 'fresh', issues, fetchedAt: Date.now() };
			this.bump();
			return issues;
		} catch (err) {
			console.error('[JIRA Team] fetch threw:', err);
			this.state = { kind: 'error', message: this.formatError(err), fetchedAt: Date.now() };
			this.bump();
			return null;
		}
	}

	private safeParseJson(text: string | undefined): any {
		if (!text) return null;
		try { return JSON.parse(text); } catch { return null; }
	}

	/** Parse a single issue JSON. Mirrors JiraDashboardService.parseIssue, with the
	 *  same tolerance for missing fields. Kept local rather than exported to avoid
	 *  cross-service coupling — if the shape diverges later, each service can evolve. */
	private parseIssue(raw: any, baseUrl: string, sprintField: string): JiraDashboardIssue {
		const fields = raw?.fields ?? {};
		const statusObj = fields.status ?? {};
		const statusName: string = statusObj.name ?? 'Unknown';
		const rawCategory: string = statusObj.statusCategory?.key ?? 'unknown';
		const statusCategory: JiraDashboardIssue['statusCategory'] =
			rawCategory === 'new' || rawCategory === 'indeterminate' || rawCategory === 'done'
				? rawCategory
				: 'unknown';

		const priorityObj = fields.priority ?? null;
		const parent = fields.parent ?? null;
		const parentKey: string | null = parent?.key ?? null;
		const parentSummary: string | null = parent?.fields?.summary ?? null;
		const issueTypeObj = fields.issuetype ?? {};

		const sprintRaw = fields[sprintField];
		let sprintName: string | null = null;
		let sprintActive = false;
		if (Array.isArray(sprintRaw)) {
			for (const sp of sprintRaw) {
				if (sp && typeof sp === 'object') {
					const name = (sp as any).name;
					const state = (sp as any).state;
					if (state === 'active') {
						sprintName = name ?? sprintName;
						sprintActive = true;
						break;
					}
					if (!sprintName) sprintName = name ?? null;
				} else if (typeof sp === 'string') {
					const m = sp.match(/name=([^,\]]+)/);
					const state = sp.match(/state=([A-Z]+)/)?.[1];
					if (state === 'ACTIVE') {
						sprintName = m?.[1] ?? sprintName;
						sprintActive = true;
						break;
					}
					if (!sprintName && m) sprintName = m[1];
				}
			}
		}

		let flagged = false;
		const flaggedField = fields.customfield_10021 ?? fields.flagged;
		if (Array.isArray(flaggedField) && flaggedField.length > 0) flagged = true;
		else if (flaggedField && typeof flaggedField === 'object') flagged = true;

		const labels: string[] = Array.isArray(fields.labels) ? fields.labels.map(String) : [];

		return {
			key: raw.key,
			summary: fields.summary ?? '',
			status: statusName,
			statusCategory,
			issueType: issueTypeObj.name ?? 'Task',
			issueTypeIconUrl: issueTypeObj.iconUrl ?? null,
			priority: priorityObj?.name ?? null,
			priorityIconUrl: priorityObj?.iconUrl ?? null,
			assignee: fields.assignee?.displayName ?? null,
			assigneeEmail: fields.assignee?.emailAddress ?? null,
			assigneeAccountId: fields.assignee?.accountId ?? null,
			reporter: fields.reporter?.displayName ?? null,
			dueDate: fields.duedate ?? null,
			resolutionDate: fields.resolutiondate ?? null,
			updatedAt: fields.updated ?? new Date().toISOString(),
			labels,
			parentKey,
			parentSummary,
			sprintName,
			sprintActive,
			timeSpentSeconds: typeof fields.timespent === 'number' ? fields.timespent : null,
			timeRemainingSeconds: typeof fields.timeestimate === 'number' ? fields.timeestimate : null,
			flagged,
			issueUrl: `${baseUrl.replace(/\/+$/, '')}/browse/${raw.key}`,
		};
	}

	/** Extract the assignee's email from the raw issue JSON, for bucketing into per-person
	 *  sections. Note: the public API at top-level (`JiraDashboardIssue.assignee`) only
	 *  carries displayName — we'd need emailAddress to match back to `teamMembers[i].email`.
	 *  We avoid that by grouping client-side using displayName matches below; a future
	 *  upgrade can widen the parser to surface email + accountId. */

	private formatError(err: unknown): string {
		if (err instanceof Error) return err.message;
		if (typeof err === 'string') return err;
		if (err && typeof err === 'object') {
			const anyErr = err as Record<string, unknown>;
			const parts: string[] = [];
			if (anyErr.status) parts.push(`status=${anyErr.status}`);
			if (anyErr.message) parts.push(String(anyErr.message));
			if (parts.length > 0) return parts.join(' ');
			try { return JSON.stringify(err); } catch { /* fall through */ }
		}
		return 'Unknown error';
	}

	private formatHttpError(status: number, text: string | undefined, json: any): string {
		if (json && typeof json === 'object') {
			const messages: string[] = [];
			if (Array.isArray(json.errorMessages)) messages.push(...json.errorMessages.map(String));
			if (json.errors && typeof json.errors === 'object') {
				for (const [k, v] of Object.entries(json.errors)) {
					messages.push(`${k}: ${String(v)}`);
				}
			}
			if (messages.length > 0) return `HTTP ${status} — ${messages.join('; ')}`;
		}
		const snippet = (text ?? '').trim().slice(0, 200);
		return snippet ? `HTTP ${status} — ${snippet}` : `HTTP ${status}`;
	}
}
