import { TaskItem, PluginSettings, Priority } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { isSameDay, isToday } from '../../utils/dateUtils';
import { TaskItemRowCallbacks } from './TaskItemRow';
import { TaskItemRow } from './TaskItemRow';

const MONTH_NAMES = [
	'January', 'February', 'March', 'April', 'May', 'June',
	'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY_LABELS_SUNDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export class CalendarView {
	private el: HTMLElement;
	private selectedMonth: Date;
	private selectedDay: Date | null = null;

	constructor(
		container: HTMLElement,
		private store: TaskStore,
		private settings: PluginSettings,
		private callbacks: TaskItemRowCallbacks,
		private searchQuery: string,
	) {
		this.el = container.createDiv({ cls: 'friday-calendar' });
		const now = new Date();
		this.selectedMonth = new Date(now.getFullYear(), now.getMonth(), 1);
	}

	render(): void {
		this.el.empty();
		this.renderHeader();
		this.renderDayLabels();
		this.renderGrid();
		if (this.selectedDay) {
			this.renderDayDetail(this.selectedDay);
		}
	}

	private renderHeader(): void {
		const header = this.el.createDiv({ cls: 'friday-calendar-header' });

		const prevBtn = header.createEl('button', {
			cls: 'friday-calendar-nav',
			text: '‹',
		});
		prevBtn.addEventListener('click', () => {
			this.selectedMonth = new Date(
				this.selectedMonth.getFullYear(),
				this.selectedMonth.getMonth() - 1, 1,
			);
			this.selectedDay = null;
			this.render();
		});

		const title = header.createSpan({ cls: 'friday-calendar-title' });
		title.textContent = `${MONTH_NAMES[this.selectedMonth.getMonth()]} ${this.selectedMonth.getFullYear()}`;

		const nextBtn = header.createEl('button', {
			cls: 'friday-calendar-nav',
			text: '›',
		});
		nextBtn.addEventListener('click', () => {
			this.selectedMonth = new Date(
				this.selectedMonth.getFullYear(),
				this.selectedMonth.getMonth() + 1, 1,
			);
			this.selectedDay = null;
			this.render();
		});

		// Today button
		const todayBtn = header.createEl('button', {
			cls: 'friday-calendar-nav friday-calendar-today-btn',
			text: 'Today',
		});
		todayBtn.addEventListener('click', () => {
			const now = new Date();
			this.selectedMonth = new Date(now.getFullYear(), now.getMonth(), 1);
			this.selectedDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			this.render();
		});
	}

	private renderDayLabels(): void {
		const labels = this.el.createDiv({ cls: 'friday-calendar-day-labels' });
		const weekStart = this.settings.weekStartDay;
		for (let i = 0; i < 7; i++) {
			const dayIndex = (weekStart + i) % 7;
			labels.createDiv({
				cls: 'friday-calendar-day-label',
				text: DAY_LABELS_SUNDAY[dayIndex],
			});
		}
	}

	private renderGrid(): void {
		const grid = this.el.createDiv({ cls: 'friday-calendar-grid' });

		const year = this.selectedMonth.getFullYear();
		const month = this.selectedMonth.getMonth();
		const firstDay = new Date(year, month, 1);
		const lastDay = new Date(year, month + 1, 0);
		const daysInMonth = lastDay.getDate();
		const weekStart = this.settings.weekStartDay;

		// Get tasks for the visible range (including padding days)
		const rangeStart = new Date(year, month, 1 - ((firstDay.getDay() - weekStart + 7) % 7));
		const totalCells = Math.ceil((daysInMonth + ((firstDay.getDay() - weekStart + 7) % 7)) / 7) * 7;
		const rangeEnd = new Date(rangeStart);
		rangeEnd.setDate(rangeEnd.getDate() + totalCells - 1);
		rangeEnd.setHours(23, 59, 59, 999);

		const allTasks = this.store.getTasksForDateRange(rangeStart, rangeEnd);
		let tasks = allTasks;
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			tasks = tasks.filter(t => t.text.toLowerCase().includes(q));
		}

		// Build a map of date → tasks
		const tasksByDay = new Map<string, TaskItem[]>();
		for (const task of tasks) {
			if (!task.dueDate) continue;
			const key = `${task.dueDate.getFullYear()}-${task.dueDate.getMonth()}-${task.dueDate.getDate()}`;
			if (!tasksByDay.has(key)) tasksByDay.set(key, []);
			tasksByDay.get(key)!.push(task);
		}

		const today = new Date();

		for (let i = 0; i < totalCells; i++) {
			const cellDate = new Date(rangeStart);
			cellDate.setDate(cellDate.getDate() + i);

			const cell = grid.createDiv({ cls: 'friday-calendar-cell' });
			const isCurrentMonth = cellDate.getMonth() === month;
			const isTodayCell = isToday(cellDate, today);
			const isSelected = this.selectedDay && isSameDay(cellDate, this.selectedDay);

			if (!isCurrentMonth) cell.addClass('friday-calendar-other-month');
			if (isTodayCell) cell.addClass('friday-calendar-today');
			if (isSelected) cell.addClass('friday-calendar-selected');

			// Day number
			cell.createDiv({
				cls: 'friday-calendar-day-number',
				text: String(cellDate.getDate()),
			});

			// Task indicators
			const key = `${cellDate.getFullYear()}-${cellDate.getMonth()}-${cellDate.getDate()}`;
			const dayTasks = tasksByDay.get(key) || [];

			if (dayTasks.length > 0) {
				const dots = cell.createDiv({ cls: 'friday-calendar-task-dots' });
				const maxDots = 4;
				const shown = dayTasks.slice(0, maxDots);
				for (const t of shown) {
					const dot = dots.createSpan({ cls: 'friday-calendar-dot' });
					if (t.priority === Priority.High) dot.addClass('friday-priority-high');
					else if (t.priority === Priority.Medium) dot.addClass('friday-priority-medium');
					else if (t.priority === Priority.Low) dot.addClass('friday-priority-low');
					else dot.addClass('friday-calendar-dot-default');
				}
				if (dayTasks.length > maxDots) {
					dots.createSpan({
						cls: 'friday-calendar-dot-more',
						text: `+${dayTasks.length - maxDots}`,
					});
				}
			}

			// Click handler
			const clickDate = new Date(cellDate);
			cell.addEventListener('click', () => {
				this.selectedDay = clickDate;
				this.render();
			});
		}
	}

	private renderDayDetail(date: Date): void {
		const detail = this.el.createDiv({ cls: 'friday-calendar-detail' });

		const dayLabel = detail.createDiv({ cls: 'friday-calendar-detail-header' });
		const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
		dayLabel.textContent = `${days[date.getDay()]}, ${MONTH_NAMES[date.getMonth()]} ${date.getDate()}`;

		// Get tasks for this day
		let dayTasks = this.store.getTasksForDate(date);
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			dayTasks = dayTasks.filter(t => t.text.toLowerCase().includes(q));
		}

		if (dayTasks.length === 0) {
			detail.createDiv({
				cls: 'friday-empty',
				text: 'No tasks due on this day.',
			});
			return;
		}

		const list = detail.createDiv({ cls: 'friday-calendar-detail-list' });
		for (const task of dayTasks) {
			new TaskItemRow(list, task, this.callbacks);
		}
	}
}
