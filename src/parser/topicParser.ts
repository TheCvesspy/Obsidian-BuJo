import { SprintTopic, TopicStatus, Priority } from '../types';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;
const WIKI_LINK_REGEX = /\[\[([^\]]+)\]\]/g;
const CHECKBOX_REGEX = /^[ \t]*-\s*\[([ xX><!-])\]/;
const H1_REGEX = /^#\s+(.+)/;

/** Parse YAML-like frontmatter from a topic file into a flat key-value map */
export function parseFrontmatter(content: string): Record<string, string> {
	const match = content.match(FRONTMATTER_REGEX);
	if (!match) return {};

	const result: Record<string, string> = {};
	for (const line of match[1].split('\n')) {
		const colonIdx = line.indexOf(':');
		if (colonIdx < 0) continue;
		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();
		if (key) result[key] = value;
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

	return {
		filePath,
		title,
		status,
		jira: fm['jira'] || null,
		priority,
		blocked,
		sprintId: fm['sprint'] || null,
		sortOrder,
		linkedPages,
		taskTotal,
		taskDone,
	};
}

/** Serialize frontmatter fields back to YAML string */
export function serializeFrontmatter(fields: Record<string, string | number | boolean | null>): string {
	const lines = ['---'];
	for (const [key, value] of Object.entries(fields)) {
		if (value === null || value === undefined) {
			lines.push(`${key}: `);
		} else {
			lines.push(`${key}: ${value}`);
		}
	}
	lines.push('---');
	return lines.join('\n');
}
