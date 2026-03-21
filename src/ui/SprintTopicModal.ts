import { App, Modal, Setting, FuzzySuggestModal, TFile } from 'obsidian';
import { SprintTopic, Priority } from '../types';
import { SprintTopicService } from '../services/sprintTopicService';

/** Fuzzy file picker that returns the selected page name */
class PageSuggestModal extends FuzzySuggestModal<TFile> {
	private onChoose: (file: TFile) => void;

	constructor(app: App, onChoose: (file: TFile) => void) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder('Type to search vault pages...');
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(item: TFile): string {
		return item.path.replace(/\.md$/, '');
	}

	onChooseItem(item: TFile): void {
		this.onChoose(item);
	}
}

export class SprintTopicModal extends Modal {
	private title: string = '';
	private jira: string = '';
	private priority: Priority = Priority.None;
	private linkedPages: string[] = [];
	private chipsContainer: HTMLElement | null = null;

	constructor(
		app: App,
		private topicService: SprintTopicService,
		private sprintId: string,
		private onSave: (topic: SprintTopic) => void,
		private editTopic?: SprintTopic,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('task-bujo-topic-modal');

		if (this.editTopic) {
			this.title = this.editTopic.title;
			this.jira = this.editTopic.jira ?? '';
			this.priority = this.editTopic.priority;
			this.linkedPages = [...this.editTopic.linkedPages];
		}

		contentEl.createEl('h2', {
			text: this.editTopic ? 'Edit Topic' : 'New Sprint Topic',
		});

		new Setting(contentEl)
			.setName('Title')
			.addText(text => {
				text.setPlaceholder('Topic title')
					.setValue(this.title)
					.onChange(value => { this.title = value; });
				text.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') this.save();
				});
				setTimeout(() => text.inputEl.focus(), 50);
			});

		new Setting(contentEl)
			.setName('JIRA Ticket')
			.setDesc('Optional JIRA ticket reference')
			.addText(text => text
				.setPlaceholder('PROJ-123')
				.setValue(this.jira)
				.onChange(value => { this.jira = value; })
			);

		new Setting(contentEl)
			.setName('Priority')
			.addDropdown(dropdown => dropdown
				.addOptions({
					[Priority.None]: 'None',
					[Priority.Low]: 'Low',
					[Priority.Medium]: 'Medium',
					[Priority.High]: 'High',
				})
				.setValue(this.priority)
				.onChange(value => { this.priority = value as Priority; })
			);

		// Linked Pages with autocomplete
		const linkedSetting = new Setting(contentEl)
			.setName('Linked Pages')
			.addButton(btn => btn
				.setButtonText('+ Add Page')
				.onClick(() => {
					new PageSuggestModal(this.app, (file) => {
						const pageName = file.path.replace(/\.md$/, '');
						if (!this.linkedPages.includes(pageName)) {
							this.linkedPages.push(pageName);
							this.renderChips();
						}
					}).open();
				})
			);

		this.chipsContainer = linkedSetting.settingEl.createDiv({ cls: 'task-bujo-page-chips' });
		this.renderChips();

		// Error display
		const errorEl = contentEl.createDiv({ cls: 'task-bujo-modal-error' });

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Save')
				.setCta()
				.onClick(async () => {
					errorEl.empty();
					if (!this.title.trim()) {
						errorEl.setText('Title is required.');
						return;
					}
					await this.save();
				})
			);
	}

	private async save(): Promise<void> {
		if (!this.title.trim()) return;

		if (this.editTopic) {
			await this.topicService.updateTopicFrontmatter(this.editTopic.filePath, {
				jira: this.jira || '',
				priority: this.priority === Priority.None ? 'none' : this.priority,
			});
			const updated: SprintTopic = {
				...this.editTopic,
				jira: this.jira || null,
				priority: this.priority,
				linkedPages: this.linkedPages,
			};
			this.onSave(updated);
		} else {
			const topic = await this.topicService.createTopic(
				this.title.trim(),
				this.jira.trim() || null,
				this.priority,
				this.linkedPages,
				this.sprintId,
			);
			this.onSave(topic);
		}
		this.close();
	}

	private renderChips(): void {
		if (!this.chipsContainer) return;
		this.chipsContainer.empty();

		if (this.linkedPages.length === 0) {
			this.chipsContainer.createSpan({
				cls: 'task-bujo-page-chips-empty',
				text: 'No pages linked yet',
			});
			return;
		}

		for (const page of this.linkedPages) {
			const chip = this.chipsContainer.createDiv({ cls: 'task-bujo-page-chip' });
			chip.createSpan({ text: page });
			const removeBtn = chip.createSpan({ cls: 'task-bujo-page-chip-remove', text: '\u00D7' });
			removeBtn.addEventListener('click', () => {
				this.linkedPages = this.linkedPages.filter(p => p !== page);
				this.renderChips();
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
