import { TaskItem, TaskStatus, Priority, ItemCategory } from '../types';
import { CHECKBOX_REGEX, HEADING_REGEX, PRIORITY_TAG_REGEX, TYPE_TAG_REGEX, DUE_DATE_REGEX, MIGRATED_FROM_REGEX, WORK_TYPE_REGEX, PURPOSE_REGEX, EFFORT_REGEX } from '../constants';
import { HeadingClassifier } from './headingClassifier';
import { parseDueDate } from './dateParser';
import { TagCategory } from '../types';

const STATUS_MAP: Record<string, TaskStatus> = {
	' ': TaskStatus.Open,
	'x': TaskStatus.Done,
	'X': TaskStatus.Done,
	'>': TaskStatus.Migrated,
	'<': TaskStatus.Scheduled,
	'!': TaskStatus.Open,  // treat '!' as open
	'-': TaskStatus.Cancelled,
};

/** Compute indentation level from leading whitespace. Tabs = 1 level each, spaces = floor(count/4). */
function computeIndentLevel(whitespace: string): number {
	let level = 0;
	for (const ch of whitespace) {
		if (ch === '\t') level++;
		else level += 0.25; // 4 spaces = 1 level
	}
	return Math.floor(level);
}

/**
 * Build parent-child relationships from indentation levels.
 * Tasks must be in file-line order within a single heading context.
 */
function buildHierarchy(tasks: TaskItem[]): void {
	const stack: TaskItem[] = [];

	for (const task of tasks) {
		// Pop stack until we find a parent at a lower indent level
		while (stack.length > 0 && stack[stack.length - 1].indentLevel >= task.indentLevel) {
			stack.pop();
		}

		if (stack.length > 0) {
			const parent = stack[stack.length - 1];
			task.parentId = parent.id;
			parent.childrenIds.push(task.id);
		}

		stack.push(task);
	}
}

export function parseTasksFromContent(
	content: string,
	sourcePath: string,
	classifier: HeadingClassifier,
	workTypes?: TagCategory[],
	purposes?: TagCategory[],
): TaskItem[] {
	const lines = content.split('\n');
	const tasks: TaskItem[] = [];

	// Heading tracking for nested classification
	let categoryHeading: string | null = null;  // The heading text that defined the active category
	let categoryLevel = 0;                       // The heading level (number of #s) that set the category
	let activeCategory: ItemCategory | null = null;
	let currentSubHeading: string | null = null; // Immediate sub-heading text (deeper than category level)

	// Track tasks per heading context for hierarchy building
	let currentHeadingTasks: TaskItem[] = [];
	// Track the last parsed task for description collection
	let lastTask: TaskItem | null = null;
	let lastTaskIndentChars = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Check for heading
		const headingMatch = line.match(HEADING_REGEX);
		if (headingMatch) {
			lastTask = null;
			// Build hierarchy for tasks accumulated under the previous heading
			if (currentHeadingTasks.length > 0) {
				buildHierarchy(currentHeadingTasks);
				currentHeadingTasks = [];
			}

			const level = headingMatch[1].length; // number of # characters
			const headingText = headingMatch[2].trim();
			const classified = classifier.classify(headingText, null);

			if (classified !== ItemCategory.Uncategorized) {
				// Heading matches a known category — lock it in
				activeCategory = classified;
				categoryLevel = level;
				categoryHeading = headingText;
				currentSubHeading = null;
			} else if (activeCategory !== null && level > categoryLevel) {
				// Deeper heading under an active category — treat as sub-heading
				currentSubHeading = headingText;
			} else {
				// Same/higher level non-matching heading, or no active category
				// Reset category tracking
				activeCategory = null;
				categoryLevel = 0;
				categoryHeading = headingText;
				currentSubHeading = null;
			}
			continue;
		}

		// Check for checkbox
		const checkboxMatch = line.match(CHECKBOX_REGEX);
		if (!checkboxMatch) {
			// Collect description lines: non-checkbox, non-heading, non-empty lines
			// that are indented deeper than the last task
			if (lastTask && line.trim().length > 0) {
				const leadingWhitespace = line.match(/^(\s*)/)?.[1] || '';
				const lineIndentChars = leadingWhitespace.length;
				if (lineIndentChars > lastTaskIndentChars) {
					if (lastTask.description) {
						lastTask.description += '\n' + line.trim();
					} else {
						lastTask.description = line.trim();
					}
				} else {
					lastTask = null;
				}
			}
			continue;
		}

		const indentLevel = computeIndentLevel(checkboxMatch[1]);
		const statusChar = checkboxMatch[2];
		const status = STATUS_MAP[statusChar] ?? TaskStatus.Open;
		let text = checkboxMatch[3];

		// Extract priority tag
		let priority = Priority.None;
		const priorityMatch = text.match(PRIORITY_TAG_REGEX);
		if (priorityMatch) {
			priority = priorityMatch[1].toLowerCase() as Priority;
			text = text.replace(PRIORITY_TAG_REGEX, '');
		}

		// Extract type tag
		let inlineTypeTag: string | null = null;
		const typeMatch = text.match(TYPE_TAG_REGEX);
		if (typeMatch) {
			inlineTypeTag = typeMatch[1];
			text = text.replace(TYPE_TAG_REGEX, '');
		}

		// Extract due date
		let dueDate: Date | null = null;
		let dueDateRaw: string | null = null;
		const dueMatch = text.match(DUE_DATE_REGEX);
		if (dueMatch) {
			dueDateRaw = dueMatch[1];
			dueDate = parseDueDate(dueDateRaw);
			text = text.replace(DUE_DATE_REGEX, '');
		}

		// Parse migration source annotation: (from [[filename]])
		let migratedFrom: string | null = null;
		const migratedMatch = text.match(MIGRATED_FROM_REGEX);
		if (migratedMatch) {
			migratedFrom = migratedMatch[1];
			text = text.replace(MIGRATED_FROM_REGEX, '');
		}

		// Extract work type tag: #work/name or #w/CODE
		let workType: string | null = null;
		const workTypeMatch = text.match(WORK_TYPE_REGEX);
		if (workTypeMatch) {
			workType = resolveTagCategory(workTypeMatch[1], workTypes || []);
			text = text.replace(WORK_TYPE_REGEX, '');
		}

		// Extract purpose tag: #purpose/name or #p/CODE
		let purpose: string | null = null;
		const purposeMatch = text.match(PURPOSE_REGEX);
		if (purposeMatch) {
			purpose = resolveTagCategory(purposeMatch[1], purposes || []);
			text = text.replace(PURPOSE_REGEX, '');
		}

		// Extract effort tag: #effort/S, #effort/M, #effort/L
		let effort: 'S' | 'M' | 'L' | null = null;
		const effortMatch = text.match(EFFORT_REGEX);
		if (effortMatch) {
			effort = effortMatch[1].toUpperCase() as 'S' | 'M' | 'L';
			text = text.replace(EFFORT_REGEX, '');
		}

		// Clean up display text
		text = text.replace(/\s{2,}/g, ' ').trim();

		// Determine category: inline tag overrides heading-based classification
		let category: ItemCategory;
		if (inlineTypeTag) {
			category = classifier.classify(null, inlineTypeTag);
		} else if (activeCategory !== null) {
			category = activeCategory;
		} else {
			category = classifier.classify(categoryHeading, null);
		}

		const taskItem: TaskItem = {
			id: `${sourcePath}:${i}`,
			text,
			rawLine: line,
			status,
			category,
			priority,
			dueDate,
			dueDateRaw,
			sourcePath,
			lineNumber: i,
			headingContext: categoryHeading,
			subHeading: currentSubHeading,
			migratedTo: null,
			migratedFrom,
			workType,
			purpose,
			effort,
			indentLevel,
			parentId: null,
			childrenIds: [],
			description: null,
		};
		tasks.push(taskItem);
		currentHeadingTasks.push(taskItem);
		lastTask = taskItem;
		lastTaskIndentChars = (checkboxMatch[1] || '').length;
	}

	// Build hierarchy for the last heading context
	if (currentHeadingTasks.length > 0) {
		buildHierarchy(currentHeadingTasks);
	}

	return tasks;
}

/**
 * Resolve a tag value (from inline text) to its canonical name.
 * Matches by name (case-insensitive, spaces removed) or short code (case-insensitive).
 */
function resolveTagCategory(value: string, categories: TagCategory[]): string | null {
	const v = value.toLowerCase().replace(/\s+/g, '');
	for (const cat of categories) {
		if (cat.name.toLowerCase().replace(/\s+/g, '') === v) return cat.name;
		if (cat.shortCode.toLowerCase() === v) return cat.name;
	}
	// If no match, return the raw value capitalized
	return value;
}
