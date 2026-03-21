import { TaskItem, TaskStatus, PluginSettings, PluginData, MonthlySnapshot } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { MonthlyAnalyticsService, MonthlyStats } from '../../services/monthlyAnalyticsService';
import { MonthlyNoteService } from '../../services/monthlyNoteService';
import { TaskItemRow, TaskItemRowCallbacks } from './TaskItemRow';
import { TaskList } from './TaskList';
import { createPriorityDot, createDueBadge } from '../icons';
import { getMonthId, formatMonthDisplay, getPreviousMonth, getNextMonth, parseMonthId } from '../../utils/monthUtils';
import { formatDateDisplay, isOverdue } from '../../utils/dateUtils';
import { getChildProgress } from '../../utils/taskHierarchy';
import { Priority } from '../../types';

export class MonthlyView {
	private el: HTMLElement;
	private selectedMonth: Date;
	private collapsedGoals: Set<string> = new Set();

	constructor(
		container: HTMLElement,
		private store: TaskStore,
		private monthlyAnalytics: MonthlyAnalyticsService,
		private monthlyNotes: MonthlyNoteService,
		private settings: PluginSettings,
		private callbacks: TaskItemRowCallbacks,
		private searchQuery: string,
		private getData: () => PluginData,
		private onSaveSnapshot: (snapshot: MonthlySnapshot) => void,
		private collapsedGroups: Set<string>,
	) {
		this.el = container.createDiv({ cls: 'task-bujo-monthly' });
		this.selectedMonth = new Date();
	}

	render(): void {
		this.el.empty();

		const monthId = getMonthId(this.selectedMonth);
		const stats = this.monthlyAnalytics.getStatsForMonth(this.selectedMonth);

		this.renderHeader(monthId);
		this.renderStats(stats);
		this.renderGoals(monthId);
		this.renderTasks(monthId);
		this.renderHistory();
	}

	private renderHeader(monthId: string): void {
		const header = this.el.createDiv({ cls: 'task-bujo-monthly-header' });

		const nav = header.createDiv({ cls: 'task-bujo-monthly-nav' });
		const prevBtn = nav.createEl('button', { cls: 'task-bujo-btn task-bujo-monthly-nav-btn', text: '‹' });
		prevBtn.addEventListener('click', () => {
			this.selectedMonth = getPreviousMonth(this.selectedMonth);
			this.render();
		});

		nav.createEl('h3', { text: formatMonthDisplay(this.selectedMonth) });

		const nextBtn = nav.createEl('button', { cls: 'task-bujo-btn task-bujo-monthly-nav-btn', text: '›' });
		nextBtn.addEventListener('click', () => {
			this.selectedMonth = getNextMonth(this.selectedMonth);
			this.render();
		});

		const saveBtn = header.createEl('button', {
			cls: 'task-bujo-analytics-save-btn',
			text: 'Save Snapshot',
		});
		saveBtn.addEventListener('click', async () => {
			const stats = this.monthlyAnalytics.getStatsForMonth(this.selectedMonth);
			const reflections = await this.monthlyNotes.readReflections(this.selectedMonth);
			const snapshot = this.monthlyAnalytics.createSnapshot(stats, reflections);
			this.onSaveSnapshot(snapshot);
			saveBtn.textContent = 'Saved';
			saveBtn.setAttribute('disabled', 'true');
			setTimeout(() => {
				saveBtn.textContent = 'Save Snapshot';
				saveBtn.removeAttribute('disabled');
			}, 2000);
		});
	}

	private renderStats(stats: MonthlyStats): void {
		const section = this.el.createDiv({ cls: 'task-bujo-analytics-summary' });

		const cards: { label: string; value: string; cls?: string }[] = [
			{ label: 'Planned', value: String(stats.totalPlanned) },
			{ label: 'Completed', value: String(stats.totalCompleted), cls: 'done' },
			{ label: 'Rate', value: `${stats.completionRate.toFixed(0)}%` },
			{ label: 'Goals', value: `${stats.goalsCompleted}/${stats.goalsTotal}`, cls: 'goals' },
			{ label: 'Migrated', value: String(stats.totalMigrated), cls: 'migrated' },
		];

		for (const card of cards) {
			const cardEl = section.createDiv({ cls: `task-bujo-analytics-card ${card.cls || ''}` });
			cardEl.createDiv({ cls: 'task-bujo-analytics-card-value', text: card.value });
			cardEl.createDiv({ cls: 'task-bujo-analytics-card-label', text: card.label });
		}
	}

	private renderGoals(monthId: string): void {
		const section = this.el.createDiv({ cls: 'task-bujo-monthly-goals' });
		section.createEl('h4', { text: 'Goals' });

		const monthlyNotePath = `${this.settings.monthlyNotePath}/${monthId}.md`;
		const goals = this.store.getGoalsForPath(monthlyNotePath);

		// Apply search filter
		const filtered = this.searchQuery
			? goals.filter(g => g.text.toLowerCase().includes(this.searchQuery.toLowerCase()))
			: goals;

		if (filtered.length === 0) {
			section.createDiv({ cls: 'task-bujo-empty', text: 'No goals for this month' });
			return;
		}

		// Overall goals progress bar
		const doneCount = filtered.filter(g => g.status === TaskStatus.Done).length;
		const overallProgress = section.createDiv({ cls: 'task-bujo-monthly-goals-progress' });
		overallProgress.createSpan({ text: `${doneCount}/${filtered.length} goals complete` });
		const overallBar = overallProgress.createDiv({ cls: 'task-bujo-progress-bar' });
		const overallFill = overallBar.createDiv({ cls: 'task-bujo-progress-fill' });
		overallFill.style.width = filtered.length > 0 ? `${(doneCount / filtered.length) * 100}%` : '0%';

		for (const goal of filtered) {
			this.renderGoalRow(section, goal);
		}
	}

	private renderGoalRow(container: HTMLElement, goal: TaskItem): void {
		const row = container.createDiv({ cls: 'task-bujo-monthly-goal-row' });
		const isCollapsed = this.collapsedGoals.has(goal.id);
		const hasChildren = goal.childrenIds.length > 0;

		// Collapse/expand toggle
		if (hasChildren) {
			const toggle = row.createSpan({ cls: 'task-bujo-subtask-toggle' });
			toggle.textContent = isCollapsed ? '▶' : '▼';
			toggle.addEventListener('click', (e) => {
				e.stopPropagation();
				if (this.collapsedGoals.has(goal.id)) {
					this.collapsedGoals.delete(goal.id);
				} else {
					this.collapsedGoals.add(goal.id);
				}
				this.render();
			});
		}

		// Checkbox
		const checkbox = row.createEl('input', { type: 'checkbox' });
		checkbox.checked = goal.status === TaskStatus.Done;
		checkbox.disabled = goal.status === TaskStatus.Migrated || goal.status === TaskStatus.Cancelled;
		checkbox.addClass('task-bujo-checkbox');
		checkbox.addEventListener('change', () => {
			this.callbacks.onToggle(goal);
		});

		// Priority dot
		if (goal.priority !== Priority.None) {
			row.appendChild(createPriorityDot(goal.priority));
		}

		// Goal text
		const textSpan = row.createSpan({ cls: 'task-bujo-task-text' });
		textSpan.textContent = goal.text;
		if (goal.status === TaskStatus.Done || goal.status === TaskStatus.Cancelled) {
			textSpan.addClass('task-bujo-task-done');
		}

		// Due badge
		if (goal.dueDate) {
			const overdue = goal.status === TaskStatus.Open && isOverdue(goal.dueDate);
			row.appendChild(createDueBadge(formatDateDisplay(goal.dueDate), overdue));
		}

		// Sub-task progress bar
		if (hasChildren) {
			const progress = getChildProgress(goal, (id) => this.store.getTaskById(id));
			const progressWrap = row.createDiv({ cls: 'task-bujo-monthly-goal-progress' });
			const bar = progressWrap.createDiv({ cls: 'task-bujo-progress-bar task-bujo-progress-bar-sm' });
			const fill = bar.createDiv({ cls: 'task-bujo-progress-fill' });
			const pct = progress.total > 0 ? (progress.completed / progress.total) * 100 : 0;
			fill.style.width = `${pct}%`;
			progressWrap.createSpan({
				cls: 'task-bujo-monthly-goal-progress-label',
				text: `${progress.completed}/${progress.total}`,
			});
		}

		// Source link
		const fileName = goal.sourcePath.split('/').pop()?.replace(/\.md$/, '') || goal.sourcePath;
		const sourceEl = row.createSpan({ cls: 'task-bujo-source-link', text: fileName });
		sourceEl.addEventListener('click', (e) => {
			e.stopPropagation();
			this.callbacks.onClickSource(goal);
		});

		// Render children if expanded
		if (hasChildren && !isCollapsed) {
			const childrenEl = container.createDiv({ cls: 'task-bujo-monthly-goal-children' });
			for (const childId of goal.childrenIds) {
				const child = this.store.getTaskById(childId);
				if (child) {
					new TaskItemRow(childrenEl, child, {
						...this.callbacks,
						getTaskById: (id) => this.store.getTaskById(id),
					});
				}
			}
		}
	}

	private renderTasks(monthId: string): void {
		const section = this.el.createDiv({ cls: 'task-bujo-monthly-tasks' });
		section.createEl('h4', { text: 'Tasks' });

		const monthlyNotePath = `${this.settings.monthlyNotePath}/${monthId}.md`;
		let tasks = this.store.getTasks().filter(
			t => t.parentId === null && t.sourcePath === monthlyNotePath
		);

		// Apply search filter
		if (this.searchQuery) {
			tasks = tasks.filter(t => t.text.toLowerCase().includes(this.searchQuery.toLowerCase()));
		}

		// Filter completed based on settings
		tasks = this.store.filterCompleted(tasks, this.settings.showCompletedTasks);

		if (tasks.length === 0) {
			section.createDiv({ cls: 'task-bujo-empty', text: 'No tasks for this month' });
			return;
		}

		const grouped = new Map<string, TaskItem[]>([['Monthly Tasks', tasks]]);
		new TaskList(section, grouped, this.callbacks, false, this.collapsedGroups);
	}

	private renderHistory(): void {
		const history = this.getData().monthlyHistory;
		if (history.length === 0) return;

		const section = this.el.createDiv({ cls: 'task-bujo-analytics-trends' });
		section.createEl('h4', { text: 'Monthly Trends' });

		const recent = history.slice(-6);

		const table = section.createEl('table', { cls: 'task-bujo-analytics-trend-table' });
		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		for (const h of ['Month', 'Planned', 'Done', 'Goals', 'Rate']) {
			headerRow.createEl('th', { text: h });
		}

		const tbody = table.createEl('tbody');
		for (const snapshot of recent) {
			const row = tbody.createEl('tr');
			const monthDate = parseMonthId(snapshot.monthId);
			row.createEl('td', { text: formatMonthDisplay(monthDate) });
			row.createEl('td', { text: String(snapshot.totalPlanned) });
			row.createEl('td', { text: String(snapshot.totalCompleted) });
			row.createEl('td', { text: `${snapshot.goalsCompleted}/${snapshot.goalsTotal}` });
			const rate = snapshot.totalPlanned > 0
				? ((snapshot.totalCompleted / snapshot.totalPlanned) * 100).toFixed(0) + '%'
				: '—';
			row.createEl('td', { text: rate });
		}
	}
}
