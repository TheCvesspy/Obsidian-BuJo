import { App, Modal } from 'obsidian';
import { TaskItem } from '../types';

export type SubtaskConfirmResult = 'all' | 'parent-only' | 'cancel';

/**
 * Modal shown when completing or cancelling a parent task that has open subtasks.
 * Asks whether to also complete/cancel the subtasks.
 */
export class SubtaskConfirmModal extends Modal {
	private result: SubtaskConfirmResult = 'cancel';
	private resolve: ((result: SubtaskConfirmResult) => void) | null = null;

	constructor(
		app: App,
		private task: TaskItem,
		private openChildCount: number,
		private actionLabel: string = 'Complete'
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('friday-confirm-modal');

		// Task name
		contentEl.createDiv({
			cls: 'friday-confirm-task-name',
			text: this.task.text,
		});

		// Message
		contentEl.createDiv({
			cls: 'friday-confirm-message',
			text: `This task has ${this.openChildCount} incomplete subtask${this.openChildCount !== 1 ? 's' : ''}. ${this.actionLabel} them too?`,
		});

		// Buttons
		const actions = contentEl.createDiv({ cls: 'friday-confirm-actions' });

		const cancelBtn = actions.createEl('button', {
			cls: 'friday-btn',
			text: 'Cancel',
		});
		cancelBtn.addEventListener('click', () => {
			this.result = 'cancel';
			this.close();
		});

		const parentOnlyBtn = actions.createEl('button', {
			cls: 'friday-btn',
			text: 'Parent Only',
		});
		parentOnlyBtn.addEventListener('click', () => {
			this.result = 'parent-only';
			this.close();
		});

		const allBtn = actions.createEl('button', {
			cls: 'friday-btn friday-btn-primary',
			text: `${this.actionLabel} All`,
		});
		allBtn.addEventListener('click', () => {
			this.result = 'all';
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		if (this.resolve) {
			this.resolve(this.result);
			this.resolve = null;
		}
	}

	/** Open modal and return the user's choice */
	waitForResult(): Promise<SubtaskConfirmResult> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}
}
