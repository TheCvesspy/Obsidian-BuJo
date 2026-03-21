import { TaskItem, TaskStatus, PluginSettings, GroupMode } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { TaskItemRowCallbacks } from './TaskItemRow';
import { TaskList } from './TaskList';
import { formatDateDisplay, todayStart } from '../../utils/dateUtils';

export class DailyView {
	private el: HTMLElement;

	constructor(
		private container: HTMLElement,
		private store: TaskStore,
		private settings: PluginSettings,
		private callbacks: TaskItemRowCallbacks,
		private searchQuery: string = ''
	) {
		this.el = container.createDiv({ cls: 'task-bujo-daily-view' });
	}

	render(): void {
		this.el.empty();
		const today = todayStart();
		const todayStr = today.toDateString();
		const storeTasks = this.store.getTasks();
		let tasks = this.store.filterCompleted(storeTasks, this.settings.showCompletedTasks);

		// Apply search
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			tasks = tasks.filter(t => t.text.toLowerCase().includes(q));
		}

		// Single-pass bucketing
		const overdue: TaskItem[] = [];
		const carriedOver: TaskItem[] = [];
		const dueToday: TaskItem[] = [];
		const unscheduled: TaskItem[] = [];
		let pendingCount = 0;

		// Today's daily note path — tasks here with migratedFrom are "carried over"
		const todayDailyPath = this.settings.dailyNotePath
			? `${this.settings.dailyNotePath}/${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.md`
			: null;

		for (const t of tasks) {
			if (t.status === TaskStatus.Open && t.dueDate && t.dueDate < today) {
				// Past due date — overdue
				overdue.push(t);
				pendingCount++;
			} else if (t.migratedFrom && todayDailyPath && t.sourcePath === todayDailyPath && t.status === TaskStatus.Open) {
				// Migrated into today's daily note
				carriedOver.push(t);
				pendingCount++;
			} else if (t.dueDate && t.dueDate.toDateString() === todayStr) {
				dueToday.push(t);
				if (t.status === TaskStatus.Open) pendingCount++;
			} else if (t.status === TaskStatus.Open && !t.dueDate) {
				unscheduled.push(t);
				pendingCount++;
			}
		}

		// Header
		const header = this.el.createDiv({ cls: 'task-bujo-view-header' });
		header.createSpan({ text: `Daily Log — ${formatDateDisplay(today)}` });
		header.createSpan({ cls: 'task-bujo-pending-count', text: ` (${pendingCount} pending)` });

		// Sections
		const sections: [string, TaskItem[]][] = [
			['Overdue', overdue],
			['Carried Over', carriedOver],
			['Due Today', dueToday],
			['Unscheduled', unscheduled],
		];

		for (const [label, items] of sections) {
			const sectionEl = this.el.createDiv({ cls: 'task-bujo-section' });
			sectionEl.createEl('h4', { cls: 'task-bujo-section-header', text: label });
			if (items.length === 0) {
				sectionEl.createDiv({ cls: 'task-bujo-muted', text: 'No tasks' });
			} else {
				const grouped = new Map<string, TaskItem[]>();
				grouped.set(label, items);
				new TaskList(sectionEl, grouped, this.callbacks, false, undefined, storeTasks);
			}
		}
	}

	destroy(): void {
		this.el.empty();
	}
}
