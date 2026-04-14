import { App, Modal, Setting, FuzzySuggestModal, TFile } from 'obsidian';
import { SprintTopic, Priority, TopicImpact, TopicEffort } from '../types';
import { SprintTopicService } from '../services/sprintTopicService';
import { SprintService } from '../services/sprintService';

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
	private impact: TopicImpact | null = null;
	private effort: TopicEffort | null = null;
	private dueDate: string = '';
	/** '' = Backlog (no sprint assigned). Otherwise a sprint id. */
	private chosenSprintId: string = '';
	private chipsContainer: HTMLElement | null = null;

	constructor(
		app: App,
		private topicService: SprintTopicService,
		private sprintId: string,
		private onSave: (topic: SprintTopic) => void,
		private editTopic?: SprintTopic,
		private sprintService?: SprintService,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('task-bujo-topic-modal');

		if (this.editTopic) {
			this.title = this.editTopic.title;
			// Multiple JIRA keys are rendered back as a comma-separated string in the input
			this.jira = this.editTopic.jira.join(', ');
			this.priority = this.editTopic.priority;
			this.linkedPages = [...this.editTopic.linkedPages];
			this.impact = this.editTopic.impact;
			this.effort = this.editTopic.effort;
			this.dueDate = this.editTopic.dueDate ?? '';
			this.chosenSprintId = this.editTopic.sprintId ?? '';
		} else {
			// For new topics, default to the sprintId passed by the caller (may be '' for backlog).
			this.chosenSprintId = this.sprintId;
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
			.setName('JIRA Ticket(s)')
			.setDesc('Optional. One or more JIRA keys, comma-separated (e.g. PROJ-1, PROJ-2).')
			.addText(text => text
				.setPlaceholder('PROJ-123, PROJ-124')
				.setValue(this.jira)
				.onChange(value => { this.jira = value; })
			);

		// Sprint picker — lets users create backlog topics from any entry point,
		// and reassign existing topics between sprints (or back to backlog).
		if (this.sprintService) {
			const sprints = this.sprintService.getSprints();
			const options: Record<string, string> = { '': '(Backlog)' };
			for (const s of sprints) {
				const suffix = s.status === 'active' ? ' · active'
					: s.status === 'completed' ? ' · completed'
					: '';
				options[s.id] = `${s.name}${suffix}`;
			}
			new Setting(contentEl)
				.setName('Sprint')
				.setDesc('Assign to a sprint, or leave in Backlog')
				.addDropdown(dropdown => dropdown
					.addOptions(options)
					.setValue(this.chosenSprintId)
					.onChange(value => { this.chosenSprintId = value; })
				);

			// Sprint history — read-only list of sprints this topic has been part of.
			// Only shown in edit mode; new topics have no history yet.
			if (this.editTopic && this.editTopic.sprintHistory.length > 0) {
				const historySetting = new Setting(contentEl)
					.setName('Sprint history')
					.setDesc('All sprints this topic has been assigned to (in order)');
				const listEl = historySetting.settingEl.createDiv({ cls: 'task-bujo-topic-sprint-history' });
				for (const sprintId of this.editTopic.sprintHistory) {
					const sprint = sprints.find(s => s.id === sprintId);
					const label = sprint
						? `${sprint.name} (${sprint.startDate} → ${sprint.endDate})`
						: `${sprintId} · deleted`;
					const chip = listEl.createDiv({ cls: 'task-bujo-topic-sprint-history-chip' });
					chip.setText(label);
					if (sprintId === this.editTopic.sprintId) {
						chip.addClass('task-bujo-topic-sprint-history-current');
					}
				}
			}
		}

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

		new Setting(contentEl)
			.setName('Impact')
			.setDesc('Strategic impact — drives Impact/Effort and Eisenhower matrices')
			.addDropdown(dropdown => dropdown
				.addOptions({
					'': 'None',
					'critical': 'Critical',
					'high': 'High',
					'medium': 'Medium',
					'low': 'Low',
				})
				.setValue(this.impact ?? '')
				.onChange(value => { this.impact = (value || null) as TopicImpact | null; })
			);

		new Setting(contentEl)
			.setName('Effort')
			.setDesc('Size estimate — drives Impact/Effort matrix quadrant')
			.addDropdown(dropdown => dropdown
				.addOptions({
					'': 'None',
					'xs': 'XS',
					's': 'S',
					'm': 'M',
					'l': 'L',
					'xl': 'XL',
				})
				.setValue(this.effort ?? '')
				.onChange(value => { this.effort = (value || null) as TopicEffort | null; })
			);

		new Setting(contentEl)
			.setName('Due date')
			.setDesc('Optional — drives Eisenhower urgency')
			.addText(text => {
				text.inputEl.type = 'date';
				text.setValue(this.dueDate);
				text.onChange(value => { this.dueDate = value; });
			});

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

		const dueDateTrimmed = this.dueDate.trim();
		const dueDateValue = dueDateTrimmed && /^\d{4}-\d{2}-\d{2}$/.test(dueDateTrimmed) ? dueDateTrimmed : null;

		if (this.editTopic) {
			// Non-sprint fields go through updateTopicFrontmatter directly
			const fmUpdates: Record<string, string | null> = {
				jira: this.jira || '',
				priority: this.priority === Priority.None ? 'none' : this.priority,
				impact: this.impact,
				effort: this.effort,
				dueDate: dueDateValue,
			};
			await this.topicService.updateTopicFrontmatter(this.editTopic.filePath, fmUpdates);

			// Sprint changes must route through assignTopicToSprint so sprintHistory
			// is updated atomically (captures both the old and new sprint).
			let newHistory = this.editTopic.sprintHistory;
			const sprintChanged = this.sprintService
				&& this.chosenSprintId !== (this.editTopic.sprintId ?? '');
			if (sprintChanged) {
				await this.topicService.assignTopicToSprint(this.editTopic.filePath, this.chosenSprintId);
				// Mirror the service's merge logic for the in-memory SprintTopic returned to callers
				const seen = new Set(newHistory);
				const merged = [...newHistory];
				for (const s of [this.editTopic.sprintId ?? '', this.chosenSprintId]) {
					if (s && !seen.has(s)) { merged.push(s); seen.add(s); }
				}
				newHistory = merged;
			}

			// Parse the jira input into a deduplicated array of issue keys.
			// The input accepts comma-separated (or whitespace-separated) keys; the regex
			// matches the parser's behavior so this is round-trip-safe.
			const JIRA_KEY_RE = /[A-Z][A-Z0-9]+-\d+/g;
			const jiraKeys: string[] = [];
			const seenKeys = new Set<string>();
			let jm: RegExpExecArray | null;
			while ((jm = JIRA_KEY_RE.exec(this.jira)) !== null) {
				if (!seenKeys.has(jm[0])) {
					seenKeys.add(jm[0]);
					jiraKeys.push(jm[0]);
				}
			}

			const updated: SprintTopic = {
				...this.editTopic,
				jira: jiraKeys,
				priority: this.priority,
				linkedPages: this.linkedPages,
				impact: this.impact,
				effort: this.effort,
				dueDate: dueDateValue,
				sprintId: this.sprintService ? (this.chosenSprintId || null) : this.editTopic.sprintId,
				sprintHistory: newHistory,
			};
			this.onSave(updated);
		} else {
			const topic = await this.topicService.createTopic(
				this.title.trim(),
				this.jira.trim() || null,
				this.priority,
				this.linkedPages,
				this.chosenSprintId,
				this.impact,
				this.effort,
				dueDateValue,
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
