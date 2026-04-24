import { SprintTopic, TopicStatus, Priority, TopicImpact, TopicEffort } from '../types';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;
const WIKI_LINK_REGEX = /\[\[([^\]]+)\]\]/g;
const CHECKBOX_REGEX = /^[ \t]*-\s*\[([ xX><!-])\]/;
const H1_REGEX = /^#\s+(.+)/;
/** JIRA issue-key regex, global. Mirrors the one in JiraService. */
const ISSUE_KEY_REGEX_G = /[A-Z][A-Z0-9]+-\d+/g;

/** Parse YAML-like frontmatter from a topic file into a flat key-value map.
 *  Supports two scalar shapes:
 *    key: value
 *    key: |
 *      indented line 1
 *      indented line 2
 *  Folded-scalar values are joined with newlines (indentation stripped). */
export function parseFrontmatter(content: string): Record<string, string> {
	const match = content.match(FRONTMATTER_REGEX);
	if (!match) return {};

	const result: Record<string, string> = {};
	const lines = match[1].split('\n');
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const colonIdx = line.indexOf(':');
		if (colonIdx < 0) { i++; continue; }
		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();
		if (!key) { i++; continue; }

		// Folded scalar (`key: |`): absorb all subsequent lines that start with
		// whitespace, stripping the first level of indentation. Stops at the next
		// non-indented line (which is the next top-level key).
		if (value === '|') {
			const collected: string[] = [];
			i++;
			while (i < lines.length) {
				const next = lines[i];
				if (next.length === 0) { collected.push(''); i++; continue; }
				if (/^\s/.test(next)) {
					// Strip leading whitespace of exactly one indent unit; accept tabs or spaces.
					const stripped = next.replace(/^(\t| {1,4})/, '');
					collected.push(stripped);
					i++;
				} else {
					break;
				}
			}
			// Trim trailing empty lines for tidy storage
			while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
			result[key] = collected.join('\n');
			continue;
		}

		result[key] = value;
		i++;
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

	const assigneeRaw = fm['assignee']?.trim();
	const assignee = assigneeRaw ? assigneeRaw : null;

	const waitingOnRaw = fm['waitingOn']?.trim();
	const waitingOn = waitingOnRaw ? waitingOnRaw : null;

	const lastNudgedRaw = fm['lastNudged']?.trim();
	const lastNudged = lastNudgedRaw && /^\d{4}-\d{2}-\d{2}$/.test(lastNudgedRaw) ? lastNudgedRaw : null;

	const refsRaw = fm['refs'] ?? '';
	const refs = parseRefsField(refsRaw);

	// sprintHistory is stored as comma-separated IDs. Legacy topics with no history field
	// but an active sprint assignment get an in-memory backfill of [sprintId] so they
	// display something immediately — the stored history is still empty until next write.
	const sprintHistoryRaw = fm['sprintHistory']?.trim() ?? '';
	let sprintHistory = sprintHistoryRaw
		? sprintHistoryRaw.split(',').map(s => s.trim()).filter(Boolean)
		: [];
	const sprintId = fm['sprint'] || null;
	if (sprintHistory.length === 0 && sprintId) {
		sprintHistory = [sprintId];
	}

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

	return {
		filePath,
		title,
		status,
		jira,
		priority,
		blocked,
		sprintId,
		sortOrder,
		linkedPages,
		taskTotal,
		taskDone,
		impact,
		effort,
		dueDate,
		sprintHistory,
		assignee,
		waitingOn,
		lastNudged,
		refs,
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
