import { App, Modal, Setting } from 'obsidian';
import { Priority, TagCategory } from '../types';
import { isoToPluginDate } from '../utils/dateUtils';

export interface InsertTaskResult {
	text: string;
	priority: string;
	dueDate: string;
	typeTag: string;
	workType: string;
	purpose: string;
	description: string;
}

export class InsertTaskModal extends Modal {
	private text = '';
	private priority: string = Priority.None;
	private dueDate = '';
	private typeTag = '';
	private workType = '';
	private purpose = '';
	private description = '';

	constructor(
		app: App,
		private onSubmit: (result: InsertTaskResult) => void,
		private workTypes: TagCategory[] = [],
		private purposes: TagCategory[] = [],
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('task-bujo-insert-modal');
		contentEl.createEl('h2', { text: 'Quick Create Task' });

		new Setting(contentEl)
			.setName('Task text')
			.addText(text => {
				text.setPlaceholder('What needs to be done?')
					.onChange(v => { this.text = v; });
				text.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter' && !e.shiftKey) this.submit();
				});
				// Auto-focus
				setTimeout(() => text.inputEl.focus(), 50);
			});

		// Row: Priority + Due date
		new Setting(contentEl)
			.setName('Priority')
			.addDropdown(dd => dd
				.addOptions({
					none: 'None',
					high: 'High',
					medium: 'Medium',
					low: 'Low',
				})
				.onChange(v => { this.priority = v; })
			);

		new Setting(contentEl)
			.setName('Due date')
			.addText(text => {
				text.inputEl.type = 'date';
				text.onChange(v => { this.dueDate = v ? isoToPluginDate(v) : ''; });
			});

		new Setting(contentEl)
			.setName('Type')
			.setDesc('Optional: classify this item')
			.addDropdown(dd => dd
				.addOptions({
					'': 'Auto (from heading)',
					'task': 'Task',
					'openpoint': 'Open Point',
				})
				.onChange(v => { this.typeTag = v; })
			);

		if (this.workTypes.length > 0) {
			new Setting(contentEl)
				.setName('Work type')
				.addDropdown(dd => {
					const options: Record<string, string> = { '': 'None' };
					for (const wt of this.workTypes) {
						options[wt.shortCode] = `${wt.name} (${wt.shortCode})`;
					}
					dd.addOptions(options).onChange(v => { this.workType = v; });
				});
		}

		if (this.purposes.length > 0) {
			new Setting(contentEl)
				.setName('Purpose')
				.addDropdown(dd => {
					const options: Record<string, string> = { '': 'None' };
					for (const p of this.purposes) {
						options[p.shortCode] = `${p.name} (${p.shortCode})`;
					}
					dd.addOptions(options).onChange(v => { this.purpose = v; });
				});
		}

		// Description textarea
		const descSetting = new Setting(contentEl)
			.setName('Description')
			.setDesc('Optional: additional details (will be indented below the task)');
		const descArea = descSetting.controlEl.createEl('textarea', {
			cls: 'task-bujo-insert-description',
			attr: { rows: '3', placeholder: 'Additional context, notes, links...' },
		});
		descArea.addEventListener('input', () => { this.description = descArea.value; });

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Create')
				.setCta()
				.onClick(() => this.submit())
			);
	}

	private submit(): void {
		if (!this.text.trim()) return;
		this.onSubmit({
			text: this.text.trim(),
			priority: this.priority,
			dueDate: this.dueDate.trim(),
			typeTag: this.typeTag,
			workType: this.workType,
			purpose: this.purpose,
			description: this.description.trim(),
		});
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Build a formatted task line from parts (without description) */
export function buildTaskLine(text: string, priority: string, dueDate: string, typeTag: string = '', workType: string = '', purpose: string = ''): string {
	const parts = [`- [ ] ${text}`];
	if (priority && priority !== 'none') parts.push(`#priority/${priority}`);
	if (dueDate) parts.push(`@due ${dueDate}`);
	if (typeTag) parts.push(`#type/${typeTag}`);
	if (workType) parts.push(`#w/${workType}`);
	if (purpose) parts.push(`#p/${purpose}`);
	return parts.join(' ');
}

/** Build a complete task block: task line + indented description lines */
export function buildTaskBlock(text: string, priority: string, dueDate: string, typeTag: string, workType: string, purpose: string, description: string): string {
	const taskLine = buildTaskLine(text, priority, dueDate, typeTag, workType, purpose);
	if (!description) return taskLine;

	const descLines = description.split('\n').map(line => `    ${line}`).join('\n');
	return taskLine + '\n' + descLines;
}
