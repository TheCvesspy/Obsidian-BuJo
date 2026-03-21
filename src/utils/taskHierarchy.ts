import { TaskItem, TaskStatus, Priority } from '../types';

export interface EffectiveMetadata {
	priority: Priority;
	dueDate: Date | null;
	dueDateRaw: string | null;
	workType: string | null;
	purpose: string | null;
}

/**
 * Resolve effective metadata for a task, inheriting from parent when the
 * child's own value is unset. Does NOT mutate the TaskItem — resolution
 * is read-time only so write-back stays correct.
 */
export function resolveEffectiveMetadata(
	task: TaskItem,
	getParent: (id: string) => TaskItem | undefined
): EffectiveMetadata {
	if (task.parentId === null) {
		return {
			priority: task.priority,
			dueDate: task.dueDate,
			dueDateRaw: task.dueDateRaw,
			workType: task.workType,
			purpose: task.purpose,
		};
	}

	const parent = getParent(task.parentId);
	if (!parent) {
		return {
			priority: task.priority,
			dueDate: task.dueDate,
			dueDateRaw: task.dueDateRaw,
			workType: task.workType,
			purpose: task.purpose,
		};
	}

	// Recursively resolve parent metadata (handles multi-level nesting)
	const parentMeta = resolveEffectiveMetadata(parent, getParent);

	return {
		priority: task.priority !== Priority.None ? task.priority : parentMeta.priority,
		dueDate: task.dueDate ?? parentMeta.dueDate,
		dueDateRaw: task.dueDateRaw ?? parentMeta.dueDateRaw,
		workType: task.workType ?? parentMeta.workType,
		purpose: task.purpose ?? parentMeta.purpose,
	};
}

/** Count completed vs total children for progress display */
export function getChildProgress(
	task: TaskItem,
	getTask: (id: string) => TaskItem | undefined
): { completed: number; total: number } {
	let completed = 0;
	let total = 0;

	const count = (ids: string[]) => {
		for (const id of ids) {
			const child = getTask(id);
			if (!child) continue;
			total++;
			if (child.status === TaskStatus.Done || child.status === TaskStatus.Cancelled) {
				completed++;
			}
			// Count nested children too
			if (child.childrenIds.length > 0) {
				count(child.childrenIds);
			}
		}
	};

	count(task.childrenIds);
	return { completed, total };
}
