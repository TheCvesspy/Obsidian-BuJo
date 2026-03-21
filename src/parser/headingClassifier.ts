import { ItemCategory } from '../types';

export class HeadingClassifier {
	private taskHeadings: string[];
	private openPointHeadings: string[];
	private goalHeadings: string[];

	constructor(taskHeadings: string[], openPointHeadings: string[], goalHeadings: string[] = []) {
		this.taskHeadings = taskHeadings.map(h => h.toLowerCase());
		this.openPointHeadings = openPointHeadings.map(h => h.toLowerCase());
		this.goalHeadings = goalHeadings.map(h => h.toLowerCase());
	}

	classify(headingText: string | null, inlineTypeTag: string | null): ItemCategory {
		// Priority 1: inline tag override
		if (inlineTypeTag) {
			const tag = inlineTypeTag.toLowerCase();
			if (tag === 'task') return ItemCategory.Task;
			if (tag === 'openpoint') return ItemCategory.OpenPoint;
			if (tag === 'goal') return ItemCategory.Goal;
		}

		// Priority 2: heading context match (case-insensitive, substring)
		// Goal headings checked first so "Goals" takes priority over "Tasks" if both match
		if (headingText) {
			const lower = headingText.toLowerCase();
			for (const h of this.goalHeadings) {
				if (lower.includes(h)) return ItemCategory.Goal;
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
