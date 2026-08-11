import { TaskItem, PluginSettings } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { TaskItemRowCallbacks } from './TaskItemRow';
import { TaskList } from './TaskList';
import { formatDateDisplay, todayStart } from '../../utils/dateUtils';

/**
 * The daily driver (v3). One flat surface: everything that's due — overdue first, then
 * due today — pulled from every home (Tasks.md, Topics, any page). Snoozed and Someday
 * tasks are excluded by the store query, so this list only ever shows live, wanted work.
 */
export class TodayView {
	private el: HTMLElement;

	constructor(
		private container: HTMLElement,
		private store: TaskStore,
		private settings: PluginSettings,
		private callbacks: TaskItemRowCallbacks,
		private searchQuery: string = '',
	) {
		this.el = container.createDiv({ cls: 'friday-today-view' });
	}

	render(): void {
		this.el.empty();
		const today = todayStart();

		let tasks = this.store.getToday();
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			tasks = tasks.filter(t => t.text.toLowerCase().includes(q));
		}

		const overdue: TaskItem[] = [];
		const dueToday: TaskItem[] = [];
		for (const t of tasks) {
			if (t.dueDate && t.dueDate.getTime() < today.getTime()) overdue.push(t);
			else dueToday.push(t);
		}

		const header = this.el.createDiv({ cls: 'friday-view-header' });
		header.createSpan({ text: `Today — ${formatDateDisplay(today)}` });
		header.createSpan({ cls: 'friday-pending-count', text: ` (${tasks.length} to do)` });

		if (tasks.length === 0) {
			this.el.createDiv({
				cls: 'friday-empty',
				text: 'All clear for today. 🎉 Nothing due and nothing overdue.',
			});
			return;
		}

		const allTasks = this.store.getTasks();
		const sections: [string, TaskItem[]][] = [
			['Overdue', overdue],
			['Due Today', dueToday],
		];
		for (const [label, items] of sections) {
			if (items.length === 0) continue;
			const sectionEl = this.el.createDiv({ cls: 'friday-section' });
			if (label === 'Overdue') sectionEl.addClass('friday-section-overdue');
			// Group by source page/topic so related work clusters together.
			const grouped = this.store.groupTasks(items, this.settings.defaultGroupMode, this.settings.weekStartDay);
			const wrap = sectionEl.createDiv();
			wrap.createEl('h4', { cls: 'friday-section-header', text: `${label} (${items.length})` });
			new TaskList(wrap, grouped, this.callbacks, true, undefined, allTasks);
		}
	}

	destroy(): void {
		this.el.empty();
	}
}
