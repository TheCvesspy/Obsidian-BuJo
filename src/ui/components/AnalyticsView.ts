import { TaskStore } from '../../services/taskStore';
import { AnalyticsService, WeeklyStats } from '../../services/analyticsService';
import { PluginSettings, WeeklySnapshot, SprintTopic } from '../../types';
import { formatWeekId, getWeekId, getWeekStartConfigurable } from '../../utils/dateUtils';
import { computeFlow, FlowMetrics } from '../../services/flowMetricsService';

export class AnalyticsView {
	private el: HTMLElement;

	constructor(
		container: HTMLElement,
		private store: TaskStore,
		private analyticsService: AnalyticsService,
		private settings: PluginSettings,
		private weeklyHistory: WeeklySnapshot[],
		private onSaveSnapshot: (snapshot: WeeklySnapshot) => void,
		private topics: SprintTopic[] = [],
	) {
		this.el = container.createDiv({ cls: 'friday-analytics' });
	}

	render(): void {
		this.el.empty();

		const stats = this.analyticsService.getCurrentWeekStats();

		// Header
		const header = this.el.createDiv({ cls: 'friday-analytics-header' });
		header.createEl('h3', { text: `Analytics — ${formatWeekId(stats.weekId)}` });

		const saveBtn = header.createEl('button', {
			cls: 'friday-analytics-save-btn',
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

		// Kanban flow metrics (cycle time / throughput / aging WIP)
		this.renderFlow();
	}

	private renderSummary(stats: WeeklyStats): void {
		const section = this.el.createDiv({ cls: 'friday-analytics-summary' });

		const cards: { label: string; value: string; cls?: string }[] = [
			{ label: 'Planned', value: String(stats.totalPlanned) },
			{ label: 'Completed', value: String(stats.totalCompleted), cls: 'done' },
			{ label: 'Migrated', value: String(stats.totalMigrated), cls: 'migrated' },
			{ label: 'Cancelled', value: String(stats.totalCancelled), cls: 'cancelled' },
			{ label: 'Completion Rate', value: `${stats.completionRate.toFixed(0)}%` },
		];

		for (const card of cards) {
			const cardEl = section.createDiv({ cls: `friday-analytics-card ${card.cls || ''}` });
			cardEl.createDiv({ cls: 'friday-analytics-card-value', text: card.value });
			cardEl.createDiv({ cls: 'friday-analytics-card-label', text: card.label });
		}
	}

	private renderBreakdown(title: string, data: Map<string, { planned: number; completed: number }>): void {
		if (data.size === 0) return;

		const section = this.el.createDiv({ cls: 'friday-analytics-breakdown' });
		section.createEl('h4', { text: title });

		const maxPlanned = Math.max(...Array.from(data.values()).map(v => v.planned), 1);

		for (const [name, { planned, completed }] of data) {
			const row = section.createDiv({ cls: 'friday-analytics-bar-row' });
			row.createDiv({ cls: 'friday-analytics-bar-label', text: name });

			const barContainer = row.createDiv({ cls: 'friday-analytics-bar-container' });
			const plannedWidth = (planned / maxPlanned) * 100;
			const completedWidth = planned > 0 ? (completed / planned) * plannedWidth : 0;

			const plannedBar = barContainer.createDiv({ cls: 'friday-analytics-bar planned' });
			plannedBar.style.width = `${plannedWidth}%`;

			const completedBar = barContainer.createDiv({ cls: 'friday-analytics-bar completed' });
			completedBar.style.width = `${completedWidth}%`;

			row.createDiv({
				cls: 'friday-analytics-bar-value',
				text: `${completed}/${planned}`,
			});
		}
	}

	private renderTrends(): void {
		const section = this.el.createDiv({ cls: 'friday-analytics-trends' });
		section.createEl('h4', { text: 'Week-over-Week Trends' });

		// Show last 8 weeks max
		const recent = this.weeklyHistory.slice(-8);

		const table = section.createEl('table', { cls: 'friday-analytics-trend-table' });
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
		const chartSection = section.createDiv({ cls: 'friday-analytics-trend-chart' });
		for (const snapshot of recent) {
			const rate = snapshot.totalPlanned > 0
				? (snapshot.totalCompleted / snapshot.totalPlanned) * 100
				: 0;

			const col = chartSection.createDiv({ cls: 'friday-analytics-trend-col' });
			const barWrap = col.createDiv({ cls: 'friday-analytics-trend-bar-wrap' });
			const bar = barWrap.createDiv({ cls: 'friday-analytics-trend-bar' });
			bar.style.height = `${rate}%`;
			col.createDiv({ cls: 'friday-analytics-trend-label', text: formatWeekId(snapshot.weekId) });
		}
	}

	/** Kanban flow metrics computed from topic status timestamps. */
	private renderFlow(): void {
		const flow = computeFlow(this.topics, new Date(), this.settings.agingWipThresholdDays ?? 7);

		const section = this.el.createDiv({ cls: 'friday-analytics-flow' });
		section.createEl('h4', { text: 'Flow' });

		const summary = section.createDiv({ cls: 'friday-analytics-summary' });

		const cycleCard = summary.createDiv({ cls: 'friday-analytics-card' });
		cycleCard.createDiv({
			cls: 'friday-analytics-card-value',
			text: flow.avgCycleTimeDays !== null ? `${flow.avgCycleTimeDays.toFixed(1)}d` : '—',
		});
		cycleCard.createDiv({
			cls: 'friday-analytics-card-label',
			text: flow.cycleSampleSize > 0 ? `Avg cycle time (${flow.cycleSampleSize})` : 'Avg cycle time',
		});

		const thisWeek = getWeekId(new Date());
		const doneThisWeek = flow.throughputByWeek.get(thisWeek) ?? 0;
		const tpCard = summary.createDiv({ cls: 'friday-analytics-card done' });
		tpCard.createDiv({ cls: 'friday-analytics-card-value', text: String(doneThisWeek) });
		tpCard.createDiv({ cls: 'friday-analytics-card-label', text: 'Done this week' });

		const agingCard = summary.createDiv({ cls: 'friday-analytics-card cancelled' });
		agingCard.createDiv({ cls: 'friday-analytics-card-value', text: String(flow.agingWip.length) });
		agingCard.createDiv({ cls: 'friday-analytics-card-label', text: 'Aging WIP' });

		this.renderThroughput(section, flow);
		this.renderAgingWip(section, flow);
	}

	private renderThroughput(section: HTMLElement, flow: FlowMetrics): void {
		// Last 8 ISO weeks, oldest → newest.
		const weeks: string[] = [];
		const now = new Date();
		for (let i = 7; i >= 0; i--) {
			const d = new Date(now);
			d.setDate(d.getDate() - i * 7);
			weeks.push(getWeekId(d));
		}
		const counts = weeks.map(w => flow.throughputByWeek.get(w) ?? 0);
		const max = Math.max(...counts, 1);

		const wrap = section.createDiv({ cls: 'friday-analytics-trends' });
		wrap.createEl('h4', { text: 'Throughput (topics done / week)' });
		const chart = wrap.createDiv({ cls: 'friday-analytics-trend-chart' });
		weeks.forEach((w, i) => {
			const col = chart.createDiv({ cls: 'friday-analytics-trend-col' });
			const barWrap = col.createDiv({ cls: 'friday-analytics-trend-bar-wrap' });
			const bar = barWrap.createDiv({ cls: 'friday-analytics-trend-bar' });
			bar.style.height = `${(counts[i] / max) * 100}%`;
			bar.setAttribute('title', `${counts[i]} done`);
			col.createDiv({ cls: 'friday-analytics-trend-label', text: formatWeekId(w) });
		});
	}

	private renderAgingWip(section: HTMLElement, flow: FlowMetrics): void {
		const wrap = section.createDiv({ cls: 'friday-analytics-aging' });
		wrap.createEl('h4', { text: 'Aging work-in-progress' });
		if (flow.agingWip.length === 0) {
			wrap.createDiv({ cls: 'friday-empty', text: 'Nothing aging past the threshold. Nice flow.' });
			return;
		}
		const list = wrap.createDiv({ cls: 'friday-analytics-aging-list' });
		for (const { topic, daysInColumn } of flow.agingWip.slice(0, 12)) {
			const row = list.createDiv({ cls: 'friday-analytics-aging-row' });
			row.createSpan({ cls: 'friday-analytics-aging-title', text: topic.title });
			row.createSpan({ cls: 'friday-analytics-aging-col', text: this.columnLabel(topic.status) });
			row.createSpan({ cls: 'friday-analytics-aging-days', text: `${daysInColumn}d` });
		}
	}

	private columnLabel(status: string): string {
		switch (status) {
			case 'backlog': return 'Backlog';
			case 'open': return 'To Do';
			case 'in-progress': return 'In Progress';
			case 'done': return 'Done';
			default: return status;
		}
	}
}
