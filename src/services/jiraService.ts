import { requestUrl, RequestUrlParam } from 'obsidian';
import { JiraIssueInfo, PluginSettings, Priority } from '../types';

/** Matches standard JIRA issue keys: letters, optional digits, dash, number. */
const ISSUE_KEY_REGEX = /[A-Z][A-Z0-9]+-\d+/;

/** Map a JIRA priority name to the topic Priority enum. Best-effort — JIRA has 5
 *  levels (Highest/High/Medium/Low/Lowest), topics have 3. Used when seeding a topic
 *  from a JIRA issue. */
export function mapJiraPriority(jiraPriority: string | null): Priority {
	if (!jiraPriority) return Priority.None;
	const k = jiraPriority.toLowerCase();
	if (k.includes('highest') || k === 'high') return Priority.High;
	if (k.includes('medium')) return Priority.Medium;
	if (k.includes('low') || k.includes('lowest')) return Priority.Low;
	return Priority.None;
}

type FetchState =
	| { kind: 'fresh'; info: JiraIssueInfo }
	| { kind: 'stale'; info: JiraIssueInfo }
	| { kind: 'error'; message: string; fetchedAt: number; attempts: number; httpStatus?: number }
	| { kind: 'loading'; attempts: number };

type Listener = () => void;

/** First retry delay after a failed fetch; doubles per consecutive failure. */
const ERROR_RETRY_BASE_MS = 30_000;
/** Ceiling for the exponential retry backoff. */
const ERROR_RETRY_MAX_MS = 30 * 60_000;
/** Retry delay for "permanent" failures (404 deleted issue, 403 no permission). */
const PERMANENT_ERROR_TTL_MS = 60 * 60_000;
/** Max simultaneous issue fetches in prefetchMany — a big board must not fire
 *  hundreds of parallel requests at Atlassian (instant 429s). */
const PREFETCH_CONCURRENCY = 5;
/** Fallback pause when a 429 arrives without a Retry-After header. */
const DEFAULT_RATE_LIMIT_PAUSE_MS = 60_000;

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
	/** Service-wide fetch pause after a 429 (epoch ms). The tenant is throttling us,
	 *  so no key should fetch until it passes — a per-key error would just shift the
	 *  hammering to the next key. */
	private pausedUntil = 0;

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
	 * cached info. Error entries are retried only after a backoff window —
	 * otherwise a single dead key (deleted issue, no permission) would refetch on
	 * every render in a version-bump → re-render → prefetch loop.
	 * Returns null when the module is disabled, paused, in backoff, or the fetch fails.
	 */
	async ensureFetched(key: string): Promise<JiraIssueInfo | null> {
		if (!this.isEnabled()) return null;
		if (Date.now() < this.pausedUntil) return this.getCached(key);
		const existing = this.cache.get(key);
		if (existing?.kind === 'fresh' && !this.isStale(existing.info)) {
			return existing.info;
		}
		if (existing?.kind === 'error' && Date.now() - existing.fetchedAt < this.errorRetryDelay(existing)) {
			return null;
		}
		return this.fetchIssue(key);
	}

	/** How long a failed key stays quiet before it may be retried. */
	private errorRetryDelay(state: { attempts: number; httpStatus?: number }): number {
		if (state.httpStatus === 404 || state.httpStatus === 403) return PERMANENT_ERROR_TTL_MS;
		return Math.min(ERROR_RETRY_BASE_MS * 2 ** Math.max(0, state.attempts - 1), ERROR_RETRY_MAX_MS);
	}

	/** Force a fetch, bypassing TTL. */
	async fetchIssue(key: string): Promise<JiraIssueInfo | null> {
		if (!this.isEnabled()) return null;

		// Deduplicate: if already fetching this key, return that promise
		const pending = this.inFlight.get(key);
		if (pending) return pending;

		const prev = this.cache.get(key);
		const attempts = prev?.kind === 'error' ? prev.attempts : 0;
		this.cache.set(key, { kind: 'loading', attempts });
		const promise = this.doFetch(key, attempts);
		this.inFlight.set(key, promise);
		try {
			return await promise;
		} finally {
			this.inFlight.delete(key);
		}
	}

	/** Prefetch many keys. Runs at most PREFETCH_CONCURRENCY fetches at a time
	 *  (cache hits cost nothing, so large boards stay cheap once warm).
	 *  Resolves when all settle. Silences individual errors. */
	async prefetchMany(keys: string[]): Promise<void> {
		if (!this.isEnabled() || keys.length === 0) return;
		const deduped = Array.from(new Set(keys.filter(Boolean)));
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < deduped.length) {
				const k = deduped[next++];
				await this.ensureFetched(k).catch(() => null);
			}
		};
		const workers = Array.from(
			{ length: Math.min(PREFETCH_CONCURRENCY, deduped.length) },
			() => worker(),
		);
		await Promise.all(workers);
	}

	/** Wipe the cache — useful when settings change (URL/token). */
	clearCache(): void {
		this.cache.clear();
		this.inFlight.clear();
		this.pausedUntil = 0;
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

	private async doFetch(key: string, prevAttempts: number): Promise<JiraIssueInfo | null> {
		const s = this.getSettings();
		const validKey = this.extractIssueKey(key);
		if (!validKey) {
			this.setError(key, `Invalid issue key: ${key}`, prevAttempts + 1);
			return null;
		}

		try {
			const flaggedField = (s.jiraFlaggedFieldId || 'customfield_10021').trim();
			const resp = await requestUrl(this.buildRequest(
				s,
				`/rest/api/3/issue/${encodeURIComponent(validKey)}?fields=summary,status,assignee,priority,duedate,description,${flaggedField},issuelinks`,
			));
			if (resp.status === 429) {
				// Tenant-wide throttling — pause the whole service, don't blame the key.
				const retryAfterSec = Number(resp.headers?.['retry-after'] ?? resp.headers?.['Retry-After']);
				const pauseMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
					? retryAfterSec * 1000
					: DEFAULT_RATE_LIMIT_PAUSE_MS;
				this.pausedUntil = Date.now() + pauseMs;
				this.setError(key, 'Rate limited by JIRA', prevAttempts, 429);
				return null;
			}
			if (resp.status < 200 || resp.status >= 300) {
				this.setError(key, `HTTP ${resp.status}`, prevAttempts + 1, resp.status);
				return null;
			}
			const info = this.parseIssue(validKey, resp.json, s.jiraBaseUrl, flaggedField);
			this.cache.set(key, { kind: 'fresh', info });
			this.bumpVersion();
			return info;
		} catch (err) {
			this.setError(key, this.formatError(err), prevAttempts + 1);
			return null;
		}
	}

	private setError(key: string, message: string, attempts: number, httpStatus?: number): void {
		this.cache.set(key, { kind: 'error', message, fetchedAt: Date.now(), attempts, httpStatus });
		this.bumpVersion();
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

	private parseIssue(key: string, json: any, baseUrl: string, flaggedField: string): JiraIssueInfo {
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
		const assigneeEmail: string | null = assigneeObj?.emailAddress ?? null;

		const priority: string | null = fields.priority?.name ?? null;
		const dueDate: string | null =
			typeof fields.duedate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fields.duedate)
				? fields.duedate
				: null;

		const description = flattenAdf(fields.description);

		// Flagged (impediment): present as a non-empty array or an object when set.
		let flagged = false;
		const flaggedRaw = fields[flaggedField] ?? fields.customfield_10021 ?? fields.flagged;
		if (Array.isArray(flaggedRaw) && flaggedRaw.length > 0) flagged = true;
		else if (flaggedRaw && typeof flaggedRaw === 'object') flagged = true;

		// Inward "is blocked by" issue links → the issues blocking this one. Tolerant of a
		// missing issuelinks field (some field allowlists strip it) — defaults to [].
		const blockingLinks: Array<{ key: string; done: boolean }> = [];
		const issuelinks = Array.isArray(fields.issuelinks) ? fields.issuelinks : [];
		for (const link of issuelinks) {
			const inward = String(link?.type?.inward ?? '').toLowerCase();
			if (inward.includes('blocked by') && link?.inwardIssue?.key) {
				const cat = link.inwardIssue.fields?.status?.statusCategory?.key ?? 'unknown';
				blockingLinks.push({ key: link.inwardIssue.key, done: cat === 'done' });
			}
		}

		return {
			key,
			summary: fields.summary ?? '',
			status: statusName,
			statusCategory,
			assignee,
			assigneeEmail,
			priority,
			dueDate,
			description,
			flagged,
			blockingLinks,
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

/** Max characters of flattened description to carry into a topic's Notes. Long JIRA
 *  descriptions get truncated (with a marker) so they don't bloat the note. */
const ADF_TEXT_CAP = 2000;

/** Flatten a JIRA description into lightweight Markdown. The v3 API returns descriptions as
 *  ADF (Atlassian Document Format — a JSON node tree); older configs may return a plain string.
 *  We walk the tree collecting text, turning block nodes into line breaks, list items into
 *  "- " bullets, and preserving links as `[text](url)` (the most valuable thing to keep —
 *  Confluence/Figma/etc.). Not a full converter; tables/panels degrade to plain lines. Output
 *  is capped at ADF_TEXT_CAP. Returns null when there's no usable text. */
export function flattenAdf(node: unknown): string | null {
	if (node == null) return null;
	if (typeof node === 'string') {
		const t = node.trim();
		return t.length > 0 ? cap(t) : null;
	}

	const BLOCK_TYPES = new Set([
		'paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList',
		'codeBlock', 'rule', 'panel', 'mediaSingle', 'table', 'tableRow',
	]);

	const walk = (n: any): string => {
		if (!n || typeof n !== 'object') return '';
		if (n.type === 'text') {
			const text = typeof n.text === 'string' ? n.text : '';
			const link = Array.isArray(n.marks) ? n.marks.find((m: any) => m?.type === 'link') : null;
			const href = link?.attrs?.href;
			return href ? `[${text}](${href})` : text;
		}
		if (n.type === 'hardBreak') return '\n';
		if (n.type === 'mention') return n.attrs?.text ? `${n.attrs.text} ` : '';
		// Smart links / embeds render as the bare URL so the link survives.
		if (n.type === 'inlineCard' || n.type === 'blockCard') return n.attrs?.url ? `${n.attrs.url} ` : '';
		const inner = Array.isArray(n.content) ? n.content.map(walk).join('') : '';
		if (n.type === 'listItem') return `- ${inner.trim()}\n`;
		if (n.type === 'tableCell' || n.type === 'tableHeader') return `${inner.trim()} `;
		if (BLOCK_TYPES.has(n.type)) return `${inner}\n`;
		return inner;
	};

	const cleaned = walk(node)
		.split('\n')
		.map(line => line.replace(/[ \t]+$/, ''))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return cleaned.length > 0 ? cap(cleaned) : null;
}

/** Truncate at a word/line boundary near ADF_TEXT_CAP, appending a marker when cut. */
function cap(text: string): string {
	if (text.length <= ADF_TEXT_CAP) return text;
	const slice = text.slice(0, ADF_TEXT_CAP);
	const cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
	return `${slice.slice(0, cut > ADF_TEXT_CAP * 0.6 ? cut : ADF_TEXT_CAP).trimEnd()}\n\n…(truncated — see the JIRA issue for the full description)`;
}
