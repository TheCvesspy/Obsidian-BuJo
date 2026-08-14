import { SprintTopic } from '../types';

export type DerivedState = 'clear' | 'at-risk' | 'blocked';

export interface DerivedBlock {
	state: DerivedState;
	/** Human-readable reasons, e.g. ["PROJ-12 flagged in JIRA", "Blocked by: Topic A"]. */
	reasons: string[];
	/** Which signals contributed to a blocked state. */
	sources: { manual: boolean; jira: boolean; deps: boolean };
}

/** The JIRA-derived blocking signal for a single linked issue. */
export interface JiraBlockSignal {
	flagged: boolean;
	/** Keys of "is blocked by" issues that are NOT yet done. */
	blockedByOpen: string[];
}

export interface DeriveInput {
	topic: SprintTopic;
	/** Resolve the topics that block `topic` (via topic dependencies). Stub returns [] until T2. */
	blockersOf: (t: SprintTopic) => SprintTopic[];
	/** Per-key JIRA signal. `undefined` when the JIRA module is disabled — JIRA rules are skipped. */
	jiraSignal?: (key: string) => JiraBlockSignal | null;
}

/**
 * Derive a topic's block state from three independent signals, unified:
 *   - manual `blocked` frontmatter flag
 *   - a linked JIRA issue that is flagged, or has an open "is blocked by" link
 *   - a blocking topic (dependency) that isn't done
 * v1 only distinguishes `blocked` vs `clear`; `at-risk` is reserved for later.
 */
export function deriveTopicBlock(input: DeriveInput): DerivedBlock {
	const { topic, blockersOf, jiraSignal } = input;
	const reasons: string[] = [];
	const sources = { manual: false, jira: false, deps: false };

	if (topic.blocked) {
		sources.manual = true;
		reasons.push('Manually blocked');
	}

	if (jiraSignal) {
		for (const key of topic.jira) {
			const sig = jiraSignal(key);
			if (!sig) continue;
			if (sig.flagged) {
				sources.jira = true;
				reasons.push(`${key} flagged in JIRA`);
			}
			if (sig.blockedByOpen.length > 0) {
				sources.jira = true;
				reasons.push(`${key} blocked by ${sig.blockedByOpen.join(', ')}`);
			}
		}
	}

	const openBlockers = blockersOf(topic).filter(b => b.status !== 'done');
	if (openBlockers.length > 0) {
		sources.deps = true;
		reasons.push(`Blocked by: ${openBlockers.map(b => b.title).join(', ')}`);
	}

	const state: DerivedState =
		sources.manual || sources.jira || sources.deps ? 'blocked' : 'clear';
	return { state, reasons, sources };
}

/** Today as a local ISO date (YYYY-MM-DD). String comparison works for ISO dates. */
function localTodayIso(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** True while a topic's snooze is active: `snoozedUntil` is set and still in the future.
 *  The topic wakes ON the stored date (mirrors task `@snooze` semantics). Done topics are
 *  never considered snoozed — a leftover snooze on finished work is meaningless. */
export function isTopicSnoozed(topic: SprintTopic): boolean {
	if (!topic.snoozedUntil || topic.status === 'done') return false;
	return topic.snoozedUntil > localTodayIso();
}

export interface TopicRisk {
	atRisk: boolean;
	/** Human-readable reasons, e.g. ["Due in 3d but not started"]. Empty when clear. */
	reasons: string[];
}

/** How far ahead a due date counts as "approaching" for risk purposes. Wider than the
 *  task-level urgencyThresholdDays (default 2) — topics are initiatives, and a lead needs
 *  more than two days of warning to unblock or re-plan one. */
const RISK_WINDOW_DAYS = 7;

/**
 * Derive a topic's schedule risk — the early-warning band BEFORE work is simply overdue.
 * All rules are due-date-driven (no due date = no schedule to be at risk against):
 *   - overdue and not done
 *   - due within RISK_WINDOW_DAYS but not started (backlog / To Do)
 *   - due within the window with task progress under 50%
 *   - due within the window while blocked (caller supplies the derived block state)
 * Done topics are never at risk; snoozed topics are deliberately parked, so they don't nag.
 */
export function deriveTopicRisk(topic: SprintTopic, isBlocked: boolean): TopicRisk {
	const reasons: string[] = [];
	if (topic.status === 'done' || isTopicSnoozed(topic) || !topic.dueDate) {
		return { atRisk: false, reasons };
	}
	const due = new Date(topic.dueDate + 'T00:00:00').getTime();
	if (isNaN(due)) return { atRisk: false, reasons };
	const today = new Date(localTodayIso() + 'T00:00:00').getTime();
	const days = Math.round((due - today) / 86400000);
	const dueLabel = days === 0 ? 'due today' : `due in ${days}d`;

	if (days < 0) {
		reasons.push(`Overdue by ${-days}d`);
	} else if (days <= RISK_WINDOW_DAYS) {
		if (topic.status === 'backlog' || topic.status === 'open') {
			reasons.push(`${dueLabel[0].toUpperCase()}${dueLabel.slice(1)} but not started`);
		}
		if (topic.taskTotal > 0 && topic.taskDone / topic.taskTotal < 0.5) {
			reasons.push(`Tasks at ${topic.taskDone}/${topic.taskTotal} and ${dueLabel}`);
		}
		if (isBlocked) {
			reasons.push(`Blocked and ${dueLabel}`);
		}
	}
	return { atRisk: reasons.length > 0, reasons };
}

/** Adapt a cached JiraIssueInfo-shaped object into the signal the derivation consumes.
 *  Returns null when the issue isn't cached yet (transient — contributes nothing). */
export function toJiraSignal(
	info: { flagged: boolean; blockingLinks: Array<{ key: string; done: boolean }> } | null,
): JiraBlockSignal | null {
	if (!info) return null;
	return {
		flagged: info.flagged,
		blockedByOpen: info.blockingLinks.filter(l => !l.done).map(l => l.key),
	};
}
