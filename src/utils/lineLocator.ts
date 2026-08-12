import { TaskItem } from '../types';

/** Locate a task's line in freshly-read content.
 *
 *  Strategy:
 *  1. Recorded lineNumber, when rawLine still matches there (O(1) fast path).
 *  2. Otherwise, among ALL unclaimed lines exactly equal to rawLine, the one
 *     nearest the recorded lineNumber. Stale line numbers come from lines being
 *     inserted/deleted nearby, so the nearest occurrence is almost always the
 *     right physical line — a plain first-match indexOf would silently mutate
 *     the wrong task when two identical lines exist.
 *
 *  Returns -1 when the task can't be found (file edited since scan).
 *  `usedIndices`, when passed by a batch caller, holds indices already claimed
 *  by sibling tasks so duplicate rawLines resolve to distinct physical lines. */
export function locateTaskLine(task: TaskItem, lines: string[], usedIndices?: Set<number>): number {
	if (
		task.lineNumber >= 0 &&
		task.lineNumber < lines.length &&
		lines[task.lineNumber] === task.rawLine &&
		!usedIndices?.has(task.lineNumber)
	) {
		return task.lineNumber;
	}

	let best = -1;
	let bestDistance = Number.MAX_SAFE_INTEGER;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] !== task.rawLine || usedIndices?.has(i)) continue;
		const distance = Math.abs(i - task.lineNumber);
		if (distance < bestDistance) {
			best = i;
			bestDistance = distance;
		}
	}
	return best;
}
