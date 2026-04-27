import { App, Modal } from 'obsidian';

/** Textarea-style capture modal for the Inbox — no priority, no date, no tags.
 *  The caller gets the raw text and is responsible for formatting
 *  (e.g. prefixing `- [ ] ` so it lands as a triable checkbox).
 *  Shortcuts: Ctrl/Cmd+Enter to submit, Esc to cancel, Enter inserts a newline. */
export class QuickCaptureModal extends Modal {
	private text: string = '';

	constructor(app: App, private onSubmit: (text: string) => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('friday-quick-capture-modal');
		contentEl.createEl('h3', { text: 'Capture to Inbox' });

		const textarea = contentEl.createEl('textarea', {
			cls: 'friday-quick-capture-textarea',
			attr: {
				placeholder: 'e.g. follow up with architect about API versioning — details, links, whatever…',
				rows: '6',
			},
		});
		textarea.value = this.text;
		textarea.addEventListener('input', () => { this.text = textarea.value; });
		textarea.addEventListener('keydown', e => {
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				this.submit();
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				this.close();
			}
		});
		setTimeout(() => textarea.focus(), 50);

		const hint = contentEl.createDiv({ cls: 'friday-quick-capture-hint' });
		hint.setText('Ctrl+Enter to capture · Esc to cancel');

		const actions = contentEl.createDiv({ cls: 'friday-quick-capture-actions' });
		const saveBtn = actions.createEl('button', { text: 'Capture', cls: 'mod-cta' });
		saveBtn.addEventListener('click', () => this.submit());
		const cancelBtn = actions.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
	}

	private submit(): void {
		const trimmed = this.text.trim();
		if (!trimmed) return;
		this.onSubmit(trimmed);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
