import { TaskStore } from '../../services/taskStore';
import { AnalyticsService, WeeklyStats } from '../../services/analyticsService';
import { PluginSettings, WeeklySnapshot } from '../../types';
import { formatWeekId, getWeekStartConfigurable } from '../../utils/dateUtils';

export class AnalyticsView {
	private el: HTMLElement;

	constructor(
		container: HTMLElement,
		private store: TaskStore,
		private analyticsService: AnalyticsService,
		private settings: PluginSettings,
		private weeklyHistory: WeeklySnapshot[],
		private onSaveSnapshot: (snapshot: WeeklySnapshot) => void,
	) {
		this.el = container.createDiv({ cls: 'task-bujo-analytics' });
	}

	render(): void {
		this.el.empty();

		const stats = this.analyticsService.getCurrentWeekStats();

		// Header
		const header = this.el.createDiv({ cls: 'task-bujo-analytics-header' });
		header.createEl('h3', { text: `Analytics — ${formatWeekId(stats.weekId)}` });

		const saveBtn = header.createEl('button', {
			cls: 'task-bujo-analytics-save-btn',
			text: 'Save Week Snapshot',
		});
		saveBtn.addEventListener('click', () => {
			const snapshot = this.analyticsService.createSnapshot(stats);
			this.onSaveSnapshot(snapshot);
			saveBtn.textContent = 'Saved';
			saveBtn.setAttribute('disabled', 'true');
			setTimeout(() => {
				saveBtn.textContent = 'Save Week Snapshot';
				saveBtn.removeAttribute('disabled');
			}, 2000);
		});

		// Summary cards
		this.renderSummary(stats);

		// Work Type breakdown
		this.renderBreakdown('Work Type', stats.workTypeBreakdown);

		// Purpose breakdown
		this.renderBreakdown('Purpose', stats.purposeBreakdown);

		// Trends (from history)
		if (this.weeklyHistory.length > 0) {
			this.renderTrends();
		}
	}

	private renderSummary(stats: WeeklyStats): void {
		const section = this.el.createDiv({ cls: 'task-bujo-analytics-summary' });

		const cards: { label: string; value: string; cls?: string }[] = [
			{ label: 'Planned', value: String(stats.totalPlanned) },
			{ label: 'Completed', value: String(stats.totalCompleted), cls: 'done' },
			{ label: 'Migrated', value: String(stats.totalMigrated), cls: 'migrated' },
			{ label: 'Cancelled', value: String(stats.totalCancelled), cls: 'cancelled' },
			{ label: 'Completion Rate', value: `${stats.completionRate.toFixed(0)}%` },
		];

		for (const card of cards) {
			const cardEl = section.createDiv({ cls: `task-bujo-analytics-card ${card.cls || ''}` });
			cardEl.createDiv({ cls: 'task-bujo-analytics-card-value', text: card.value });
			cardEl.createDiv({ cls: 'task-bujo-analytics-card-label', text: card.label });
		}
	}

	private renderBreakdown(title: string, data: Map<string, { planned: number; completed: number }>): void {
		if (data.size === 0) return;

		const section = this.el.createDiv({ cls: 'task-bujo-analytics-breakdown' });
		section.createEl('h4', { text: title });

		const maxPlanned = Math.max(...Array.from(data.values()).map(v => v.planned), 1);

		for (const [name, { planned, completed }] of data) {
			const row = section.createDiv({ cls: 'task-bujo-analytics-bar-row' });
			row.createDiv({ cls: 'task-bujo-analytics-bar-label', text: name });

			const barContainer = row.createDiv({ cls: 'task-bujo-analytics-bar-container' });
			const plannedWidth = (planned / maxPlanned) * 100;
			const completedWidth = planned > 0 ? (completed / planned) * plannedWidth : 0;

			const plannedBar = barContainer.createDiv({ cls: 'task-bujo-analytics-bar planned' });
			plannedBar.style.width = `${plannedWidth}%`;

			const completedBar = barContainer.createDiv({ cls: 'task-bujo-analytics-bar completed' });
			completedBar.style.width = `${completedWidth}%`;

			row.createDiv({
				cls: 'task-bujo-analytics-bar-value',
				text: `${completed}/${planned}`,
			});
		}
	}

	private renderTrends(): void {
		const section = this.el.createDiv({ cls: 'task-bujo-analytics-trends' });
		section.createEl('h4', { text: 'Week-over-Week Trends' });

		// Show last 8 weeks max
		const recent = this.weeklyHistory.slice(-8);

		const table = section.createEl('table', { cls: 'task-bujo-analytics-trend-table' });
		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		for (const h of ['Week', 'Planned', 'Done', 'Migrated', 'Rate']) {
			headerRow.createEl('th', { text: h });
		}

		const tbody = table.createEl('tbody');
		for (const snapshot of recent) {
			const row = tbody.createEl('tr');
			row.createEl('td', { text: formatWeekId(snapshot.weekId) });
			row.createEl('td', { text: String(snapshot.totalPlanned) });
			row.createEl('td', { text: String(snapshot.totalCompleted) });
			row.createEl('td', { text: String(snapshot.totalMigrated) });
			const rate = snapshot.totalPlanned > 0
				? ((snapshot.totalCompleted / snapshot.totalPlanned) * 100).toFixed(0) + '%'
				: '—';
			row.createEl('td', { text: rate });
		}

		// Visual trend: completion rate bar for each week
		const chartSection = section.createDiv({ cls: 'task-bujo-analytics-trend-chart' });
		for (const snapshot of recent) {
			const rate = snapshot.totalPlanned > 0
				? (snapshot.totalCompleted / snapshot.totalPlanned) * 100
				: 0;

			const col = chartSection.createDiv({ cls: 'task-bujo-analytics-trend-col' });
			const barWrap = col.createDiv({ cls: 'task-bujo-analytics-trend-bar-wrap' });
			const bar = barWrap.createDiv({ cls: 'task-bujo-analytics-trend-bar' });
			bar.style.height = `${rate}%`;
			col.createDiv({ cls: 'task-bujo-analytics-trend-label', text: formatWeekId(snapshot.weekId) });
		}
	}
}
