import { App, Modal } from 'obsidian';
import { AnalyticsService, WeeklyStats } from '../services/analyticsService';
import { WeeklySnapshot, PluginSettings } from '../types';
import { formatWeekId } from '../utils/dateUtils';

export class WeeklyReviewModal extends Modal {
	private stats: WeeklyStats;

	constructor(
		app: App,
		private analyticsService: AnalyticsService,
		private settings: PluginSettings,
		private weeklyHistory: WeeklySnapshot[],
		private onSaveSnapshot: (snapshot: WeeklySnapshot) => void,
		precomputedStats?: WeeklyStats,
	) {
		super(app);
		this.stats = precomputedStats || this.analyticsService.getCurrentWeekStats();
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('friday-weekly-review-modal');

		contentEl.createEl('h2', { text: `Weekly Review — ${formatWeekId(this.stats.weekId)}` });

		// Summary section
		const summarySection = contentEl.createDiv({ cls: 'friday-review-summary' });

		const summaryItems: { label: string; value: string }[] = [
			{ label: 'Tasks Planned', value: String(this.stats.totalPlanned) },
			{ label: 'Completed', value: String(this.stats.totalCompleted) },
			{ label: 'Migrated', value: String(this.stats.totalMigrated) },
			{ label: 'Cancelled', value: String(this.stats.totalCancelled) },
			{ label: 'Completion Rate', value: `${this.stats.completionRate.toFixed(0)}%` },
		];

		for (const item of summaryItems) {
			const row = summarySection.createDiv({ cls: 'friday-review-stat' });
			row.createSpan({ cls: 'friday-review-stat-label', text: item.label });
			row.createSpan({ cls: 'friday-review-stat-value', text: item.value });
		}

		// Work type breakdown
		if (this.stats.workTypeBreakdown.size > 0) {
			this.renderBreakdownSection(contentEl, 'Work Type Breakdown', this.stats.workTypeBreakdown);
		}

		// Purpose breakdown
		if (this.stats.purposeBreakdown.size > 0) {
			this.renderBreakdownSection(contentEl, 'Purpose Breakdown', this.stats.purposeBreakdown);
		}

		// Previous weeks comparison (if any history)
		if (this.weeklyHistory.length > 0) {
			this.renderComparison(contentEl);
		}

		// Actions
		const actions = contentEl.createDiv({ cls: 'friday-review-actions' });

		const saveBtn = actions.createEl('button', {
			cls: 'mod-cta',
			text: 'Save Snapshot & Close',
		});
		saveBtn.addEventListener('click', () => {
			const snapshot = this.analyticsService.createSnapshot(this.stats);
			this.onSaveSnapshot(snapshot);
			this.close();
		});

		const closeBtn = actions.createEl('button', { text: 'Close' });
		closeBtn.addEventListener('click', () => this.close());
	}

	private renderBreakdownSection(
		container: HTMLElement,
		title: string,
		data: Map<string, { planned: number; completed: number }>,
	): void {
		const section = container.createDiv({ cls: 'friday-review-breakdown' });
		section.createEl('h3', { text: title });

		for (const [name, { planned, completed }] of data) {
			const row = section.createDiv({ cls: 'friday-review-breakdown-row' });
			row.createSpan({ cls: 'friday-review-breakdown-name', text: name });

			const barWrap = row.createDiv({ cls: 'friday-review-breakdown-bar-wrap' });
			const pct = planned > 0 ? (completed / planned) * 100 : 0;
			const bar = barWrap.createDiv({ cls: 'friday-review-breakdown-bar' });
			bar.style.width = `${pct}%`;

			row.createSpan({ cls: 'friday-review-breakdown-value', text: `${completed}/${planned}` });
		}
	}

	private renderComparison(container: HTMLElement): void {
		const section = container.createDiv({ cls: 'friday-review-comparison' });
		section.createEl('h3', { text: 'Recent Weeks' });

		const recent = this.weeklyHistory.slice(-4);
		for (const snap of recent) {
			const rate = snap.totalPlanned > 0
				? ((snap.totalCompleted / snap.totalPlanned) * 100).toFixed(0)
				: '0';
			const row = section.createDiv({ cls: 'friday-review-comparison-row' });
			row.createSpan({ text: formatWeekId(snap.weekId) });
			row.createSpan({ text: `${snap.totalCompleted}/${snap.totalPlanned} (${rate}%)` });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
