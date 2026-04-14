import { App, Modal } from 'obsidian';
import { Sprint, SprintTopic, SprintCloseAction, SprintCloseDecision, Priority } from '../types';
import { SprintService } from '../services/sprintService';
import { SprintTopicService } from '../services/sprintTopicService';

export class SprintCloseModal extends Modal {
	private decisions: Map<string, SprintCloseDecision> = new Map();
	private summaryEl: HTMLElement | null = null;

	constructor(
		app: App,
		private sprint: Sprint,
		private topics: SprintTopic[],
		private sprintService: SprintService,
		private topicService: SprintTopicService,
		private onComplete: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('task-bujo-sprint-close-modal');
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: `Close Sprint — ${this.sprint.name}` });

		// Filter to non-done topics only
		const openTopics = this.topics.filter(t => t.status !== 'done');

		if (openTopics.length === 0) {
			contentEl.createEl('p', {
				text: 'All topics are done. Sprint is ready to close!',
				cls: 'task-bujo-empty',
			});
			this.renderApplySection(contentEl, openTopics);
			return;
		}

		contentEl.createEl('p', {
			text: `${openTopics.length} topic${openTopics.length > 1 ? 's are' : ' is'} not yet done. Choose what to do with each:`,
			cls: 'task-bujo-migration-intro',
		});

		// Set default action for all open topics
		for (const topic of openTopics) {
			this.decisions.set(topic.filePath, { topic, action: 'carry-forward' });
		}

		// Render each topic
		for (const topic of openTopics) {
			this.renderTopicItem(contentEl, topic);
		}

		this.renderApplySection(contentEl, openTopics);
	}

	private renderTopicItem(container: HTMLElement, topic: SprintTopic): void {
		const item = container.createDiv({ cls: 'task-bujo-sprint-close-item' });

		// Header: priority dot + title + JIRA + blocked
		const headerRow = item.createDiv({ cls: 'task-bujo-sprint-close-item-header' });

		if (topic.priority !== Priority.None) {
			const dot = headerRow.createSpan({ cls: 'task-bujo-priority-dot' });
			dot.addClass(`task-bujo-priority-${topic.priority}`);
		}

		headerRow.createSpan({ text: topic.title });

		if (topic.jira.length > 0) {
			headerRow.createSpan({ cls: 'task-bujo-kanban-card-jira', text: ` ${topic.jira.join(', ')}` });
		}

		if (topic.blocked) {
			headerRow.createSpan({ cls: 'task-bujo-kanban-card-blocked', text: 'BLOCKED' });
		}

		// Task progress
		if (topic.taskTotal > 0) {
			item.createDiv({
				cls: 'task-bujo-sprint-close-item-progress',
				text: `${topic.taskDone}/${topic.taskTotal} tasks done`,
			});
		}

		// Action buttons
		const actionsRow = item.createDiv({ cls: 'task-bujo-sprint-close-actions-row' });

		const actions: { action: SprintCloseAction; label: string; cls: string }[] = [
			{ action: 'carry-forward', label: 'Carry Forward', cls: 'task-bujo-btn task-bujo-btn-forward' },
			{ action: 'archive', label: 'Archive', cls: 'task-bujo-btn task-bujo-btn-done' },
			{ action: 'cancel', label: 'Cancel', cls: 'task-bujo-btn task-bujo-btn-cancel' },
		];

		for (const { action, label, cls } of actions) {
			const btn = actionsRow.createEl('button', { text: label, cls });
			if (action === 'carry-forward') btn.addClass('is-active');

			btn.addEventListener('click', () => {
				this.decisions.set(topic.filePath, { topic, action });
				actionsRow.querySelectorAll('button').forEach(b => b.removeClass('is-active'));
				btn.addClass('is-active');
				this.updateSummary();
			});
		}
	}

	private renderApplySection(container: HTMLElement, openTopics: SprintTopic[]): void {
		// Summary bar
		if (openTopics.length > 0) {
			this.summaryEl = container.createDiv({ cls: 'task-bujo-sprint-close-summary' });
			this.updateSummary();
		}

		// Action buttons
		const actionsDiv = container.createDiv({ cls: 'task-bujo-migration-actions' });

		const applyBtn = actionsDiv.createEl('button', { text: 'Close Sprint', cls: 'mod-cta' });
		applyBtn.addEventListener('click', async () => {
			applyBtn.setAttribute('disabled', 'true');
			applyBtn.textContent = 'Closing...';
			await this.executeDecisions();
			this.onComplete();
			this.close();
		});

		const cancelBtn = actionsDiv.createEl('button', { text: 'Cancel', cls: 'task-bujo-btn' });
		cancelBtn.addEventListener('click', () => this.close());
	}

	private async executeDecisions(): Promise<void> {
		// Complete the sprint (may auto-create next one)
		const newSprint = await this.sprintService.completeSprint(this.sprint.id);
		const newSprintId = newSprint?.id ?? null;

		// Execute per-topic decisions
		for (const decision of this.decisions.values()) {
			switch (decision.action) {
				case 'carry-forward':
					if (newSprintId) {
						await this.topicService.carryForwardTopic(decision.topic.filePath, newSprintId);
					}
					break;
				case 'archive':
					await this.topicService.archiveTopic(decision.topic.filePath);
					break;
				case 'cancel':
					await this.topicService.cancelTopic(decision.topic.filePath);
					break;
			}
		}

		// Also archive all done topics (they're already done, just clear sprint)
		const doneTopics = this.topics.filter(t => t.status === 'done');
		for (const topic of doneTopics) {
			await this.topicService.archiveTopic(topic.filePath);
		}
	}

	private updateSummary(): void {
		if (!this.summaryEl) return;
		this.summaryEl.empty();

		let carryForward = 0;
		let archive = 0;
		let cancel = 0;

		for (const d of this.decisions.values()) {
			switch (d.action) {
				case 'carry-forward': carryForward++; break;
				case 'archive': archive++; break;
				case 'cancel': cancel++; break;
			}
		}

		const parts: string[] = [];
		if (carryForward > 0) parts.push(`${carryForward} carry forward`);
		if (archive > 0) parts.push(`${archive} archive`);
		if (cancel > 0) parts.push(`${cancel} cancel`);

		this.summaryEl.textContent = parts.join(' \u00B7 ');
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
