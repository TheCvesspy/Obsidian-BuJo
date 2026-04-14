import { requestUrl, RequestUrlParam } from 'obsidian';
import { JiraIssueInfo, PluginSettings } from '../types';

/** Matches standard JIRA issue keys: letters, optional digits, dash, number. */
const ISSUE_KEY_REGEX = /[A-Z][A-Z0-9]+-\d+/;

type FetchState =
	| { kind: 'fresh'; info: JiraIssueInfo }
	| { kind: 'stale'; info: JiraIssueInfo }
	| { kind: 'error'; message: string; fetchedAt: number }
	| { kind: 'loading' };

type Listener = () => void;

/**
 * JIRA Cloud integration.
 *
 * Module behavior:
 *   - Gated by settings.jiraEnabled. When disabled, every method is a no-op
 *     that returns null/false; no network traffic happens.
 *   - In-memory cache only — issue data is never written to disk.
 *   - Emits 'updated' events whenever the cache changes, so views can re-render.
 *
 * Concurrency:
 *   - In-flight fetches are deduplicated via inFlight map — asking for the
 *     same key twice while a fetch is pending returns the same promise.
 */
export class JiraService {
	private cache = new Map<string, FetchState>();
	private inFlight = new Map<string, Promise<JiraIssueInfo | null>>();
	private listeners = new Set<Listener>();
	/** Monotonic version — views can fold into their render fingerprint */
	private _version = 0;

	constructor(private getSettings: () => PluginSettings) {}

	/** Is the JIRA module currently enabled AND minimally configured? */
	isEnabled(): boolean {
		const s = this.getSettings();
		return s.jiraEnabled && !!s.jiraBaseUrl && !!s.jiraEmail && !!s.jiraApiToken;
	}

	get version(): number {
		return this._version;
	}

	/** Extract an issue key from a raw frontmatter `jira` value. Returns null if no key found. */
	extractIssueKey(raw: string | null | undefined): string | null {
		if (!raw) return null;
		const match = raw.match(ISSUE_KEY_REGEX);
		return match ? match[0] : null;
	}

	/** Extract every JIRA issue key from a raw string. Deduplicated, order-preserving. */
	extractAllIssueKeys(raw: string | null | undefined): string[] {
		if (!raw) return [];
		const global = new RegExp(ISSUE_KEY_REGEX.source, 'g');
		const seen = new Set<string>();
		const out: string[] = [];
		let m: RegExpExecArray | null;
		while ((m = global.exec(raw)) !== null) {
			if (!seen.has(m[0])) {
				seen.add(m[0]);
				out.push(m[0]);
			}
		}
		return out;
	}

	/** Get whatever's in the cache right now — may be stale, may be null. Never fetches. */
	getCached(key: string): JiraIssueInfo | null {
		const state = this.cache.get(key);
		if (!state) return null;
		if (state.kind === 'fresh' || state.kind === 'stale') return state.info;
		return null;
	}

	/** Get cached error state for a key (if the last fetch failed). */
	getError(key: string): string | null {
		const state = this.cache.get(key);
		return state?.kind === 'error' ? state.message : null;
	}

	/** Is an issue currently being fetched? */
	isLoading(key: string): boolean {
		return this.cache.get(key)?.kind === 'loading';
	}

	/** Has the cached entry aged past the configured TTL? */
	private isStale(info: JiraIssueInfo): boolean {
		const ttlMs = Math.max(0, this.getSettings().jiraCacheTtlMinutes) * 60_000;
		return Date.now() - info.fetchedAt > ttlMs;
	}

	/**
	 * Ensure `key` is fetched. If the cache is fresh, resolves immediately with
	 * cached info. Otherwise triggers a fetch and resolves when it completes.
	 * Returns null when the module is disabled or the fetch fails.
	 */
	async ensureFetched(key: string): Promise<JiraIssueInfo | null> {
		if (!this.isEnabled()) return null;
		const existing = this.cache.get(key);
		if (existing?.kind === 'fresh' && !this.isStale(existing.info)) {
			return existing.info;
		}
		return this.fetchIssue(key);
	}

	/** Force a fetch, bypassing TTL. */
	async fetchIssue(key: string): Promise<JiraIssueInfo | null> {
		if (!this.isEnabled()) return null;

		// Deduplicate: if already fetching this key, return that promise
		const pending = this.inFlight.get(key);
		if (pending) return pending;

		this.cache.set(key, { kind: 'loading' });
		const promise = this.doFetch(key);
		this.inFlight.set(key, promise);
		try {
			return await promise;
		} finally {
			this.inFlight.delete(key);
		}
	}

	/** Prefetch many keys in parallel. Resolves when all settle. Silences individual errors. */
	async prefetchMany(keys: string[]): Promise<void> {
		if (!this.isEnabled() || keys.length === 0) return;
		const deduped = Array.from(new Set(keys.filter(Boolean)));
		const tasks = deduped.map(k => this.ensureFetched(k).catch(() => null));
		await Promise.all(tasks);
	}

	/** Wipe the cache — useful when settings change (URL/token). */
	clearCache(): void {
		this.cache.clear();
		this.inFlight.clear();
		this.bumpVersion();
	}

	// ── Event subscription ────────────────────────────────────────

	on(listener: Listener): void {
		this.listeners.add(listener);
	}
	off(listener: Listener): void {
		this.listeners.delete(listener);
	}
	private bumpVersion(): void {
		this._version++;
		for (const l of this.listeners) {
			try { l(); } catch { /* ignore listener errors */ }
		}
	}

	// ── Settings self-test ────────────────────────────────────────

	/** Attempt a single authenticated GET against /myself. Used by the settings "Test connection" button.
	 *  Logs raw request/response/error details to the dev console ([JIRA] prefix) for diagnostics. */
	async testConnection(): Promise<{ ok: boolean; message: string }> {
		const s = this.getSettings();
		if (!s.jiraBaseUrl || !s.jiraEmail || !s.jiraApiToken) {
			return { ok: false, message: 'Fill in base URL, email, and API token first.' };
		}
		if (!/^https?:\/\//i.test(s.jiraBaseUrl)) {
			return { ok: false, message: `Base URL must start with http:// or https:// (got "${s.jiraBaseUrl}")` };
		}

		const req = this.buildRequest(s, '/rest/api/3/myself');
		console.log('[JIRA] testConnection →', req.url);
		try {
			const resp = await requestUrl(req);
			console.log('[JIRA] testConnection response:', { status: resp.status, headers: resp.headers, body: resp.text?.slice(0, 500) });

			if (resp.status >= 200 && resp.status < 300) {
				const name = resp.json?.displayName ?? 'unknown user';
				return { ok: true, message: `Connected as ${name}.` };
			}
			return { ok: false, message: this.formatHttpError(resp.status, resp.text, resp.json) };
		} catch (err) {
			console.error('[JIRA] testConnection threw:', err);
			return { ok: false, message: this.formatError(err) };
		}
	}

	// ── Internals ─────────────────────────────────────────────────

	private async doFetch(key: string): Promise<JiraIssueInfo | null> {
		const s = this.getSettings();
		const validKey = this.extractIssueKey(key);
		if (!validKey) {
			this.cache.set(key, { kind: 'error', message: `Invalid issue key: ${key}`, fetchedAt: Date.now() });
			this.bumpVersion();
			return null;
		}

		try {
			const resp = await requestUrl(this.buildRequest(
				s,
				`/rest/api/3/issue/${encodeURIComponent(validKey)}?fields=summary,status,assignee`,
			));
			if (resp.status < 200 || resp.status >= 300) {
				this.cache.set(key, { kind: 'error', message: `HTTP ${resp.status}`, fetchedAt: Date.now() });
				this.bumpVersion();
				return null;
			}
			const info = this.parseIssue(validKey, resp.json, s.jiraBaseUrl);
			this.cache.set(key, { kind: 'fresh', info });
			this.bumpVersion();
			return info;
		} catch (err) {
			this.cache.set(key, { kind: 'error', message: this.formatError(err), fetchedAt: Date.now() });
			this.bumpVersion();
			return null;
		}
	}

	private buildRequest(s: PluginSettings, path: string): RequestUrlParam {
		const url = s.jiraBaseUrl.replace(/\/+$/, '') + path;
		// btoa is available in the Obsidian (Electron/Chromium) runtime
		const auth = btoa(`${s.jiraEmail}:${s.jiraApiToken}`);
		return {
			url,
			method: 'GET',
			headers: {
				'Authorization': `Basic ${auth}`,
				'Accept': 'application/json',
			},
			// Prevent requestUrl from throwing on non-2xx — we handle it ourselves
			throw: false,
		};
	}

	private parseIssue(key: string, json: any, baseUrl: string): JiraIssueInfo {
		const fields = json?.fields ?? {};
		const statusObj = fields.status ?? {};
		const statusName: string = statusObj.name ?? 'Unknown';
		const rawCategory: string = statusObj.statusCategory?.key ?? 'unknown';
		const statusCategory: JiraIssueInfo['statusCategory'] =
			rawCategory === 'new' || rawCategory === 'indeterminate' || rawCategory === 'done'
				? rawCategory
				: 'unknown';

		const assigneeObj = fields.assignee;
		const assignee: string | null = assigneeObj?.displayName ?? null;

		return {
			key,
			summary: fields.summary ?? '',
			status: statusName,
			statusCategory,
			assignee,
			issueUrl: `${baseUrl.replace(/\/+$/, '')}/browse/${key}`,
			fetchedAt: Date.now(),
		};
	}

	private formatError(err: unknown): string {
		if (err instanceof Error) return err.message;
		if (typeof err === 'string') return err;
		if (err && typeof err === 'object') {
			const anyErr = err as Record<string, unknown>;
			// Obsidian's requestUrl throws objects like { status, message } or { code, ... }
			const parts: string[] = [];
			if (anyErr.status) parts.push(`status=${anyErr.status}`);
			if (anyErr.code) parts.push(`code=${anyErr.code}`);
			if (anyErr.message) parts.push(String(anyErr.message));
			if (parts.length > 0) return parts.join(' ');
			try { return JSON.stringify(err); } catch { /* fall through */ }
		}
		return 'Unknown error';
	}

	/** Format an HTTP error response, including JIRA's structured errorMessages/errors when present. */
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
