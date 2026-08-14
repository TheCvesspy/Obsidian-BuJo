import { SprintTopic, TopicStatus, Priority, TopicImpact, TopicEffort } from '../types';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;
const WIKI_LINK_REGEX = /\[\[([^\]]+)\]\]/g;
const CHECKBOX_REGEX = /^[ \t]*-\s*\[([ xX><!-])\]/;
const H1_REGEX = /^#\s+(.+)/;
/** JIRA issue-key regex, global. Mirrors the one in JiraService. */
const ISSUE_KEY_REGEX_G = /[A-Z][A-Z0-9]+-\d+/g;

/** One top-level frontmatter entry: the key (null for orphan lines that belong to
 *  no key) and its verbatim source lines (key line + all continuation lines). */
interface RawFmEntry {
	key: string | null;
	raw: string[];
}

/** Split a frontmatter block's inner lines into top-level entries. A new entry
 *  starts at any line with no leading whitespace that isn't a list item and
 *  contains a colon; everything else (indented lines, `- ` list items, blanks)
 *  is a continuation of the previous entry, kept verbatim. This lets rewrites
 *  pass YAML shapes the flat parser can't represent (block lists, nested maps)
 *  through untouched instead of destroying them. */
function splitFrontmatterEntries(inner: string): RawFmEntry[] {
	const entries: RawFmEntry[] = [];
	let current: RawFmEntry | null = null;
	for (const line of inner.split('\n')) {
		const isKeyLine = !/^\s/.test(line) && !/^-(\s|$)/.test(line) && line.includes(':');
		const key = isKeyLine ? line.slice(0, line.indexOf(':')).trim() : '';
		if (isKeyLine && key) {
			current = { key, raw: [line] };
			entries.push(current);
		} else if (current) {
			current.raw.push(line);
		} else {
			current = { key: null, raw: [line] };
			entries.push(current);
		}
	}
	return entries;
}

/** Strip one pair of matching surrounding quotes (`"done"` / `'done'` → `done`).
 *  Values quoted by templates, Obsidian's Properties panel, or other tools would
 *  otherwise fail the enum/date matching and be misread forever. */
function stripMatchingQuotes(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		if ((first === '"' || first === "'") && value[value.length - 1] === first) {
			return value.slice(1, -1);
		}
	}
	return value;
}

/** Extract an entry's scalar value: inline (`key: value`, quotes stripped) or
 *  folded (`key: |` — continuation lines joined with newlines, one indent unit
 *  stripped, trailing blanks trimmed). */
function entryValue(entry: RawFmEntry): string {
	const first = entry.raw[0];
	const inline = first.slice(first.indexOf(':') + 1).trim();
	if (inline !== '|') return stripMatchingQuotes(inline);

	const collected: string[] = [];
	for (let i = 1; i < entry.raw.length; i++) {
		const next = entry.raw[i];
		if (next.length === 0) { collected.push(''); continue; }
		if (!/^\s/.test(next)) break;
		collected.push(next.replace(/^(\t| {1,4})/, ''));
	}
	while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
	return collected.join('\n');
}

/** Parse YAML-like frontmatter into a flat key-value map (read-only use).
 *  Supports `key: value` and `key: |` folded scalars; surrounding quotes are
 *  stripped from inline values. Keys whose value is a block list or nested map
 *  parse to '' — use parseFrontmatterForRewrite when writing back. */
export function parseFrontmatter(content: string): Record<string, string> {
	const match = content.match(FRONTMATTER_REGEX);
	if (!match) return {};

	const result: Record<string, string> = {};
	for (const entry of splitFrontmatterEntries(match[1])) {
		if (entry.key !== null) result[entry.key] = entryValue(entry);
	}
	return result;
}

/** Get the body content after frontmatter */
function getBody(content: string): string {
	const match = content.match(FRONTMATTER_REGEX);
	return match ? content.slice(match[0].length) : content;
}

/** Extract lines between a heading and the next heading of same or higher level */
function extractSection(body: string, heading: string): string[] {
	const lines = body.split('\n');
	const results: string[] = [];
	let inSection = false;

	for (const line of lines) {
		if (inSection) {
			// Stop at next ## heading
			if (/^##\s+/.test(line)) break;
			results.push(line);
		} else if (line.match(new RegExp(`^##\\s+${heading}\\s*$`, 'i'))) {
			inSection = true;
		}
	}
	return results;
}

/** Parse a topic markdown file into a SprintTopic object */
export function parseTopicFile(content: string, filePath: string): SprintTopic {
	const fm = parseFrontmatter(content);
	const body = getBody(content);

	// Extract title from first H1
	let title = filePath.split('/').pop()?.replace(/\.md$/, '') ?? 'Untitled';
	for (const line of body.split('\n')) {
		const h1Match = line.match(H1_REGEX);
		if (h1Match) {
			title = h1Match[1].trim();
			break;
		}
	}

	// Extract linked pages from ## Linked Pages
	const linkedLines = extractSection(body, 'Linked Pages');
	const linkedPages: string[] = [];
	for (const line of linkedLines) {
		let m: RegExpExecArray | null;
		WIKI_LINK_REGEX.lastIndex = 0;
		while ((m = WIKI_LINK_REGEX.exec(line)) !== null) {
			linkedPages.push(m[1]);
		}
	}

	// Count tasks from ## Tasks
	const taskLines = extractSection(body, 'Tasks');
	let taskTotal = 0;
	let taskDone = 0;
	for (const line of taskLines) {
		const cbMatch = line.match(CHECKBOX_REGEX);
		if (cbMatch) {
			taskTotal++;
			if (cbMatch[1].toLowerCase() === 'x') taskDone++;
		}
	}

	// Map frontmatter values
	const statusRaw = fm['status']?.toLowerCase();
	const status: TopicStatus =
		statusRaw === 'backlog' ? 'backlog' :
		statusRaw === 'in-progress' ? 'in-progress' :
		statusRaw === 'done' ? 'done' : 'open';

	const priorityRaw = fm['priority']?.toLowerCase();
	const priority: Priority =
		priorityRaw === 'high' ? Priority.High :
		priorityRaw === 'medium' ? Priority.Medium :
		priorityRaw === 'low' ? Priority.Low : Priority.None;

	const blockedRaw = fm['blocked']?.toLowerCase();
	const blocked = blockedRaw === 'true';

	const sortOrderRaw = parseInt(fm['sortOrder'], 10);
	const sortOrder = isNaN(sortOrderRaw) ? 999 : sortOrderRaw;

	const impactRaw = fm['impact']?.toLowerCase();
	const impact: TopicImpact | null =
		impactRaw === 'critical' ? 'critical' :
		impactRaw === 'high' ? 'high' :
		impactRaw === 'medium' ? 'medium' :
		impactRaw === 'low' ? 'low' : null;

	const effortRaw = fm['effort']?.toLowerCase();
	const effort: TopicEffort | null =
		effortRaw === 'xs' ? 'xs' :
		effortRaw === 's' ? 's' :
		effortRaw === 'm' ? 'm' :
		effortRaw === 'l' ? 'l' :
		effortRaw === 'xl' ? 'xl' : null;

	const dueDateRaw = fm['dueDate']?.trim();
	const dueDate = dueDateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dueDateRaw) ? dueDateRaw : null;

	// Kanban flow timestamps (ISO YYYY-MM-DD). Absent on legacy topics — left null.
	const parseIsoDate = (v: string | undefined): string | null => {
		const t = v?.trim();
		return t && /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
	};
	const statusSince = parseIsoDate(fm['statusSince']);
	const startedAt = parseIsoDate(fm['startedAt']);
	const doneAt = parseIsoDate(fm['doneAt']);

	// Planned roadmap start (estimated, user-controlled). Distinct from the flow timestamps
	// above: startDate is an estimate; startedAt/doneAt are actuals. The bar's end is dueDate.
	const startDate = parseIsoDate(fm['startDate']);

	// Snooze (deliberate deferral). Kept even when the date has passed — the "woke" signal
	// on the card comes from a stale value; clearing it is an explicit user action.
	const snoozedUntil = parseIsoDate(fm['snoozedUntil']);

	const assigneeRaw = fm['assignee']?.trim();
	const assignee = assigneeRaw ? assigneeRaw : null;

	const waitingOnRaw = fm['waitingOn']?.trim();
	const waitingOn = waitingOnRaw ? waitingOnRaw : null;

	const lastNudgedRaw = fm['lastNudged']?.trim();
	const lastNudged = lastNudgedRaw && /^\d{4}-\d{2}-\d{2}$/.test(lastNudgedRaw) ? lastNudgedRaw : null;

	const refsRaw = fm['refs'] ?? '';
	const refs = parseRefsField(refsRaw);

	// JIRA keys: extract every PROJ-123 match from the raw `jira:` value so that
	// `jira: PROJ-1, PROJ-2`, `jira: PROJ-1; PROJ-2`, and even `jira: PROJ-1` all work.
	// Deduplicated, order-preserving.
	const jiraRaw = fm['jira'] ?? '';
	const seenKeys = new Set<string>();
	const jira: string[] = [];
	ISSUE_KEY_REGEX_G.lastIndex = 0;
	let km: RegExpExecArray | null;
	while ((km = ISSUE_KEY_REGEX_G.exec(jiraRaw)) !== null) {
		if (!seenKeys.has(km[0])) {
			seenKeys.add(km[0]);
			jira.push(km[0]);
		}
	}

	// Topic dependencies: file paths this topic is blocked-by. Stored as a folded scalar
	// (newline-separated) so paths may safely contain commas. Tolerates a single inline value.
	const blockedByRaw = fm['blockedBy']?.trim() ?? '';
	const blockedBy = blockedByRaw
		? blockedByRaw.split('\n').map(s => s.trim()).filter(Boolean)
		: [];

	return {
		filePath,
		title,
		status,
		jira,
		priority,
		blocked,
		sortOrder,
		linkedPages,
		taskTotal,
		taskDone,
		impact,
		effort,
		dueDate,
		startDate,
		snoozedUntil,
		statusSince,
		startedAt,
		doneAt,
		assignee,
		waitingOn,
		lastNudged,
		refs,
		blockedBy,
	};
}

/** Parse the `refs:` folded-scalar value into { label, url } pairs.
 *  Each non-empty line is expected in the form `label | url`. Malformed lines are skipped.
 *  URLs must start with http:// or https:// to pass. */
export function parseRefsField(raw: string): Array<{ label: string; url: string }> {
	if (!raw) return [];
	const out: Array<{ label: string; url: string }> = [];
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const pipeIdx = trimmed.indexOf('|');
		if (pipeIdx < 0) continue;
		const label = trimmed.slice(0, pipeIdx).trim();
		const url = trimmed.slice(pipeIdx + 1).trim();
		if (!label || !url) continue;
		if (!/^https?:\/\//.test(url)) continue;
		out.push({ label, url });
	}
	return out;
}

/** Serialize a refs array back to a folded-scalar YAML value (without the `refs: |` prefix).
 *  Returns a newline-separated string of `label | url` lines, or empty string when array is empty. */
export function serializeRefs(refs: Array<{ label: string; url: string }>): string {
	return refs.map(r => `${r.label} | ${r.url}`).join('\n');
}

/** Marker for a value that should be serialized as a YAML folded scalar (`key: |`).
 *  Use for multi-line strings like `refs:`. */
export interface FoldedScalar { foldedScalar: string; }

export function foldedScalar(text: string): FoldedScalar {
	return { foldedScalar: text };
}

/** Canonical order for topic frontmatter keys, grouped by concern so the YAML reads
 *  top-to-bottom from "what / how urgent / which ticket" down to auto-stamped timestamps
 *  and multi-line relations. New topics are written in this order; edits re-sort to it.
 *  Keys not listed here (e.g. the legacy `sprint`) keep their relative order and sink to the end. */
export const TOPIC_FRONTMATTER_ORDER: readonly string[] = [
	'status', 'priority', 'jira',          // triage: what column / how urgent / which ticket
	'assignee', 'waitingOn', 'lastNudged', // ownership and follow-up
	'startDate', 'dueDate', 'snoozedUntil', // schedule (Roadmap span) + deliberate deferral
	'impact', 'effort',                    // strategy (Impact/Effort matrix)
	'blocked', 'sortOrder',                // board mechanics
	'statusSince', 'startedAt', 'doneAt',  // auto-stamped flow timestamps
	'blockedBy', 'refs',                   // multi-line relations (kept last for tidy YAML)
];

/** Every frontmatter key the plugin owns and may rewrite. `sprint`/`sprintHistory`
 *  are legacy keys kept managed so the startup migration can still strip them.
 *  Anything else in a topic's frontmatter (tags, aliases, cssclasses, user keys —
 *  including YAML block lists and nested maps the flat parser can't represent)
 *  must survive plugin rewrites verbatim. */
const MANAGED_TOPIC_KEYS = new Set<string>([...TOPIC_FRONTMATTER_ORDER, 'sprint', 'sprintHistory']);

export interface FrontmatterForRewrite {
	/** Plugin-managed keys, parsed to flat scalar values — safe to edit and re-serialize. */
	fields: Record<string, string>;
	/** Verbatim line blocks for every unmanaged entry — re-emit untouched, in order. */
	passthrough: string[];
}

/** Parse frontmatter for a write-back: managed keys become editable flat fields,
 *  everything else is captured as verbatim passthrough blocks so a rewrite can
 *  never destroy frontmatter the plugin doesn't understand. */
export function parseFrontmatterForRewrite(content: string): FrontmatterForRewrite {
	const fields: Record<string, string> = {};
	const passthrough: string[] = [];
	const match = content.match(FRONTMATTER_REGEX);
	if (!match) return { fields, passthrough };

	for (const entry of splitFrontmatterEntries(match[1])) {
		if (entry.key !== null && MANAGED_TOPIC_KEYS.has(entry.key)) {
			fields[entry.key] = entryValue(entry);
		} else {
			// Drop pure-blank orphan blocks; keep everything with content.
			const block = entry.raw.join('\n');
			if (block.trim().length > 0) passthrough.push(block);
		}
	}
	return { fields, passthrough };
}

/** Stable-sort frontmatter [key, value] entries into TOPIC_FRONTMATTER_ORDER. Unknown keys
 *  keep their original relative order and sink below all known keys. */
export function orderTopicFrontmatterEntries<T>(entries: [string, T][]): [string, T][] {
	const rank = (k: string): number => {
		const i = TOPIC_FRONTMATTER_ORDER.indexOf(k);
		return i === -1 ? Number.MAX_SAFE_INTEGER : i;
	};
	return entries
		.map((entry, i) => ({ entry, i }))
		.sort((a, b) => (rank(a.entry[0]) - rank(b.entry[0])) || (a.i - b.i))
		.map(x => x.entry);
}

/** Serialize frontmatter fields back to YAML string. Keys with null/undefined values
 *  are omitted. Values wrapped with `foldedScalar()` are emitted as `key: |` with
 *  indented body lines — useful for multi-line fields like `refs:`. */
export function serializeFrontmatter(
	fields: Record<string, string | number | boolean | null | undefined | FoldedScalar>,
): string {
	const lines = ['---'];
	for (const [key, value] of Object.entries(fields)) {
		if (value === null || value === undefined) continue;
		if (typeof value === 'object' && 'foldedScalar' in value) {
			const body = value.foldedScalar;
			if (!body.trim()) continue;
			lines.push(`${key}: |`);
			for (const bodyLine of body.split('\n')) {
				lines.push(`  ${bodyLine}`);
			}
			continue;
		}
		lines.push(`${key}: ${value}`);
	}
	lines.push('---');
	return lines.join('\n');
}
