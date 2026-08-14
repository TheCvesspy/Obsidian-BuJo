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

/** True while a topic's snooze is active: `snoozedUntil` is set and still in the future.
 *  The topic wakes ON the stored date (mirrors task `@snooze` semantics). Done topics are
 *  never considered snoozed — a leftover snooze on finished work is meaningless. */
export function isTopicSnoozed(topic: SprintTopic): boolean {
	if (!topic.snoozedUntil || topic.status === 'done') return false;
	const now = new Date();
	const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
	return topic.snoozedUntil > todayIso;
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
