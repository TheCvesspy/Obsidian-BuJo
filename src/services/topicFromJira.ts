import { JiraIssueInfo, SprintTopic, TeamMember } from '../types';
import { SprintTopicService } from './sprintTopicService';
import { JiraService, mapJiraPriority } from './jiraService';

/** Resolve a JIRA assignee to a topic assignee value (an email). Prefers the JIRA-provided
 *  email (when the tenant exposes it); otherwise matches the display name against a team
 *  member's full name or nickname (case-insensitive). Returns null when nothing maps —
 *  the topic is then left unassigned rather than guessing. */
export function resolveAssigneeEmail(info: JiraIssueInfo, members: TeamMember[]): string | null {
	if (info.assigneeEmail && info.assigneeEmail.trim()) return info.assigneeEmail.trim();
	if (info.assignee) {
		const dn = info.assignee.trim().toLowerCase();
		const m = members.find(x =>
			(x.fullName && x.fullName.trim().toLowerCase() === dn) ||
			(x.nickname && x.nickname.trim().toLowerCase() === dn));
		if (m) return m.email;
	}
	return null;
}

export interface JiraTopicContext {
	/** Team roster — used to map the JIRA assignee to a topic assignee email. */
	teamMembers: TeamMember[];
	/** Today as ISO YYYY-MM-DD — used to seed the roadmap start date. */
	todayIso: string;
}

/**
 * Create a Kanban topic from a fetched JIRA issue, filling:
 *   - title ← summary, `jira` ← key (the link)
 *   - priority ← mapped JIRA priority, dueDate ← JIRA due date
 *   - startDate ← today when the issue has a (future) due date, so it draws a real bar on the
 *     Roadmap (today → due). When the due date is already past, start = due (a point marker).
 *   - assignee ← resolved team member, Notes ← the issue description
 *
 * The topic lands in Backlog (the normal create path); the caller can move it afterward.
 * Blocked-by dependencies are NOT wired here — that's the "Sync dependencies from JIRA"
 * command's job, which can resolve links across all topics at once (a blocker rarely has a
 * topic at the moment its dependent is first imported).
 */
export async function createTopicFromJiraInfo(
	svc: SprintTopicService,
	info: JiraIssueInfo,
	ctx: JiraTopicContext,
): Promise<SprintTopic> {
	const startDate = info.dueDate
		? (info.dueDate >= ctx.todayIso ? ctx.todayIso : info.dueDate)
		: null;
	const assignee = resolveAssigneeEmail(info, ctx.teamMembers);

	return svc.createTopic(
		info.summary || info.key,
		info.key,
		mapJiraPriority(info.priority),
		[],            // linkedPages
		null,          // impact
		null,          // effort
		info.dueDate,  // dueDate (roadmap bar end)
		assignee,
		null,          // waitingOn
		null,          // lastNudged
		[],            // refs
		startDate,     // roadmap bar start
		info.description, // ## Notes body
	);
}

export interface DependencySyncResult {
	/** Topics examined (those linked to at least one JIRA issue). */
	scanned: number;
	/** New blocked-by dependencies wired. */
	added: number;
	/** addDependency rejections (cycle / self / invalid). */
	rejected: number;
}

/**
 * Wire topic blocked-by dependencies from JIRA across the whole board. For every topic linked
 * to a JIRA issue, read that issue's "is blocked by" links and add a topic dependency wherever
 * the blocking issue is *also* linked to a topic. Existing links and rejected ones (self/cycle)
 * are skipped. Idempotent — re-running only adds what's newly resolvable.
 *
 * Shared by the "Sync topic dependencies from JIRA" command and the `topic_sync_dependencies`
 * MCP tool so the two never drift.
 */
export async function syncTopicDependenciesFromJira(
	svc: SprintTopicService,
	jira: JiraService,
	allTopics: SprintTopic[],
): Promise<DependencySyncResult> {
	// key → topic file paths (a topic may carry several keys; a key may map to several topics).
	const topicsByKey = new Map<string, string[]>();
	for (const t of allTopics) {
		for (const k of t.jira) {
			const arr = topicsByKey.get(k) ?? [];
			arr.push(t.filePath);
			topicsByKey.set(k, arr);
		}
	}

	const linked = allTopics.filter(t => t.jira.length > 0);
	let added = 0;
	let rejected = 0;
	for (const t of linked) {
		const blockerKeys = new Set<string>();
		for (const k of t.jira) {
			const info = await jira.ensureFetched(k);
			if (!info) continue;
			for (const link of info.blockingLinks) blockerKeys.add(link.key);
		}
		for (const bk of blockerKeys) {
			for (const blockerPath of topicsByKey.get(bk) ?? []) {
				if (blockerPath === t.filePath || t.blockedBy.includes(blockerPath)) continue;
				const res = await svc.addDependency(t.filePath, blockerPath);
				if (res.ok) added++; else rejected++;
			}
		}
	}
	return { scanned: linked.length, added, rejected };
}
