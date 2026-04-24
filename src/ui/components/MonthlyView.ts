import { TaskItem, PluginSettings, PluginData, MonthlySnapshot } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { MonthlyAnalyticsService, MonthlyStats } from '../../services/monthlyAnalyticsService';
import { MonthlyNoteService } from '../../services/monthlyNoteService';
import { TaskItemRowCallbacks } from './TaskItemRow';
import { TaskList } from './TaskList';
import { getMonthId, formatMonthDisplay, getPreviousMonth, getNextMonth, parseMonthId } from '../../utils/monthUtils';

export class MonthlyView {
	private el: HTMLElement;
	private selectedMonth: Date;

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
		this.renderTasks(monthId);
		this.renderHistory();
	}

	private renderHeader(_monthId: string): void {
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
			{ label: 'Migrated', value: String(stats.totalMigrated), cls: 'migrated' },
		];

		for (const card of cards) {
			const cardEl = section.createDiv({ cls: `task-bujo-analytics-card ${card.cls || ''}` });
			cardEl.createDiv({ cls: 'task-bujo-analytics-card-value', text: card.value });
			cardEl.createDiv({ cls: 'task-bujo-analytics-card-label', text: card.label });
		}
	}

	private renderTasks(monthId: string): void {
		const section = this.el.createDiv({ cls: 'task-bujo-monthly-tasks' });
		section.createEl('h4', { text: 'Tasks' });

		const monthlyNotePath = `${this.settings.monthlyNotePath}/${monthId}.md`;
		let tasks = this.store.getTasks().filter(
			t => t.parentId === null && t.sourcePath === monthlyNotePath
		);

		if (this.searchQuery) {
			tasks = tasks.filter(t => t.text.toLowerCase().includes(this.searchQuery.toLowerCase()));
		}

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
		for (const h of ['Month', 'Planned', 'Done', 'Rate']) {
			headerRow.createEl('th', { text: h });
		}

		const tbody = table.createEl('tbody');
		for (const snapshot of recent) {
			const row = tbody.createEl('tr');
			const monthDate = parseMonthId(snapshot.monthId);
			row.createEl('td', { text: formatMonthDisplay(monthDate) });
			row.createEl('td', { text: String(snapshot.totalPlanned) });
			row.createEl('td', { text: String(snapshot.totalCompleted) });
			const rate = snapshot.totalPlanned > 0
				? ((snapshot.totalCompleted / snapshot.totalPlanned) * 100).toFixed(0) + '%'
				: '—';
			row.createEl('td', { text: rate });
		}
	}
}
