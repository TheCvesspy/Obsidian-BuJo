import { TaskItem, TaskStatus, PluginSettings, GroupMode } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { TaskItemRowCallbacks } from './TaskItemRow';
import { TaskList } from './TaskList';
import { formatDateDisplay, formatDateISO, todayStart } from '../../utils/dateUtils';

export class DailyView {
	private el: HTMLElement;

	constructor(
		private container: HTMLElement,
		private store: TaskStore,
		private settings: PluginSettings,
		private callbacks: TaskItemRowCallbacks,
		private searchQuery: string = ''
	) {
		this.el = container.createDiv({ cls: 'friday-daily-view' });
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

		// Single-pass bucketing.
		//
		// History notes:
		//   - "Unscheduled" used to be a bucket here; it's now a dedicated top-level tab.
		//   - "Carried Over" used to be a bucket too, populated by the old forward-as-copy
		//     migration flow that wrote `(from [[source]])` lines into today's daily note.
		//     That copy step is gone — forwarding now just stamps `@due today` on the
		//     source — so there's no Carried Over bucket either. Legacy carried-over
		//     copies from old daily notes still show up in "Daily Log" (they ARE in
		//     today's daily note); they just don't get a separate section.
		const overdue: TaskItem[] = [];
		const dailyLog: TaskItem[] = [];
		const dueToday: TaskItem[] = [];
		const upcoming: TaskItem[] = [];
		let pendingCount = 0;

		// Today's daily note path — tasks here are shown in Daily Log.
		const todayDailyPath = this.settings.dailyNotePath
			? `${this.settings.dailyNotePath}/${formatDateISO(today)}.md`
			: null;

		for (const t of tasks) {
			if (t.status === TaskStatus.Open && t.dueDate && t.dueDate < today) {
				// Past due date — overdue
				overdue.push(t);
				pendingCount++;
			} else if (todayDailyPath && t.sourcePath === todayDailyPath) {
				// Anything in today's daily note (directly written via QuickCapture / Add Task,
				// or a leftover legacy carried-over copy) lands in Daily Log.
				dailyLog.push(t);
				if (t.status === TaskStatus.Open) pendingCount++;
			} else if (t.dueDate && t.dueDate.toDateString() === todayStr) {
				// Tasks scheduled for today via @due — the natural aggregation surface
				// that "Forward" feeds into now.
				dueToday.push(t);
				if (t.status === TaskStatus.Open) pendingCount++;
			} else if (t.status === TaskStatus.Open && t.dueDate) {
				// Future due date — upcoming.
				upcoming.push(t);
				pendingCount++;
			}
		}

		// Header
		const header = this.el.createDiv({ cls: 'friday-view-header' });
		header.createSpan({ text: `Daily Log — ${formatDateDisplay(today)}` });
		header.createSpan({ cls: 'friday-pending-count', text: ` (${pendingCount} pending)` });

		// Sections. The dashboard aggregates from across the vault using @due — no
		// daily-note copies needed. Unscheduled and Carried Over used to live here.
		const sections: [string, TaskItem[]][] = [
			['Overdue', overdue],
			['Due Today', dueToday],
			['Daily Log', dailyLog],
			['Upcoming', upcoming],
		];

		for (const [label, items] of sections) {
			const sectionEl = this.el.createDiv({ cls: 'friday-section' });
			sectionEl.createEl('h4', { cls: 'friday-section-header', text: label });
			if (items.length === 0) {
				sectionEl.createDiv({ cls: 'friday-muted', text: 'No tasks' });
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
