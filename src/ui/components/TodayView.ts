import { TaskItem, PluginSettings } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { TaskItemRowCallbacks } from './TaskItemRow';
import { TaskList } from './TaskList';
import { formatDateDisplay, isSameDay, todayStart } from '../../utils/dateUtils';

/** Hard ceiling on the Today look-ahead — past this it stops being a preview and becomes Upcoming. */
const MAX_LOOKAHEAD_DAYS = 14;
const DEFAULT_LOOKAHEAD_DAYS = 3;

/**
 * The daily driver (v3). One flat surface: everything that's due — overdue first, then
 * due today — pulled from every home (Tasks.md, Topics, any page). Snoozed and Someday
 * tasks are excluded by the store query, so this list only ever shows live, wanted work.
 *
 * Below the live list sits a muted look-ahead: what's due over the next few days, bucketed
 * by day, so the shape of the week is visible without leaving the tab. It's context, not
 * the to-do list — hence the visual demotion.
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
		const lookaheadDays = this.lookaheadDays();

		let tasks = this.store.getToday();
		let ahead = lookaheadDays > 0 ? this.store.getUpcoming(lookaheadDays) : [];
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			tasks = tasks.filter(t => t.text.toLowerCase().includes(q));
			ahead = ahead.filter(t => t.text.toLowerCase().includes(q));
		}

		const overdue: TaskItem[] = [];
		const dueToday: TaskItem[] = [];
		for (const t of tasks) {
			if (t.dueDate && t.dueDate.getTime() < today.getTime()) overdue.push(t);
			else dueToday.push(t);
		}

		const header = this.el.createDiv({ cls: 'friday-view-header' });
		header.createSpan({ text: `Today — ${formatDateDisplay(today)}` });
		const counts = `${tasks.length} to do` + (ahead.length > 0 ? ` · ${ahead.length} coming up` : '');
		header.createSpan({ cls: 'friday-pending-count', text: ` (${counts})` });

		if (tasks.length === 0) {
			this.el.createDiv({
				cls: 'friday-empty',
				text: 'All clear for today. 🎉 Nothing due and nothing overdue.',
			});
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

		if (lookaheadDays > 0) this.renderLookahead(ahead, lookaheadDays, today, allTasks);
	}

	/** The next-N-days preview, bucketed by due day. Days with nothing due are skipped. */
	private renderLookahead(ahead: TaskItem[], days: number, today: Date, allTasks: TaskItem[]): void {
		const sectionEl = this.el.createDiv({ cls: 'friday-section friday-today-lookahead' });
		sectionEl.createEl('h4', {
			cls: 'friday-section-header',
			text: `Next ${days} days (${ahead.length})`,
		});

		if (ahead.length === 0) {
			sectionEl.createDiv({ cls: 'friday-empty', text: `Nothing due in the next ${days} days.` });
			return;
		}

		// One bucket per day, in date order — empty days are dropped rather than shown blank.
		const byDay = new Map<string, { label: string; ms: number; items: TaskItem[] }>();
		for (const t of ahead) {
			if (!t.dueDate) continue;
			const key = t.dueDate.toDateString();
			if (!byDay.has(key)) {
				byDay.set(key, { label: this.dayLabel(t.dueDate, today), ms: t.dueDate.getTime(), items: [] });
			}
			byDay.get(key)!.items.push(t);
		}
		const grouped = new Map<string, TaskItem[]>();
		for (const day of [...byDay.values()].sort((a, b) => a.ms - b.ms)) {
			grouped.set(day.label, day.items);
		}
		new TaskList(sectionEl, grouped, this.callbacks, true, undefined, allTasks);
	}

	private dayLabel(d: Date, today: Date): string {
		const tomorrow = new Date(today.getTime());
		tomorrow.setDate(tomorrow.getDate() + 1);
		if (isSameDay(d, tomorrow)) return 'Tomorrow';
		return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
	}

	/** Configured look-ahead, clamped to a sane range. 0 disables the preview. */
	private lookaheadDays(): number {
		const raw = this.settings.todayLookaheadDays;
		if (typeof raw !== 'number' || !isFinite(raw)) return DEFAULT_LOOKAHEAD_DAYS;
		return Math.max(0, Math.min(MAX_LOOKAHEAD_DAYS, Math.round(raw)));
	}

	destroy(): void {
		this.el.empty();
	}
}
