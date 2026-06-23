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
import { TeamMemberService } from './teamMemberService';
import { JiraTeamService } from './jiraTeamService';
import { bucketIssuesByMember } from '../utils/teamBucket';
import { buildTopicIndex } from './topicGraph';
import { deriveTopicBlock } from './topicStatus';
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
			const jiraBlocked = jissues.filter(i => i.flagged).length;
			const jiraInProgress = jissues.filter(i => !i.flagged && i.statusCategory === 'indeterminate').length;
			const jiraOpen = jissues.filter(i => !i.flagged && i.statusCategory !== 'indeterminate' && i.statusCategory !== 'done').length;
			const jiraDone = jissues.filter(i => i.statusCategory === 'done').length;

			const memberTopics = topics.filter(t => t.assignee && t.assignee.toLowerCase() === email.toLowerCase());
			const topicsOpen = memberTopics.filter(t => t.status === 'open').length;
			const topicsInProgress = memberTopics.filter(t => t.status === 'in-progress').length;
			const topicsDone = memberTopics.filter(t => t.status === 'done').length;
			const topicsBlocked = memberTopics.filter(t => t.status !== 'done' && isTopicBlocked(t)).length;

			const counts: WorkloadCounts = {
				jiraBlocked, jiraInProgress, jiraOpen, jiraDone,
				topicsBlocked, topicsInProgress, topicsOpen, topicsDone,
			};

			// Committed = everything not-done across both sources (backlog topics excluded).
			const committed = jiraBlocked + jiraInProgress + jiraOpen + topicsOpen + topicsInProgress;
			const target = m.targetConcurrentItems ?? s.defaultTargetConcurrentItems ?? 5;
			const avail = m.availabilityPercent ?? 100;
			const effectiveTarget = target * (avail / 100);
			const ratio = effectiveTarget > 0 ? committed / effectiveTarget : null;
			let band: LoadSignal['band'];
			if (avail <= 0 || effectiveTarget <= 0) band = 'out';
			else if (ratio === null) band = 'balanced';
			else if (ratio <= 0.5) band = 'light';
			else if (ratio <= 1.0) band = 'balanced';
			else if (ratio <= 1.5) band = 'heavy';
			else band = 'overloaded';
			const load: LoadSignal = { committed, target: effectiveTarget, ratio, band };

			const page = pages.find(p => p.email && p.email.toLowerCase() === email.toLowerCase());
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
				onLeave: page?.status === 'on_leave',
				cadenceState,
				cadenceDays,
				drivingJira: jissues.filter(i => i.statusCategory === 'indeterminate'),
				drivingTopics: memberTopics.filter(t => t.status === 'in-progress'),
				jiraIssues: jissues,
				topics: memberTopics,
				counts,
				load,
			});
		}

		// ── Top blockers ──
		const topBlockers: BlockerEntry[] = [];
		for (const issue of issues) {
			if (issue.flagged) {
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

/** Build a markdown 1:1 prep agenda for one member from their roll-up: what they're driving,
 *  what's blocked/flagged, and who they're waiting on. Returns '' when nothing notable. */
export function buildOneOnOneAgenda(m: MemberRollup): string {
	const lines: string[] = [];
	const driving = [
		...m.drivingTopics.map(t => `- ${t.title}`),
		...m.drivingJira.map(i => `- ${i.key} — ${i.summary}`),
	];
	if (driving.length > 0) lines.push('**Currently driving**', ...driving, '');

	const blocked = [
		...m.topics.filter(t => t.status !== 'done' && t.blocked).map(t => `- ${t.title}`),
		...m.jiraIssues.filter(i => i.flagged).map(i => `- ${i.key} — ${i.summary}`),
	];
	if (blocked.length > 0) lines.push('**Blocked / flagged**', ...blocked, '');

	const waiting = m.topics
		.filter(t => t.status !== 'done' && t.waitingOn)
		.map(t => `- ${t.title} (waiting on ${t.waitingOn})`);
	if (waiting.length > 0) lines.push('**Waiting on**', ...waiting, '');

	return lines.join('\n').trim();
}
