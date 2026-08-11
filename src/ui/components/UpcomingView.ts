import { TaskItem, PluginSettings } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { TaskItemRowCallbacks } from './TaskItemRow';
import { TaskList } from './TaskList';
import { isSameDay, todayStart } from '../../utils/dateUtils';

/**
 * The near-term horizon (v3): active tasks due after today within the configured window,
 * grouped by day, plus any snoozed tasks that will wake inside the same window (so nothing
 * sneaks up on you the moment it un-hides).
 */
export class UpcomingView {
	private el: HTMLElement;

	constructor(
		private container: HTMLElement,
		private store: TaskStore,
		private settings: PluginSettings,
		private callbacks: TaskItemRowCallbacks,
		private searchQuery: string = '',
	) {
		this.el = container.createDiv({ cls: 'friday-upcoming-view' });
	}

	render(): void {
		this.el.empty();
		const window = this.settings.upcomingWindowDays ?? 14;

		let tasks = this.store.getUpcoming(window);
		let waking = this.store.getWakingSnoozed(window);
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			tasks = tasks.filter(t => t.text.toLowerCase().includes(q));
			waking = waking.filter(t => t.text.toLowerCase().includes(q));
		}

		const header = this.el.createDiv({ cls: 'friday-view-header' });
		header.createSpan({ text: `Upcoming — next ${window} days` });
		header.createSpan({ cls: 'friday-pending-count', text: ` (${tasks.length})` });

		if (tasks.length === 0 && waking.length === 0) {
			this.el.createDiv({ cls: 'friday-empty', text: `Nothing due in the next ${window} days.` });
			return;
		}

		const allTasks = this.store.getTasks();

		// Bucket by day, in date order.
		const byDay = new Map<string, { label: string; ms: number; items: TaskItem[] }>();
		for (const t of tasks) {
			if (!t.dueDate) continue;
			const key = t.dueDate.toDateString();
			if (!byDay.has(key)) {
				byDay.set(key, { label: this.dayLabel(t.dueDate), ms: t.dueDate.getTime(), items: [] });
			}
			byDay.get(key)!.items.push(t);
		}
		const ordered = [...byDay.values()].sort((a, b) => a.ms - b.ms);
		const grouped = new Map<string, TaskItem[]>();
		for (const day of ordered) grouped.set(day.label, day.items);
		if (grouped.size > 0) {
			new TaskList(this.el, grouped, this.callbacks, true, undefined, allTasks);
		}

		// Snoozed items waking within the window — shown separately so their status is obvious.
		if (waking.length > 0) {
			const sectionEl = this.el.createDiv({ cls: 'friday-section' });
			sectionEl.createEl('h4', { cls: 'friday-section-header', text: `💤 Waking soon (${waking.length})` });
			const wakeGroup = new Map<string, TaskItem[]>([['Waking', waking]]);
			new TaskList(sectionEl, wakeGroup, this.callbacks, false, undefined, allTasks);
		}
	}

	private dayLabel(d: Date): string {
		const today = todayStart();
		const tomorrow = new Date(today.getTime());
		tomorrow.setDate(tomorrow.getDate() + 1);
		if (isSameDay(d, tomorrow)) return 'Tomorrow';
		return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
	}

	destroy(): void {
		this.el.empty();
	}
}
