import { SprintTopic } from '../types';

export interface TopicIndex {
	byPath: Map<string, SprintTopic>;
	/** Topics that block `t` (resolved from t.blockedBy; unresolved/stale paths dropped). */
	blockersOf: (t: SprintTopic) => SprintTopic[];
	/** Topics that `t` blocks (the inverse edges). */
	blocks: (t: SprintTopic) => SprintTopic[];
}

/** Build forward + inverse dependency adjacency over a set of topics. */
export function buildTopicIndex(topics: SprintTopic[]): TopicIndex {
	const byPath = new Map<string, SprintTopic>();
	for (const t of topics) byPath.set(t.filePath, t);

	// Inverse adjacency: blockerPath → topics that list it in blockedBy.
	const blocksMap = new Map<string, SprintTopic[]>();
	for (const t of topics) {
		for (const dep of t.blockedBy) {
			const arr = blocksMap.get(dep) ?? [];
			arr.push(t);
			blocksMap.set(dep, arr);
		}
	}

	return {
		byPath,
		blockersOf: (t) =>
			t.blockedBy.map(p => byPath.get(p)).filter((x): x is SprintTopic => !!x),
		blocks: (t) => blocksMap.get(t.filePath) ?? [],
	};
}

/**
 * Longest chain of not-done topics following blockedBy edges — the critical path through
 * the open work. Returns the file paths on that chain, ordered blocker → blocked. Empty
 * when there's no chain of length ≥ 2. Cycle-safe.
 */
export function criticalPath(topics: SprintTopic[]): string[] {
	const idx = buildTopicIndex(topics);
	const active = topics.filter(t => t.status !== 'done');
	const memo = new Map<string, string[]>();
	const visiting = new Set<string>();

	// Longest path ending at `t`, walking backward over its (not-done) blockers.
	const longestTo = (t: SprintTopic): string[] => {
		const cached = memo.get(t.filePath);
		if (cached) return cached;
		if (visiting.has(t.filePath)) return []; // cycle guard — a back-edge contributes nothing (avoids duplicate nodes in the returned path)
		visiting.add(t.filePath);
		let best: string[] = [];
		for (const b of idx.blockersOf(t)) {
			if (b.status === 'done') continue;
			const chain = longestTo(b);
			if (chain.length > best.length) best = chain;
		}
		visiting.delete(t.filePath);
		const result = [...best, t.filePath];
		memo.set(t.filePath, result);
		return result;
	};

	let longest: string[] = [];
	for (const t of active) {
		const chain = longestTo(t);
		if (chain.length > longest.length) longest = chain;
	}
	return longest.length > 1 ? longest : [];
}
