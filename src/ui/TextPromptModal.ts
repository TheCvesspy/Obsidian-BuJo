import { App, Modal, Setting } from 'obsidian';

/**
 * Minimal single-line text prompt. Submits the trimmed value via `onSubmit` and closes;
 * an empty value never submits. Used by "Add note to topic" — kept generic so future
 * one-line prompts (rename, quick fields) can reuse it.
 */
export class TextPromptModal extends Modal {
	private value = '';

	constructor(
		app: App,
		private titleText: string,
		private placeholder: string,
		private onSubmit: (text: string) => void,
		private submitLabel = 'Add',
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.titleText);

		const submit = (): void => {
			const text = this.value.trim();
			if (!text) return;
			this.onSubmit(text);
			this.close();
		};

		new Setting(this.contentEl).addText(text => {
			text.setPlaceholder(this.placeholder).onChange(v => { this.value = v; });
			text.inputEl.addClass('friday-text-prompt-input');
			text.inputEl.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					submit();
				}
			});
			setTimeout(() => text.inputEl.focus(), 50);
		});

		new Setting(this.contentEl).addButton(btn => btn
			.setButtonText(this.submitLabel)
			.setCta()
			.onClick(submit));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
