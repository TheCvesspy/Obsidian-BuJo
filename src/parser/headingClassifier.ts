import { ItemCategory } from '../types';

export class HeadingClassifier {
	private taskHeadings: string[];
	private openPointHeadings: string[];
	private inboxHeadings: string[];

	constructor(taskHeadings: string[], openPointHeadings: string[], inboxHeadings: string[] = []) {
		this.taskHeadings = taskHeadings.map(h => h.toLowerCase());
		this.openPointHeadings = openPointHeadings.map(h => h.toLowerCase());
		this.inboxHeadings = inboxHeadings.map(h => h.toLowerCase());
	}

	classify(headingText: string | null, inlineTypeTag: string | null): ItemCategory {
		// Priority 1: inline tag override
		if (inlineTypeTag) {
			const tag = inlineTypeTag.toLowerCase();
			if (tag === 'task') return ItemCategory.Task;
			if (tag === 'openpoint') return ItemCategory.OpenPoint;
			if (tag === 'inbox') return ItemCategory.Inbox;
		}

		// Priority 2: heading context match (case-insensitive, substring).
		// Inbox checked first so "## Inbox" wins if a daily note has both Inbox + Tasks.
		if (headingText) {
			const lower = headingText.toLowerCase();
			for (const h of this.inboxHeadings) {
				if (lower.includes(h)) return ItemCategory.Inbox;
			}
			for (const h of this.taskHeadings) {
				if (lower.includes(h)) return ItemCategory.Task;
			}
			for (const h of this.openPointHeadings) {
				if (lower.includes(h)) return ItemCategory.OpenPoint;
			}
		}

		// Priority 3: fallback
		return ItemCategory.Uncategorized;
	}
}
