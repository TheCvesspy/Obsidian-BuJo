import { SprintTopic } from '../types';
import { daysBetween, formatDateISO, getWeekId } from '../utils/dateUtils';

export interface AgingTopic {
	topic: SprintTopic;
	daysInColumn: number;
}

export interface FlowMetrics {
	/** Average cycle time in days across topics with both startedAt and doneAt. Null if none. */
	avgCycleTimeDays: number | null;
	/** Number of completed topics that had a measurable cycle time. */
	cycleSampleSize: number;
	/** Throughput: count of topics completed per ISO week, keyed by weekId (WW-YYYY). */
	throughputByWeek: Map<string, number>;
	/** Non-done topics sitting in their current column past the aging threshold, worst first. */
	agingWip: AgingTopic[];
}

/**
 * Compute Kanban flow metrics purely from topic frontmatter timestamps (statusSince /
 * startedAt / doneAt). No I/O. Legacy topics that predate flow-timestamping simply lack
 * the fields and are skipped, so metrics accrue forward from the Kanban migration.
 */
export function computeFlow(
	topics: SprintTopic[],
	now: Date,
	agingThresholdDays: number,
): FlowMetrics {
	const todayIso = formatDateISO(now);

	// Cycle time: startedAt → doneAt for completed topics.
	const cycleTimes: number[] = [];
	for (const t of topics) {
		if (t.status === 'done' && t.startedAt && t.doneAt) {
			const d = daysBetween(t.startedAt, t.doneAt);
			if (d !== null && d >= 0) cycleTimes.push(d);
		}
	}
	const avgCycleTimeDays = cycleTimes.length > 0
		? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length
		: null;

	// Throughput: completed topics bucketed by the ISO week of their doneAt.
	const throughputByWeek = new Map<string, number>();
	for (const t of topics) {
		if (t.status === 'done' && t.doneAt) {
			const wk = getWeekId(new Date(t.doneAt + 'T00:00:00'));
			throughputByWeek.set(wk, (throughputByWeek.get(wk) ?? 0) + 1);
		}
	}

	// Aging WIP: non-done topics whose current column entry is older than the threshold.
	const agingWip: AgingTopic[] = [];
	for (const t of topics) {
		if (t.status === 'done' || !t.statusSince) continue;
		const age = daysBetween(t.statusSince, todayIso);
		if (age !== null && age >= agingThresholdDays) {
			agingWip.push({ topic: t, daysInColumn: age });
		}
	}
	agingWip.sort((a, b) => b.daysInColumn - a.daysInColumn);

	return {
		avgCycleTimeDays,
		cycleSampleSize: cycleTimes.length,
		throughputByWeek,
		agingWip,
	};
}
