import {
	PluginSettings,
	SprintTopic,
	TeamRollup,
	MemberRollup,
	WorkloadCounts,
	LoadSignal,
	BlockerEntry,
	RiskEntry,
} from '../types';
import { Vault, TFile } from 'obsidian';
import { TeamMemberService } from './teamMemberService';
import { JiraTeamService } from './jiraTeamService';
import { bucketIssuesByMember } from '../utils/teamBucket';
import { buildTopicIndex } from './topicGraph';
import { deriveTopicBlock, deriveTopicRisk } from './topicStatus';
import { formatDateISO, daysBetween } from '../utils/dateUtils';

/**
 * Pure aggregation over three independent work sources — JIRA team issues (live, in-memory),
 * Sprint topics keyed by assignee, and 1:1 cadence from person pages. Each source degrades
 * independently: JIRA off → topic-only figures; no members → an empty-but-valid roll-up.
 */
export class TeamRollupService {
	constructor(
		private getSettings: () => PluginSettings,
		private teamMemberService: TeamMemberService,
		private teamJiraService: JiraTeamService,
		private getAllTopics: () => SprintTopic[],
	) {}

	buildRollup(now: Date = new Date()): TeamRollup {
		const s = this.getSettings();
		const todayIso = formatDateISO(now);
		const activeMembers = (s.teamMembers ?? []).filter(m => m.active && m.email);

		const jiraEnabled = this.teamJiraService.isEnabled();
		const liveIssues = jiraEnabled ? this.teamJiraService.getIssues() : null;
		const jiraIncluded = jiraEnabled && liveIssues !== null;
		const issues = liveIssues ?? [];
		const byMember = bucketIssuesByMember(issues, activeMembers);

		const topics = this.getAllTopics();
		const index = buildTopicIndex(topics);
		const isTopicBlocked = (t: SprintTopic): boolean =>
			deriveTopicBlock({ topic: t, blockersOf: (x) => index.blockersOf(x) }).state === 'blocked';

		const pages = this.teamMemberService.getVisibleMembers();
		const nameByEmail = new Map(activeMembers.map(m => [m.email.toLowerCase(), m.nickname || m.fullName || m.email]));
		const ownerName = (email: string | null): string | null =>
			email ? (nameByEmail.get(email.toLowerCase()) ?? email) : null;

		const members: MemberRollup[] = [];
		for (const m of activeMembers) {
			const email = m.email;
			const jissues = byMember.get(email) ?? [];
			// A JIRA flag (impediment) is independent of status, and the team JQL pulls
			// recently-resolved issues — so only count a flag as a live blocker when the
			// issue isn't done. A done-but-still-flagged issue counts in jiraDone only.
			const jiraBlocked = jissues.filter(i => i.flagged && i.statusCategory !== 'done').length;
			const jiraInProgress = jissues.filter(i => !i.flagged && i.statusCategory === 'indeterminate').length;
			const jiraOpen = jissues.filter(i => !i.flagged && i.statusCategory !== 'indeterminate' && i.statusCategory !== 'done').length;
			const jiraDone = jissues.filter(i => i.statusCategory === 'done').length;

			const memberTopics = topics.filter(t => t.assignee && t.assignee.toLowerCase() === email.toLowerCase());
			const topicsOpen = memberTopics.filter(t => t.status === 'open').length;
			const topicsInProgress = memberTopics.filter(t => t.status === 'in-progress').length;
			const topicsDone = memberTopics.filter(t => t.status === 'done').length;
			const blockedTopics = memberTopics.filter(t => t.status !== 'done' && isTopicBlocked(t));
			const topicsBlocked = blockedTopics.length;

			const counts: WorkloadCounts = {
				jiraBlocked, jiraInProgress, jiraOpen, jiraDone,
				topicsBlocked, topicsInProgress, topicsOpen, topicsDone,
			};

			// Resolve the person page up front so on-leave status can force the 'out' band.
			const page = pages.find(p => p.email && p.email.toLowerCase() === email.toLowerCase());
			const onLeave = page?.status === 'on_leave';

			// Committed = everything not-done across both sources (backlog topics excluded).
			const committed = jiraBlocked + jiraInProgress + jiraOpen + topicsOpen + topicsInProgress;
			const target = m.targetConcurrentItems ?? s.defaultTargetConcurrentItems ?? 5;
			const avail = m.availabilityPercent ?? 100;
			const effectiveTarget = target * (avail / 100);
			const ratio = effectiveTarget > 0 ? committed / effectiveTarget : null;
			let band: LoadSignal['band'];
			// On leave / OOO → 'out' regardless of committed count (matches the LoadSignal doc).
			if (onLeave || avail <= 0 || effectiveTarget <= 0) band = 'out';
			else if (ratio === null) band = 'balanced';
			else if (ratio <= 0.5) band = 'light';
			else if (ratio <= 1.0) band = 'balanced';
			else if (ratio <= 1.5) band = 'heavy';
			else band = 'overloaded';
			const load: LoadSignal = { committed, target: effectiveTarget, ratio, band };

			let cadenceState: string | null = null;
			let cadenceDays: number | null = null;
			if (page) {
				const sig = this.teamMemberService.computeCadenceSignal(page, now);
				cadenceState = sig.state;
				cadenceDays = sig.daysSince;
			}

			members.push({
				email,
				displayName: m.nickname || m.fullName || email,
				onLeave,
				cadenceState,
				cadenceDays,
				drivingJira: jissues.filter(i => i.statusCategory === 'indeterminate'),
				drivingTopics: memberTopics.filter(t => t.status === 'in-progress'),
				jiraIssues: jissues,
				topics: memberTopics,
				blockedTopics,
				counts,
				load,
			});
		}

		// ── Top blockers ──
		const topBlockers: BlockerEntry[] = [];
		for (const issue of issues) {
			// Don't report a resolved-but-still-flagged issue as a live blocker (mirrors the
			// at-risk loop's done guard below) — it would prompt wasted follow-up on finished work.
			if (issue.flagged && issue.statusCategory !== 'done') {
				topBlockers.push({
					kind: 'jira', ownerName: issue.assignee ?? null,
					title: issue.summary || issue.key, ref: issue.key, url: issue.issueUrl,
					detail: 'Flagged in JIRA',
				});
			}
		}
		const nudgeThreshold = s.nudgeThresholdDays ?? 7;
		for (const t of topics) {
			if (t.status === 'done') continue;
			if (isTopicBlocked(t)) {
				topBlockers.push({
					kind: 'topic-blocked', ownerName: ownerName(t.assignee),
					title: t.title, ref: t.filePath, url: null,
					detail: t.blocked ? 'Manually blocked' : 'Blocked by dependency',
				});
			}
			if (t.waitingOn) {
				const days = t.lastNudged ? daysBetween(t.lastNudged, todayIso) : null;
				const stale = t.lastNudged === null || (days !== null && days > nudgeThreshold);
				if (stale) {
					topBlockers.push({
						kind: 'topic-waiting', ownerName: ownerName(t.assignee),
						title: t.title, ref: t.filePath, url: null,
						detail: `Waiting on ${t.waitingOn}${t.lastNudged ? ` · ${days}d` : ' · never nudged'}`,
					});
				}
			}
		}

		// ── At risk (overdue or due within the urgency window) ──
		const urgency = s.urgencyThresholdDays ?? 2;
		const atRisk: RiskEntry[] = [];
		for (const issue of issues) {
			if (issue.statusCategory === 'done' || !issue.dueDate) continue;
			const d = daysBetween(todayIso, issue.dueDate);
			if (d !== null && d <= urgency) {
				atRisk.push({ kind: 'jira', ownerName: issue.assignee ?? null, title: issue.summary || issue.key, ref: issue.key, url: issue.issueUrl, dueDate: issue.dueDate, daysUntilDue: d });
			}
		}
		for (const t of topics) {
			if (t.status === 'done' || !t.dueDate) continue;
			const d = daysBetween(todayIso, t.dueDate);
			if (d !== null && d <= urgency) {
				atRisk.push({ kind: 'topic', ownerName: ownerName(t.assignee), title: t.title, ref: t.filePath, url: null, dueDate: t.dueDate, daysUntilDue: d });
			}
		}
		atRisk.sort((a, b) => a.daysUntilDue - b.daysUntilDue);

		const overdueOneOnOnes = this.teamMemberService.getOverdueOneOnOnes(now)
			.map(o => ({ name: o.member.name, daysOverdue: o.daysOverdue }));

		return { generatedAt: now.getTime(), jiraIncluded, members, topBlockers, atRisk, overdueOneOnOnes };
	}
}

export interface OneOnOneAgendaOptions {
	/** Read topic bodies for recent `## Notes` log entries. Omit to skip that section. */
	vault?: Vault;
	/** ISO date of the previous 1:1 — bounds "done since" and "notes since".
	 *  Null/omitted falls back to the last 14 days. */
	sinceIso?: string | null;
	/** Aging threshold for the "sitting in In Progress" section (default 7). */
	agingThresholdDays?: number;
}

/** Matches the dated log entries `appendTopicNote` writes: `- **YYYY-MM-DD** — text`. */
const NOTE_ENTRY_REGEX = /^-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s*[—–-]\s*(.+)$/;

/**
 * Build a markdown 1:1 prep agenda for one member from their roll-up — the member's full
 * topic picture at sit-down time: what they're driving, what's blocked/flagged, what's at
 * schedule risk, what's been sitting in In Progress, who they're waiting on, what they
 * finished since the last 1:1, and the dated notes logged on their topics since then.
 * Returns '' when nothing is notable.
 */
export async function buildOneOnOneAgenda(m: MemberRollup, opts: OneOnOneAgendaOptions = {}): Promise<string> {
	const todayIso = formatDateISO(new Date());
	const sinceIso = opts.sinceIso ?? isoDaysAgo(14);
	const agingDays = opts.agingThresholdDays ?? 7;
	const blockedPaths = new Set(m.blockedTopics.map(t => t.filePath));
	const lines: string[] = [];

	const driving = [
		...m.drivingTopics.map(t => `- ${t.title}`),
		...m.drivingJira.map(i => `- ${i.key} — ${i.summary}`),
	];
	if (driving.length > 0) lines.push('**Currently driving**', ...driving, '');

	const blocked = [
		...m.blockedTopics.map(t => `- ${t.title}${t.blocked ? '' : ' (dependency)'}`),
		...m.jiraIssues.filter(i => i.flagged && i.statusCategory !== 'done').map(i => `- ${i.key} — ${i.summary}`),
	];
	if (blocked.length > 0) lines.push('**Blocked / flagged**', ...blocked, '');

	const atRisk = m.topics
		.map(t => ({ t, risk: deriveTopicRisk(t, blockedPaths.has(t.filePath)) }))
		.filter(x => x.risk.atRisk)
		.map(x => `- ${x.t.title} — ${x.risk.reasons.join('; ')}`);
	if (atRisk.length > 0) lines.push('**At risk**', ...atRisk, '');

	const aging = m.drivingTopics
		.map(t => ({ t, days: t.statusSince ? daysBetween(t.statusSince, todayIso) : null }))
		.filter(x => x.days !== null && x.days >= agingDays)
		.map(x => `- ${x.t.title} — in progress ${x.days}d`);
	if (aging.length > 0) lines.push('**Sitting in In Progress**', ...aging, '');

	const waiting = m.topics
		.filter(t => t.status !== 'done' && t.waitingOn)
		.map(t => `- ${t.title} (waiting on ${t.waitingOn})`);
	if (waiting.length > 0) lines.push('**Waiting on**', ...waiting, '');

	const doneSince = m.topics
		.filter(t => t.status === 'done' && t.doneAt && t.doneAt >= sinceIso)
		.map(t => `- ${t.title} (done ${t.doneAt})`);
	if (doneSince.length > 0) lines.push(`**Done since ${sinceIso}**`, ...doneSince, '');

	if (opts.vault) {
		const notes = await collectRecentTopicNotes(opts.vault, m.topics, sinceIso);
		if (notes.length > 0) {
			lines.push(`**Notes logged since ${sinceIso}**`, ...notes.map(n => `- ${n.topic}: (${n.date}) ${n.text}`), '');
		}
	}

	return lines.join('\n').trim();
}

/** Extract dated `## Notes` log entries (`- **YYYY-MM-DD** — text`) newer than `sinceIso`
 *  from each topic's file body. Newest first, capped at 12 so a chatty week doesn't
 *  swallow the agenda. Unreadable files are skipped silently. */
async function collectRecentTopicNotes(
	vault: Vault,
	topics: SprintTopic[],
	sinceIso: string,
): Promise<Array<{ topic: string; date: string; text: string }>> {
	const out: Array<{ topic: string; date: string; text: string }> = [];
	for (const t of topics) {
		const file = vault.getAbstractFileByPath(t.filePath);
		if (!(file instanceof TFile)) continue;
		let content: string;
		try {
			content = await vault.cachedRead(file);
		} catch {
			continue;
		}
		let inNotes = false;
		for (const line of content.split('\n')) {
			if (/^##\s+Notes\s*$/i.test(line)) { inNotes = true; continue; }
			if (inNotes && /^##\s+/.test(line)) break;
			if (!inNotes) continue;
			const match = line.trim().match(NOTE_ENTRY_REGEX);
			if (match && match[1] >= sinceIso) {
				out.push({ topic: t.title, date: match[1], text: match[2].trim() });
			}
		}
	}
	out.sort((a, b) => b.date.localeCompare(a.date));
	return out.slice(0, 12);
}

/** Local ISO date N days ago (fallback window when a member has no prior 1:1). */
function isoDaysAgo(n: number): string {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	d.setDate(d.getDate() - n);
	return formatDateISO(d);
}
