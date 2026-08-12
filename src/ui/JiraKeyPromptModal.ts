import { App, Modal, Setting } from 'obsidian';

/**
 * Small prompt that asks for a JIRA issue key and then runs an async action with it
 * (fetch the issue + open the pre-filled topic editor). Kept generic: the caller passes
 * `onSubmit`, which returns an error message to show inline, or `null` on success (which
 * closes the modal). The button shows a busy state while the action runs.
 */
export class JiraKeyPromptModal extends Modal {
	private key = '';
	private busy = false;

	constructor(app: App, private onSubmit: (rawKey: string) => Promise<string | null>) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'Create topic from JIRA issue' });
		contentEl.createEl('p', {
			cls: 'friday-jira-prompt-desc',
			text: 'Enter one or more issue keys (comma- or space-separated). Each becomes a topic filled from the issue — summary, priority, due date, planned start, assignee, and description — and linked to it. A single key opens the new note; keys already linked to a topic are skipped.',
		});

		const errorEl = contentEl.createDiv({ cls: 'friday-modal-error' });
		let submitBtn: HTMLButtonElement;

		const setBusy = (busy: boolean): void => {
			this.busy = busy;
			submitBtn.disabled = busy;
			submitBtn.setText(busy ? 'Fetching…' : 'Fetch & create');
		};

		const run = async (): Promise<void> => {
			if (this.busy) return;
			const raw = this.key.trim();
			errorEl.empty();
			if (!raw) { errorEl.setText('Enter an issue key, e.g. PROJ-123.'); return; }
			setBusy(true);
			let err: string | null;
			try {
				err = await this.onSubmit(raw);
			} catch (e) {
				err = e instanceof Error ? e.message : 'Unexpected error fetching the issue.';
			}
			if (err) { errorEl.setText(err); setBusy(false); return; }
			this.close(); // success — the caller has opened the next step
		};

		new Setting(contentEl)
			.setName('JIRA issue key(s)')
			.addText(text => {
				text.setPlaceholder('PROJ-123, PROJ-124').onChange(v => { this.key = v; });
				text.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') { e.preventDefault(); void run(); }
				});
				setTimeout(() => text.inputEl.focus(), 50);
			});

		new Setting(contentEl).addButton(btn => {
			submitBtn = btn.buttonEl;
			btn.setButtonText('Fetch & create').setCta().onClick(() => void run());
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
