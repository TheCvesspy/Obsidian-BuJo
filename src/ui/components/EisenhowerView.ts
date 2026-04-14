import { TaskItem, PluginSettings, Priority, TaskStatus } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { TaskItemRow, TaskItemRowCallbacks } from './TaskItemRow';


interface Quadrant {
	key: string;
	title: string;
	subtitle: string;
	cls: string;
	tasks: TaskItem[];
}

export class EisenhowerView {
	private el: HTMLElement;

	constructor(
		container: HTMLElement,
		private store: TaskStore,
		private settings: PluginSettings,
		private callbacks: TaskItemRowCallbacks,
		private searchQuery: string,
		private collapsedGroups: Set<string>,
	) {
		this.el = container.createDiv({ cls: 'task-bujo-eisenhower' });
	}

	render(): void {
		this.el.empty();

		// Get open root tasks only
		let tasks = this.store.getTasks().filter(t =>
			t.parentId === null && t.status === TaskStatus.Open
		);

		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			tasks = tasks.filter(t => t.text.toLowerCase().includes(q));
		}

		// Classify into quadrants + unscheduled bucket
		const q1: TaskItem[] = [];
		const q2: TaskItem[] = [];
		const q3: TaskItem[] = [];
		const q4: TaskItem[] = [];
		const unscheduled: TaskItem[] = [];

		for (const task of tasks) {
			if (!task.dueDate) {
				unscheduled.push(task);
				continue;
			}
			const urgent = this.isUrgent(task);
			const important = this.isImportant(task);
			if (urgent && important) q1.push(task);
			else if (!urgent && important) q2.push(task);
			else if (urgent && !important) q3.push(task);
			else q4.push(task);
		}

		const quadrants: Quadrant[] = [
			{ key: 'q1', title: '\u{1F525} Do Now', subtitle: 'Urgent & Important', cls: 'task-bujo-eisenhower-q1', tasks: q1 },
			{ key: 'q2', title: '\u{1F3AF} Plan Deep Work', subtitle: 'Important, Not Urgent', cls: 'task-bujo-eisenhower-q2', tasks: q2 },
			{ key: 'q3', title: '\u{1F91D} Coordinate', subtitle: 'Urgent, Not Important', cls: 'task-bujo-eisenhower-q3', tasks: q3 },
			{ key: 'q4', title: '\u{1F4E6} Batch Later', subtitle: 'Not Urgent, Not Important', cls: 'task-bujo-eisenhower-q4', tasks: q4 },
		];

		// Axis labels
		const axisRow = this.el.createDiv({ cls: 'task-bujo-eisenhower-axis-labels' });
		axisRow.createDiv(); // empty corner
		axisRow.createDiv({ cls: 'task-bujo-eisenhower-axis-label', text: 'Urgent' });
		axisRow.createDiv({ cls: 'task-bujo-eisenhower-axis-label', text: 'Not Urgent' });

		// Grid
		const grid = this.el.createDiv({ cls: 'task-bujo-eisenhower-grid' });

		for (const q of quadrants) {
			this.renderQuadrant(grid, q);
		}

		// Unscheduled tasks box (outside the matrix)
		const unscheduledQuadrant: Quadrant = {
			key: 'unscheduled',
			title: 'Inbox',
			subtitle: 'No due date — needs scheduling',
			cls: 'task-bujo-eisenhower-unscheduled',
			tasks: unscheduled,
		};
		this.renderQuadrant(this.el, unscheduledQuadrant);
	}

	private renderQuadrant(container: HTMLElement, quadrant: Quadrant): void {
		const el = container.createDiv({ cls: `task-bujo-eisenhower-quadrant ${quadrant.cls}` });

		// Header
		const header = el.createDiv({ cls: 'task-bujo-eisenhower-quadrant-header' });
		const titleArea = header.createDiv();
		titleArea.createDiv({ cls: 'task-bujo-eisenhower-quadrant-title', text: quadrant.title });
		titleArea.createDiv({ cls: 'task-bujo-eisenhower-quadrant-subtitle', text: quadrant.subtitle });
		header.createDiv({ cls: 'task-bujo-eisenhower-quadrant-count', text: String(quadrant.tasks.length) });

		// Task list
		const list = el.createDiv({ cls: 'task-bujo-eisenhower-task-list' });

		if (quadrant.tasks.length === 0) {
			list.createDiv({ cls: 'task-bujo-empty', text: 'No tasks' });
			return;
		}

		for (const task of quadrant.tasks) {
			new TaskItemRow(list, task, this.callbacks);
		}
	}

	private isUrgent(task: TaskItem): boolean {
		if (!task.dueDate) return false;
		const now = new Date();
		now.setHours(0, 0, 0, 0);
		const diffMs = task.dueDate.getTime() - now.getTime();
		const diffDays = diffMs / (1000 * 60 * 60 * 24);
		return diffDays <= this.settings.urgencyThresholdDays;
	}

	private isImportant(task: TaskItem): boolean {
		return task.priority === Priority.High || task.priority === Priority.Medium;
	}
}
