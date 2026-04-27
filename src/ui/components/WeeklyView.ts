import { TaskItem, TaskStatus, PluginSettings } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { TaskItemRow, TaskItemRowCallbacks } from './TaskItemRow';
import { getWeekDays, formatDateDisplay, isToday } from '../../utils/dateUtils';


export class WeeklyView {
	private el: HTMLElement;
	private collapsedTasks: Set<string> = new Set();
	private hierarchyCallbacks: TaskItemRowCallbacks;

	constructor(
		private container: HTMLElement,
		private store: TaskStore,
		private settings: PluginSettings,
		private callbacks: TaskItemRowCallbacks,
		private searchQuery: string = ''
	) {
		this.el = container.createDiv({ cls: 'friday-weekly-view' });
		this.hierarchyCallbacks = {
			...callbacks,
			getTaskById: (id: string) => store.getTaskById(id),
			onToggleCollapse: (taskId: string) => {
				if (this.collapsedTasks.has(taskId)) {
					this.collapsedTasks.delete(taskId);
				} else {
					this.collapsedTasks.add(taskId);
				}
				this.render();
			},
		};
	}

	render(): void {
		this.el.empty();
		const days = getWeekDays(new Date());
		const now = new Date();

		// Header
		const header = this.el.createDiv({ cls: 'friday-view-header' });
		header.createSpan({ text: `Weekly Log — Week of ${formatDateDisplay(days[0])}` });

		// Fetch all tasks for the week range once, then bucket by day
		const weekEnd = new Date(days[6]);
		weekEnd.setHours(23, 59, 59, 999);
		const allWeekTasks = this.store.getTasksForDateRange(days[0], weekEnd);
		let filtered = this.store.filterCompleted(allWeekTasks, this.settings.showCompletedTasks);
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			filtered = filtered.filter(t => t.text.toLowerCase().includes(q));
		}

		// Bucket by day
		const byDay = new Map<string, TaskItem[]>();
		for (const t of filtered) {
			if (!t.dueDate) continue;
			const key = t.dueDate.toDateString();
			if (!byDay.has(key)) byDay.set(key, []);
			byDay.get(key)!.push(t);
		}

		for (const day of days) {
			const daySection = this.el.createDiv({ cls: 'friday-week-day' });

			// Day header
			const dayHeader = daySection.createDiv({ cls: 'friday-day-header' });
			dayHeader.createSpan({ text: formatDateDisplay(day) });
			if (isToday(day, now)) {
				dayHeader.createSpan({ cls: 'friday-today-badge', text: '(Today)' });
			}

			const dayTasks = byDay.get(day.toDateString()) ?? [];

			if (dayTasks.length === 0) {
				daySection.createDiv({ cls: 'friday-muted', text: 'No tasks' });
				continue;
			}

			const doneCount = dayTasks.filter(t => t.status === TaskStatus.Done).length;
			const total = dayTasks.length;
			const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

			// Count + progress bar
			const progressRow = daySection.createDiv({ cls: 'friday-progress-row' });
			progressRow.createSpan({ cls: 'friday-day-count', text: `${doneCount}/${total} done` });
			const barOuter = progressRow.createDiv({ cls: 'friday-progress-bar' });
			const barInner = barOuter.createDiv({ cls: 'friday-progress-fill' });
			barInner.style.width = `${pct}%`;

			// Task rows (tree-aware)
			const taskContainer = daySection.createDiv({ cls: 'friday-day-tasks' });
			for (const task of dayTasks) {
				this.renderTaskTree(taskContainer, task);
			}
		}
	}

	private renderTaskTree(container: HTMLElement, task: TaskItem): void {
		const isCollapsed = this.collapsedTasks.has(task.id);
		new TaskItemRow(container, task, this.hierarchyCallbacks, isCollapsed);

		if (task.childrenIds.length > 0 && !isCollapsed) {
			for (const childId of task.childrenIds) {
				const child = this.store.getTaskById(childId);
				if (child) {
					this.renderTaskTree(container, child);
				}
			}
		}
	}

	destroy(): void {
		this.el.empty();
	}
}
