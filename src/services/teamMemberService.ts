import { Vault, TFile } from 'obsidian';
import {
	TeamMemberPage,
	TeamMemberStatus,
	OneOnOneCadence,
	PluginSettings,
	TeamMember,
} from '../types';
import { VaultScanner } from './vaultScanner';
import { parseTeamMemberPage } from '../parser/teamMemberParser';
import { ensureFolderExists, sanitizePathSegment } from '../utils/pathUtils';
import { formatDateISO } from '../utils/dateUtils';

/** Editable person-page fields for `updateMemberFrontmatter`. Presence of a key
 *  means "write it"; an empty string / null clears the underlying frontmatter key.
 *  `cadence`/`status` are enums and can only be set (not cleared) — omit to leave as-is. */
export interface MemberFrontmatterUpdate {
	role?: string | null;
	email?: string | null;
	jiraIdentity?: string | null;
	startDate?: string | null;
	cadence?: OneOnOneCadence;
	status?: TeamMemberStatus;
}

/** Options for creating a new person page. */
export interface CreateMemberOptions {
	name: string;
	role?: string | null;
	email?: string | null;
	jiraIdentity?: string | null;
	cadence?: OneOnOneCadence;
	status?: TeamMemberStatus;
	/** ISO `YYYY-MM-DD`. */
	startDate?: string | null;
}

/** Days-in-window for each cadence value. `skip` = never overdue. */
const CADENCE_DAYS: Record<OneOnOneCadence, number> = {
	weekly: 7,
	biweekly: 14,
	monthly: 30,
	skip: Number.POSITIVE_INFINITY,
};

/** "Due soon" buffer: when the next 1:1 falls within N days of its cadence window,
 *  the overview card shows a yellow `due-soon` chip instead of the green `on-track` one. */
const DUE_SOON_BUFFER_DAYS = 2;

export type CadenceState =
	| 'on-track'      // well inside the cadence window
	| 'due-soon'      // within `DUE_SOON_BUFFER_DAYS` of the boundary
	| 'overdue'       // past the boundary
	| 'suspended'     // status !== active OR cadence === 'skip'
	| 'never';        // active, cadence enforced, but no sessions yet and start_date still fresh

export interface CadenceSignal {
	state: CadenceState;
	/** Days since the last 1:1 (or since start_date when no 1:1s yet). Null when state is `suspended`. */
	daysSince: number | null;
}

export interface OverdueOneOnOne {
	member: TeamMemberPage;
	daysOverdue: number;
}

/**
 * Team-management service.
 *
 * State is owned by `VaultScanner` (person pages + 1:1 sessions are indexed there
 * alongside tasks and topics). This service layers behavior on top: cadence math,
 * session file creation, and the one-shot migration from the legacy
 * `PluginSettings.teamMembers[]` list into individual person pages.
 */
export class TeamMemberService {
	constructor(
		private vault: Vault,
		private scanner: VaultScanner,
		private getSettings: () => PluginSettings,
	) {}

	/** Every person page in the vault, regardless of status. */
	getAllMembers(): TeamMemberPage[] {
		return this.scanner.getAllTeamPages();
	}

	/** Members shown on the overview: everyone except `departed`. */
	getVisibleMembers(): TeamMemberPage[] {
		return this.getAllMembers().filter(m => m.status !== 'departed');
	}

	/** Members eligible for 1:1 cadence enforcement. */
	getActiveMembers(): TeamMemberPage[] {
		return this.getAllMembers().filter(m => m.status === 'active');
	}

	getMember(folderPath: string): TeamMemberPage | null {
		return this.getAllMembers().find(m => m.folderPath === folderPath) ?? null;
	}

	/** Compute where a member sits on the cadence axis. Pure function of the
	 *  member + today's date — cheap to call per render. */
	computeCadenceSignal(member: TeamMemberPage, today: Date = todayAtMidnight()): CadenceSignal {
		if (member.status !== 'active' || member.cadence === 'skip') {
			return { state: 'suspended', daysSince: null };
		}
		const windowDays = CADENCE_DAYS[member.cadence];

		if (!member.lastOneOnOne) {
			// Never had a 1:1. Overdue only if they've been on the team longer than the window.
			if (member.startDate) {
				const daysSinceStart = daysBetween(member.startDate, today);
				if (daysSinceStart > windowDays) {
					return { state: 'overdue', daysSince: daysSinceStart };
				}
			}
			return { state: 'never', daysSince: null };
		}

		const daysSince = daysBetween(member.lastOneOnOne, today);
		if (daysSince > windowDays) return { state: 'overdue', daysSince };
		if (daysSince > windowDays - DUE_SOON_BUFFER_DAYS) return { state: 'due-soon', daysSince };
		return { state: 'on-track', daysSince };
	}

	/** Active members whose 1:1 cadence has elapsed, sorted most-overdue first.
	 *  Used by the morning-review "Overdue 1:1s" section. */
	getOverdueOneOnOnes(today: Date = todayAtMidnight()): OverdueOneOnOne[] {
		const out: OverdueOneOnOne[] = [];
		for (const member of this.getActiveMembers()) {
			const signal = this.computeCadenceSignal(member, today);
			if (signal.state === 'overdue') {
				out.push({ member, daysOverdue: signal.daysSince ?? 0 });
			}
		}
		out.sort((a, b) => b.daysOverdue - a.daysOverdue);
		return out;
	}

	/** Create a new 1:1 session file at `{member}/1on1/YYYY-MM-DD.md` with the
	 *  standard template. If the file already exists (e.g. re-opening today's 1:1)
	 *  just returns the existing TFile — safe to call more than once. */
	async startOneOnOne(member: TeamMemberPage, date: Date = new Date(), agenda?: string): Promise<TFile> {
		const iso = formatDateISO(date);
		const sessionFolder = `${member.folderPath}/1on1`;
		const sessionPath = `${sessionFolder}/${iso}.md`;

		const existing = this.vault.getAbstractFileByPath(sessionPath);
		if (existing instanceof TFile) return existing;

		await ensureFolderExists(this.vault, sessionFolder);
		const template = buildOneOnOneTemplate(member.name, iso, agenda);
		return await this.vault.create(sessionPath, template);
	}

	/** Create a canonical person page from a legacy `TeamMember` settings entry.
	 *  No-op if the file already exists — safe to run repeatedly on startup. */
	async ensurePageFromSettings(member: TeamMember): Promise<boolean> {
		const settings = this.getSettings();
		const segment = sanitizePathSegment(member.fullName);
		if (!segment) return false;

		const folderPath = `${settings.teamFolderPath}/${segment}`;
		const pagePath = `${folderPath}/${segment}.md`;

		if (this.vault.getAbstractFileByPath(pagePath) instanceof TFile) return false;

		await ensureFolderExists(this.vault, `${folderPath}/1on1`);
		const content = buildPersonPageTemplate({
			name: member.fullName,
			status: member.active ? 'active' : 'departed',
			email: member.email || null,
			jiraIdentity: member.email || null,
		});
		await this.vault.create(pagePath, content);
		return true;
	}

	/** Resolve a member by display name (folder basename), email, or JIRA identity —
	 *  case-insensitive, with a name substring match as a last resort. Null if none match. */
	findMember(query: string): TeamMemberPage | null {
		const q = query.trim().toLowerCase();
		if (!q) return null;
		const members = this.getAllMembers();
		return (
			members.find(m => m.name.toLowerCase() === q) ??
			members.find(m => (m.email ?? '').toLowerCase() === q) ??
			members.find(m => (m.jiraIdentity ?? '').toLowerCase() === q) ??
			members.find(m => m.name.toLowerCase().includes(q)) ??
			null
		);
	}

	/** Create a new person page at `{teamFolderPath}/{Name}/{Name}.md`.
	 *  Throws if the name is unusable or a page already exists there.
	 *  Returns the parsed page (before the scanner has re-indexed it). */
	async createMemberPage(opts: CreateMemberOptions): Promise<TeamMemberPage> {
		const settings = this.getSettings();
		const segment = sanitizePathSegment(opts.name);
		if (!segment) throw new Error(`Invalid member name: "${opts.name}"`);

		const folderPath = `${settings.teamFolderPath}/${segment}`;
		const pagePath = `${folderPath}/${segment}.md`;
		if (this.vault.getAbstractFileByPath(pagePath) instanceof TFile) {
			throw new Error(`A team member page already exists at ${pagePath}`);
		}

		await ensureFolderExists(this.vault, `${folderPath}/1on1`);
		const content = buildPersonPageTemplate({
			name: opts.name,
			status: opts.status ?? 'active',
			cadence: opts.cadence ?? 'weekly',
			role: opts.role ?? null,
			email: opts.email ?? null,
			jiraIdentity: opts.jiraIdentity ?? opts.email ?? null,
			startDate: opts.startDate ?? null,
		});
		await this.vault.create(pagePath, content);
		return parseTeamMemberPage(content, pagePath);
	}

	/** Update managed frontmatter keys on a person page. Unmanaged frontmatter
	 *  (tags, aliases, user keys) is preserved verbatim. Does not rename the page. */
	async updateMemberFrontmatter(filePath: string, updates: MemberFrontmatterUpdate): Promise<void> {
		const file = this.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) throw new Error(`No file at ${filePath}`);

		const fm: Record<string, string | null> = {};
		if ('role' in updates) fm['role'] = normalizeOrNull(updates.role);
		if ('email' in updates) fm['email'] = normalizeOrNull(updates.email);
		if ('jiraIdentity' in updates) fm['jira_identity'] = normalizeOrNull(updates.jiraIdentity);
		if ('startDate' in updates) fm['start_date'] = normalizeOrNull(updates.startDate);
		if (updates.cadence) fm['cadence'] = updates.cadence;
		if (updates.status) fm['status'] = updates.status;

		await this.vault.process(file, content => applyPersonFrontmatter(content, fm));
	}
}

/** Whole-day delta. Negative result clamps to 0 so a future `from` date
 *  (nonsensical but possible) doesn't report a negative "days since". */
function daysBetween(from: Date, to: Date): number {
	const dayMs = 1000 * 60 * 60 * 24;
	const fromMidnight = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
	const toMidnight = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
	return Math.max(0, Math.floor((toMidnight - fromMidnight) / dayMs));
}

function todayAtMidnight(): Date {
	const d = new Date();
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function buildOneOnOneTemplate(memberName: string, iso: string, agenda?: string): string {
	const prep = agenda && agenda.trim() ? `\n## Prep (auto)\n${agenda.trim()}\n` : '';
	return `---
session_date: ${iso}
---

# 1:1 with [[${memberName}]] — ${iso}
${prep}
## Topics
-\u0020

## Notes
-\u0020

## Decisions
-\u0020

## Action Items
- [ ]  (from [[${memberName}]])

## Next Time
-\u0020
`;
}

interface PersonPageTemplateOptions {
	name: string;
	status: TeamMemberStatus;
	cadence?: OneOnOneCadence;
	role?: string | null;
	email?: string | null;
	jiraIdentity?: string | null;
	startDate?: string | null;
}

function buildPersonPageTemplate(opts: PersonPageTemplateOptions): string {
	// Emit in a stable, readable key order; skip keys with no value.
	const fmLines = ['---', `status: ${opts.status}`, `cadence: ${opts.cadence ?? 'weekly'}`];
	if (opts.role) fmLines.push(`role: ${opts.role}`);
	if (opts.email) fmLines.push(`email: ${opts.email}`);
	if (opts.jiraIdentity) fmLines.push(`jira_identity: ${opts.jiraIdentity}`);
	if (opts.startDate) fmLines.push(`start_date: ${opts.startDate}`);
	fmLines.push('---');

	const body = [
		'',
		`# ${opts.name}`,
		'',
		'## Context',
		'',
		'## Current Focus',
		'',
		'## Development',
		'',
		'## Wins & Feedback',
		'',
		'## Risks',
		'',
	].join('\n');

	return fmLines.join('\n') + body;
}

function normalizeOrNull(value: string | null | undefined): string | null {
	if (value === undefined || value === null) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

const PERSON_FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;

/** Splice managed key updates into a person page's YAML frontmatter, preserving
 *  every unmanaged line verbatim and key order. A `null` value removes the key;
 *  a key not yet present is appended. Synthesizes a frontmatter block if absent. */
function applyPersonFrontmatter(content: string, updates: Record<string, string | null>): string {
	const managed = new Set(Object.keys(updates));
	const match = content.match(PERSON_FRONTMATTER_REGEX);

	if (!match) {
		const fresh = Object.entries(updates)
			.filter(([, v]) => v !== null)
			.map(([k, v]) => `${k}: ${v}`);
		if (fresh.length === 0) return content;
		return `---\n${fresh.join('\n')}\n---\n\n` + content.trimStart();
	}

	const seen = new Set<string>();
	const out: string[] = [];
	for (const line of match[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z0-9_]+):\s?(.*)$/);
		if (kv && managed.has(kv[1])) {
			seen.add(kv[1]);
			const val = updates[kv[1]];
			if (val !== null) out.push(`${kv[1]}: ${val}`); // null → drop the key
		} else {
			out.push(line);
		}
	}
	for (const [key, val] of Object.entries(updates)) {
		if (!seen.has(key) && val !== null) out.push(`${key}: ${val}`);
	}

	const body = content.slice(match[0].length);
	return `---\n${out.join('\n')}\n---` + body;
}
