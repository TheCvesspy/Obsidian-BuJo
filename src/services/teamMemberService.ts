import { Vault, TFile } from 'obsidian';
import {
	TeamMemberPage,
	OneOnOneCadence,
	PluginSettings,
	TeamMember,
} from '../types';
import { VaultScanner } from './vaultScanner';
import { ensureFolderExists, sanitizePathSegment } from '../utils/pathUtils';
import { formatDateISO } from '../utils/dateUtils';

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
	async startOneOnOne(member: TeamMemberPage, date: Date = new Date()): Promise<TFile> {
		const iso = formatDateISO(date);
		const sessionFolder = `${member.folderPath}/1on1`;
		const sessionPath = `${sessionFolder}/${iso}.md`;

		const existing = this.vault.getAbstractFileByPath(sessionPath);
		if (existing instanceof TFile) return existing;

		await ensureFolderExists(this.vault, sessionFolder);
		const template = buildOneOnOneTemplate(member.name, iso);
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
		const status = member.active ? 'active' : 'departed';
		const content = buildPersonPageTemplate(
			member.fullName,
			status,
			member.email || null,
		);
		await this.vault.create(pagePath, content);
		return true;
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

function buildOneOnOneTemplate(memberName: string, iso: string): string {
	return `---
session_date: ${iso}
---

# 1:1 with [[${memberName}]] — ${iso}

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

function buildPersonPageTemplate(
	fullName: string,
	status: 'active' | 'departed',
	email: string | null,
): string {
	const fmLines = ['---', `status: ${status}`, 'cadence: weekly'];
	if (email) {
		fmLines.push(`email: ${email}`);
		fmLines.push(`jira_identity: ${email}`);
	}
	fmLines.push('---');

	const body = [
		'',
		`# ${fullName}`,
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
