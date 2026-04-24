import { App, Modal } from 'obsidian';
import { MonthlyAnalyticsService, MonthlyStats } from '../services/monthlyAnalyticsService';
import { MonthlyNoteService } from '../services/monthlyNoteService';
import { MonthlySnapshot, PluginSettings } from '../types';
import { TaskStore } from '../services/taskStore';
import { formatMonthDisplay, formatMonthIdDisplay } from '../utils/monthUtils';

export class MonthlyReviewModal extends Modal {
	private stats: MonthlyStats;
	private reflectionsText: string = '';

	constructor(
		app: App,
		private monthlyAnalytics: MonthlyAnalyticsService,
		private monthlyNotes: MonthlyNoteService,
		_store: TaskStore,
		_settings: PluginSettings,
		private monthlyHistory: MonthlySnapshot[],
		private onSaveSnapshot: (snapshot: MonthlySnapshot) => void,
	) {
		super(app);
		this.stats = this.monthlyAnalytics.getCurrentMonthStats();
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		this.modalEl.addClass('task-bujo-weekly-review-modal');

		const now = new Date();
		contentEl.createEl('h2', { text: `Monthly Review — ${formatMonthDisplay(now)}` });

		// Summary stats
		const summarySection = contentEl.createDiv({ cls: 'task-bujo-review-summary' });

		const summaryItems: { label: string; value: string }[] = [
			{ label: 'Tasks Planned', value: String(this.stats.totalPlanned) },
			{ label: 'Completed', value: String(this.stats.totalCompleted) },
			{ label: 'Migrated', value: String(this.stats.totalMigrated) },
			{ label: 'Cancelled', value: String(this.stats.totalCancelled) },
			{ label: 'Completion Rate', value: `${this.stats.completionRate.toFixed(0)}%` },
		];

		for (const item of summaryItems) {
			const row = summarySection.createDiv({ cls: 'task-bujo-review-stat' });
			row.createSpan({ cls: 'task-bujo-review-stat-label', text: item.label });
			row.createSpan({ cls: 'task-bujo-review-stat-value', text: item.value });
		}

		// Reflections textarea
		await this.renderReflections(contentEl);

		// Recent months comparison
		if (this.monthlyHistory.length > 0) {
			this.renderComparison(contentEl);
		}

		// Actions
		const actions = contentEl.createDiv({ cls: 'task-bujo-review-actions' });

		const saveBtn = actions.createEl('button', {
			cls: 'mod-cta',
			text: 'Save Snapshot & Close',
		});
		saveBtn.addEventListener('click', async () => {
			await this.monthlyNotes.writeReflections(new Date(), this.reflectionsText);
			const snapshot = this.monthlyAnalytics.createSnapshot(this.stats, this.reflectionsText);
			this.onSaveSnapshot(snapshot);
			this.close();
		});

		const closeBtn = actions.createEl('button', { text: 'Close' });
		closeBtn.addEventListener('click', () => this.close());
	}

	private async renderReflections(container: HTMLElement): Promise<void> {
		const section = container.createDiv({ cls: 'task-bujo-monthly-reflections-section' });
		section.createEl('h3', { text: 'Reflections' });
		section.createEl('p', {
			text: 'What went well? What could be improved? What to focus on next month?',
			cls: 'task-bujo-text-muted',
		});

		this.reflectionsText = await this.monthlyNotes.readReflections(new Date());

		const textarea = section.createEl('textarea', {
			cls: 'task-bujo-monthly-reflections-textarea',
			placeholder: 'Write your reflections here...',
		});
		textarea.value = this.reflectionsText;
		textarea.rows = 6;
		textarea.addEventListener('input', () => {
			this.reflectionsText = textarea.value;
		});
	}

	private renderComparison(container: HTMLElement): void {
		const section = container.createDiv({ cls: 'task-bujo-review-comparison' });
		section.createEl('h3', { text: 'Recent Months' });

		const recent = this.monthlyHistory.slice(-4);
		for (const snap of recent) {
			const rate = snap.totalPlanned > 0
				? ((snap.totalCompleted / snap.totalPlanned) * 100).toFixed(0)
				: '0';
			const row = section.createDiv({ cls: 'task-bujo-review-comparison-row' });
			row.createSpan({ text: formatMonthIdDisplay(snap.monthId) });
			row.createSpan({ text: `${snap.totalCompleted}/${snap.totalPlanned} (${rate}%)` });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
