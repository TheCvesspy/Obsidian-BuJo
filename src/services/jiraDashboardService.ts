import { requestUrl, RequestUrlParam } from 'obsidian';
import { JiraDashboardIssue, PluginSettings } from '../types';

type Listener = () => void;

type DashboardState =
	| { kind: 'empty' }
	| { kind: 'loading' }
	| { kind: 'fresh'; issues: JiraDashboardIssue[]; fetchedAt: number }
	| { kind: 'error'; message: string; fetchedAt: number };

/**
 * JIRA Dashboard service.
 *
 * Owns a single cached result set — the union of issues matching "mine" (assignee, reporter,
 * or watcher) across configured projects, filtered to unresolved OR resolved in the last 7 days.
 * One JQL round-trip per refresh; the dashboard view slices the result client-side.
 *
 * Never writes to disk. Gated by the same `jiraEnabled` flag as JiraService — when disabled,
 * every method is a no-op.
 *
 * Performance posture:
 *   - No background polling. `refresh()` only fires when explicitly called (on view open,
 *     manual Refresh button, or auto-refresh triggered by the view when visible + stale).
 *   - In-flight fetches are deduplicated so two concurrent refresh calls share one request.
 *   - Cache cleared on settings save (URL/token/projects may have changed).
 */
export class JiraDashboardService {
	private state: DashboardState = { kind: 'empty' };
	private inFlight: Promise<JiraDashboardIssue[] | null> | null = null;
	private listeners = new Set<Listener>();
	private _version = 0;

	constructor(private getSettings: () => PluginSettings) {}

	isEnabled(): boolean {
		const s = this.getSettings();
		return s.jiraEnabled && !!s.jiraBaseUrl && !!s.jiraEmail && !!s.jiraApiToken;
	}

	get version(): number { return this._version; }

	/** Current cached issues (may be stale). Null if never fetched or errored. */
	getIssues(): JiraDashboardIssue[] | null {
		return this.state.kind === 'fresh' ? this.state.issues : null;
	}

	/** Timestamp of the last successful fetch (ms since epoch), or null. */
	getFetchedAt(): number | null {
		return this.state.kind === 'fresh' || this.state.kind === 'error' ? this.state.fetchedAt : null;
	}

	/** Error message from the last fetch, or null. */
	getError(): string | null {
		return this.state.kind === 'error' ? this.state.message : null;
	}

	isLoading(): boolean {
		return this.state.kind === 'loading';
	}

	/** Is the cache older than the configured TTL? Empty/error cache is considered stale. */
	isStale(): boolean {
		if (this.state.kind !== 'fresh') return true;
		const ttlMs = Math.max(0, this.getSettings().jiraDashboardTtlMinutes) * 60_000;
		return Date.now() - this.state.fetchedAt > ttlMs;
	}

	/** Fetch the dashboard result. Deduplicates concurrent calls. */
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

	/** Wipe the cache and notify listeners. */
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

	private async doFetch(): Promise<JiraDashboardIssue[] | null> {
		const s = this.getSettings();
		const jql = this.buildJql(s);
		const sprintField = (s.jiraSprintFieldId || 'customfield_10020').trim();

		// Field list sent to JIRA — plus the configurable sprint custom field
		// and the Flagged custom field (standard on Cloud). The new /search/jql
		// endpoint doesn't accept the `*all` magic token, so we name everything.
		const fields = [
			'summary', 'status', 'priority', 'assignee', 'reporter',
			'duedate', 'resolutiondate', 'updated', 'labels',
			'parent', 'issuetype', 'timespent', 'timeestimate',
			sprintField,
			'customfield_10021', // Flagged (Cloud standard)
		];

		// Use GET /rest/api/3/search/jql — the successor to the deprecated /search
		// endpoint (see https://developer.atlassian.com/changelog/#CHANGE-2046).
		// The new endpoint accepts both GET and POST; we prefer GET because some
		// tenants enforce XSRF on POSTs even with the X-Atlassian-Token header.
		const params = new URLSearchParams();
		params.set('jql', jql);
		params.set('fields', fields.join(','));
		params.set('maxResults', '100');

		console.log('[JIRA Dashboard] JQL:', jql);

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

			// `resp.json` is a getter that throws when the body isn't JSON
			// (e.g. "XSRF check failed" plain text on 403). Parse defensively.
			const parsedJson = this.safeParseJson(resp.text);

			if (resp.status < 200 || resp.status >= 300) {
				const msg = this.formatHttpError(resp.status, resp.text, parsedJson);
				console.error('[JIRA Dashboard] HTTP error:', resp.status, resp.text?.slice(0, 500));
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
			console.error('[JIRA Dashboard] fetch threw:', err);
			this.state = { kind: 'error', message: this.formatError(err), fetchedAt: Date.now() };
			this.bump();
			return null;
		}
	}

	/** Parse body as JSON without throwing on invalid input. */
	private safeParseJson(text: string | undefined): any {
		if (!text) return null;
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	}

	/** Build the JQL used for the dashboard fetch. */
	private buildJql(s: PluginSettings): string {
		const userClause = '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser())';
		const projectClause = s.jiraDashboardProjects.length > 0
			? `AND project in (${s.jiraDashboardProjects.map(k => `"${k.replace(/"/g, '')}"`).join(', ')})`
			: '';
		// Unresolved OR resolved within the last 7 days
		const staleClause = 'AND (resolution = Unresolved OR resolutiondate >= -7d)';
		return `${userClause} ${projectClause} ${staleClause} ORDER BY updated DESC`.replace(/\s+/g, ' ').trim();
	}

	/** Parse a single issue JSON into the dashboard shape. Tolerant of missing fields. */
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

		// Sprint field is an array of strings or objects depending on JIRA Cloud version.
		// Most common shape: array of objects with { name, state }. Fall back gracefully.
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
					// Legacy string form — best-effort extract of name=X
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

		// Flagged: JIRA exposes this under various custom fields. We look at the raw
		// issue object for any field whose name/value equals "Impediment"/"Flagged".
		let flagged = false;
		// Common Cloud custom field for Flagged is customfield_10021 — value is an array of objects
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
