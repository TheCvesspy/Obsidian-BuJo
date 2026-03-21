import { App, Modal, Setting } from 'obsidian';
import { isoToPluginDate, pluginDateToIso } from '../utils/dateUtils';

export class DueDateModal extends Modal {
	private value: string;
	private isoValue: string;

	constructor(
		app: App,
		currentDate: string,
		private onSubmit: (date: string) => void
	) {
		super(app);
		this.value = currentDate;
		this.isoValue = currentDate ? pluginDateToIso(currentDate) : '';
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('task-bujo-due-modal');
		contentEl.createEl('h3', { text: 'Set Due Date' });

		new Setting(contentEl)
			.setName('Due date')
			.addText(text => {
				text.inputEl.type = 'date';
				text.inputEl.value = this.isoValue;
				text.onChange(v => {
					this.value = v ? isoToPluginDate(v) : '';
				});
				text.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') {
						this.onSubmit(this.value.trim());
						this.close();
					}
				});
				setTimeout(() => text.inputEl.focus(), 50);
			});

		const btnContainer = new Setting(contentEl);
		btnContainer.addButton(btn => btn
			.setButtonText('Set')
			.setCta()
			.onClick(() => {
				this.onSubmit(this.value.trim());
				this.close();
			})
		);
		btnContainer.addButton(btn => btn
			.setButtonText('Remove')
			.onClick(() => {
				this.onSubmit('');
				this.close();
			})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
