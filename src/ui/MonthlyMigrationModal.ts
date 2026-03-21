import { App, Modal } from 'obsidian';
import { TaskItem, TaskStatus, Priority } from '../types';
import {
	MonthlyMigrationService,
	MonthlyMigrationAction,
	MonthlyMigrationDecision,
	MonthlyMigrationResult,
	MonthlyReviewData,
} from '../services/monthlyMigrationService';
import { TaskStore } from '../services/taskStore';
import { formatMonthIdDisplay } from '../utils/monthUtils';
import { formatDateDisplay, isOverdue } from '../utils/dateUtils';
import { createPriorityDot, createDueBadge } from './icons';

export class MonthlyMigrationModal extends Modal {
	private decisions: Map<string, MonthlyMigrationDecision> = new Map();
	private summaryEl: HTMLElement | null = null;

	constructor(
		app: App,
		private migrationService: MonthlyMigrationService,
		private store: TaskStore,
		private reviewData: MonthlyReviewData,
		private onComplete: (result: MonthlyMigrationResult | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('task-bujo-migration-modal');
		const { contentEl } = this;
		contentEl.empty();

		const monthDisplay = formatMonthIdDisplay(this.reviewData.lastMonthId);
		contentEl.createEl('h2', { text: `Monthly Migration — ${monthDisplay}` });

		const { incompleteGoals } = this.reviewData;

		if (incompleteGoals.length === 0) {
			contentEl.createEl('p', {
				text: 'No incomplete goals from last month. All clear!',
				cls: 'task-bujo-empty',
			});
			this.renderCloseButton(contentEl);
			return;
		}

		contentEl.createEl('p', {
			text: `You have ${incompleteGoals.length} incomplete goal${incompleteGoals.length > 1 ? 's' : ''} from last month. Choose what to do with each:`,
			cls: 'task-bujo-migration-intro',
		});

		// Set default action for all goals
		for (const goal of incompleteGoals) {
			this.decisions.set(goal.id, { goal, action: 'forward-all' });
		}

		// Render each goal
		for (const goal of incompleteGoals) {
			this.renderGoalItem(contentEl, goal);
		}

		// Summary bar
		this.summaryEl = contentEl.createDiv({ cls: 'task-bujo-migration-summary' });
		this.updateSummary();

		// Action buttons
		const actions = contentEl.createDiv({ cls: 'task-bujo-migration-actions' });

		const applyBtn = actions.createEl('button', { text: 'Apply', cls: 'mod-cta' });
		applyBtn.addEventListener('click', async () => {
			applyBtn.setAttribute('disabled', 'true');
			applyBtn.textContent = 'Applying...';
			const decisions = Array.from(this.decisions.values());
			const result = await this.migrationService.executeMigrations(decisions);
			this.onComplete(result);
			this.close();
		});

		const cancelBtn = actions.createEl('button', { text: 'Skip', cls: 'task-bujo-btn' });
		cancelBtn.addEventListener('click', () => {
			this.onComplete(null);
			this.close();
		});
	}

	private renderGoalItem(container: HTMLElement, goal: TaskItem): void {
		const wrapper = container.createDiv({ cls: 'task-bujo-monthly-migration-item' });

		// Goal header row
		const headerRow = wrapper.createDiv({ cls: 'task-bujo-monthly-migration-goal-header' });

		// Priority dot
		if (goal.priority !== Priority.None) {
			headerRow.appendChild(createPriorityDot(goal.priority));
		}

		// Goal text
		headerRow.createSpan({ cls: 'task-bujo-task-text', text: goal.text });

		// Due badge
		if (goal.dueDate) {
			const overdue = isOverdue(goal.dueDate);
			headerRow.appendChild(createDueBadge(formatDateDisplay(goal.dueDate), overdue));
		}

		// Sub-tasks preview
		const children = goal.childrenIds
			.map(id => this.store.getTaskById(id))
			.filter((c): c is TaskItem => c !== undefined);

		if (children.length > 0) {
			const openCount = children.filter(c => c.status === TaskStatus.Open).length;
			const doneCount = children.filter(c => c.status === TaskStatus.Done).length;

			const subtaskInfo = wrapper.createDiv({ cls: 'task-bujo-monthly-migration-subtasks' });
			subtaskInfo.createSpan({
				text: `Sub-tasks: ${doneCount} done, ${openCount} open of ${children.length} total`,
				cls: 'task-bujo-text-muted',
			});

			// Show individual sub-tasks
			const subtaskList = wrapper.createDiv({ cls: 'task-bujo-monthly-migration-subtask-list' });
			for (const child of children) {
				const row = subtaskList.createDiv({ cls: 'task-bujo-monthly-migration-subtask-row' });
				const statusChar = child.status === TaskStatus.Done ? '✓' : child.status === TaskStatus.Cancelled ? '—' : '○';
				const statusCls = child.status === TaskStatus.Done ? 'task-bujo-task-done' : '';
				row.createSpan({ text: statusChar, cls: 'task-bujo-monthly-migration-subtask-status' });
				row.createSpan({ text: child.text, cls: `task-bujo-monthly-migration-subtask-text ${statusCls}` });
			}
		}

		// Action buttons
		const actionsRow = wrapper.createDiv({ cls: 'task-bujo-monthly-migration-actions-row' });

		const actions: { action: MonthlyMigrationAction; label: string; cls: string }[] = [
			{ action: 'forward-all', label: 'Forward All', cls: 'task-bujo-btn task-bujo-btn-primary' },
			{ action: 'forward-goal-only', label: 'Fresh Start', cls: 'task-bujo-btn' },
			{ action: 'done', label: 'Done', cls: 'task-bujo-btn' },
			{ action: 'cancel', label: 'Cancel', cls: 'task-bujo-btn task-bujo-btn-warning' },
		];

		for (const { action, label, cls } of actions) {
			const btn = actionsRow.createEl('button', { text: label, cls });
			if (action === 'forward-all') btn.addClass('is-active');

			btn.addEventListener('click', () => {
				this.decisions.set(goal.id, { goal, action });
				// Update button active states
				actionsRow.querySelectorAll('button').forEach(b => b.removeClass('is-active'));
				btn.addClass('is-active');
				this.updateSummary();
			});
		}
	}

	private updateSummary(): void {
		if (!this.summaryEl) return;
		this.summaryEl.empty();

		let forwardAll = 0;
		let forwardGoalOnly = 0;
		let done = 0;
		let cancel = 0;

		for (const d of this.decisions.values()) {
			switch (d.action) {
				case 'forward-all': forwardAll++; break;
				case 'forward-goal-only': forwardGoalOnly++; break;
				case 'done': done++; break;
				case 'cancel': cancel++; break;
			}
		}

		const parts: string[] = [];
		if (forwardAll > 0) parts.push(`${forwardAll} forward`);
		if (forwardGoalOnly > 0) parts.push(`${forwardGoalOnly} fresh start`);
		if (done > 0) parts.push(`${done} done`);
		if (cancel > 0) parts.push(`${cancel} cancel`);

		this.summaryEl.textContent = parts.join(' · ');
	}

	private renderCloseButton(container: HTMLElement): void {
		const actions = container.createDiv({ cls: 'task-bujo-migration-actions' });
		const closeBtn = actions.createEl('button', { text: 'Close', cls: 'mod-cta' });
		closeBtn.addEventListener('click', () => {
			this.onComplete(null);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
