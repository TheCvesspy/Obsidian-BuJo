import { PluginSettings, SprintTopic } from '../types';
import { isTopicSnoozed } from '../services/topicStatus';

export interface MemberTopicLoad {
	/** Committed topics: open + in-progress, snoozed excluded. */
	load: number;
	/** Effective capacity target (targetConcurrentItems × availability). 0 = unknown. */
	target: number;
	/** True when the load exceeds a known target. */
	over: boolean;
}

/**
 * Committed topic load per member email (lowercased key). Load = open + in-progress
 * topics, snoozed excluded — deliberately parked work shouldn't count against capacity.
 * Target = per-member `targetConcurrentItems` (fallback `defaultTargetConcurrentItems`,
 * default 5) scaled by `availabilityPercent` — the same math as the team roll-up's
 * LoadSignal, so the numbers agree across surfaces. Assignees missing from the team
 * roster still get a load entry with target 0 (shown without a capacity judgment).
 */
export function buildTopicLoadIndex(topics: SprintTopic[], settings: PluginSettings): Map<string, MemberTopicLoad> {
	const counts = new Map<string, number>();
	for (const t of topics) {
		if (!t.assignee) continue;
		if (t.status !== 'open' && t.status !== 'in-progress') continue;
		if (isTopicSnoozed(t)) continue;
		const key = t.assignee.toLowerCase();
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	const out = new Map<string, MemberTopicLoad>();
	for (const m of settings.teamMembers ?? []) {
		if (!m.email) continue;
		const key = m.email.toLowerCase();
		const load = counts.get(key) ?? 0;
		const base = m.targetConcurrentItems ?? settings.defaultTargetConcurrentItems ?? 5;
		const target = Math.round(base * ((m.availabilityPercent ?? 100) / 100) * 10) / 10;
		out.set(key, { load, target, over: target > 0 && load > target });
	}
	for (const [key, load] of counts) {
		if (!out.has(key)) out.set(key, { load, target: 0, over: false });
	}
	return out;
}

/** "3/5" when a target is known, plain "3" otherwise. */
export function formatTopicLoad(l: MemberTopicLoad): string {
	return l.target > 0 ? `${l.load}/${l.target}` : String(l.load);
}
