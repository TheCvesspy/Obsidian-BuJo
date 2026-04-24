import { TeamMemberPage, TeamMemberStatus, OneOnOneCadence, OneOnOneSession } from '../types';
import { parseFrontmatter } from './topicParser';

const VALID_STATUS: ReadonlySet<string> = new Set(['active', 'on_leave', 'departed']);
const VALID_CADENCE: ReadonlySet<string> = new Set(['weekly', 'biweekly', 'monthly', 'skip']);
const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const ONE_ON_ONE_FILENAME_REGEX = /(\d{4})-(\d{2})-(\d{2})\.md$/;

/**
 * Parse a person-page markdown file into a `TeamMemberPage` object.
 *
 * The canonical person page lives at `{teamFolderPath}/{Name}/{Name}.md`.
 * `sessionPaths` must be supplied separately — the scanner tracks session
 * files independently and composes them in at query time so this parser
 * doesn't have to do filesystem lookups.
 *
 * Invalid or missing enum values fall back to safe defaults (`active`, `weekly`)
 * rather than throwing — a person page shouldn't crash the scanner.
 */
export function parseTeamMemberPage(
	content: string,
	filePath: string,
	sessionPaths: string[] = [],
): TeamMemberPage {
	const fm = parseFrontmatter(content);

	const lastSlash = filePath.lastIndexOf('/');
	const folderPath = lastSlash >= 0 ? filePath.substring(0, lastSlash) : '';
	const basename = (lastSlash >= 0 ? filePath.substring(lastSlash + 1) : filePath).replace(/\.md$/, '');

	const statusRaw = (fm['status'] ?? '').trim().toLowerCase();
	const status: TeamMemberStatus = VALID_STATUS.has(statusRaw)
		? (statusRaw as TeamMemberStatus)
		: 'active';

	const cadenceRaw = (fm['cadence'] ?? '').trim().toLowerCase();
	const cadence: OneOnOneCadence = VALID_CADENCE.has(cadenceRaw)
		? (cadenceRaw as OneOnOneCadence)
		: 'weekly';

	const role = trimOrNull(fm['role']);
	const email = trimOrNull(fm['email']);
	const jiraIdentity = trimOrNull(fm['jira_identity']) ?? email;
	const startDate = parseISODate(trimOrNull(fm['start_date']));

	const lastOneOnOne = computeLastSessionDate(sessionPaths);

	return {
		filePath,
		folderPath,
		name: basename,
		status,
		role,
		email,
		startDate,
		cadence,
		jiraIdentity,
		lastOneOnOne,
		sessionPaths,
	};
}

/**
 * Parse a 1:1 session file's path into a lightweight `OneOnOneSession`.
 * The body of the session file is NOT parsed here — the scanner only needs
 * to know which person the session belongs to (via folder path) and when
 * the session happened (via filename date). Action items inside the session
 * are parsed by the regular `taskParser` like any other checkbox content.
 */
export function parseOneOnOneSession(filePath: string): OneOnOneSession {
	const oneOnOneIdx = filePath.lastIndexOf('/1on1/');
	const memberFolderPath = oneOnOneIdx >= 0 ? filePath.substring(0, oneOnOneIdx) : '';

	const match = filePath.match(ONE_ON_ONE_FILENAME_REGEX);
	let sessionDate: Date | null = null;
	if (match) {
		const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
		if (!Number.isNaN(d.getTime())) sessionDate = d;
	}

	return { filePath, memberFolderPath, sessionDate };
}

/** Given a bag of session file paths, return the most recent session date, or null. */
export function computeLastSessionDate(sessionPaths: readonly string[]): Date | null {
	let best: Date | null = null;
	for (const p of sessionPaths) {
		const match = p.match(ONE_ON_ONE_FILENAME_REGEX);
		if (!match) continue;
		const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
		if (Number.isNaN(d.getTime())) continue;
		if (!best || d > best) best = d;
	}
	return best;
}

function trimOrNull(value: string | undefined): string | null {
	if (value === undefined) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function parseISODate(value: string | null): Date | null {
	if (!value) return null;
	const match = value.match(ISO_DATE_REGEX);
	if (!match) return null;
	const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	return Number.isNaN(d.getTime()) ? null : d;
}
