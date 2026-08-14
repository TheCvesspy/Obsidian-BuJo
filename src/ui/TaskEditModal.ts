import { App, Modal, Setting, Notice } from 'obsidian';
import { TaskItem, TaskStatus, Priority, PluginSettings } from '../types';
import { TaskFieldEdits } from '../services/taskWriter';
import { formatDateISO, isoToPluginDate } from '../utils/dateUtils';
import { TYPE_TAG_REGEX, WORK_TYPE_REGEX, PURPOSE_REGEX } from '../constants';

const STATUS_OPTIONS: [TaskStatus, string][] = [
	[TaskStatus.Open, 'Open'],
	[TaskStatus.Done, 'Done'],
	[TaskStatus.Cancelled, 'Cancelled'],
	[TaskStatus.Migrated, 'Migrated'],
	[TaskStatus.Scheduled, 'Scheduled'],
];

/**
 * Full task settings dialog (v3). Every field of a task — text, status, priority,
 * due, snooze, someday, type, work type, purpose, description — editable in one place.
 * Saves a *diff*: only fields the user actually changed are passed on, so untouched
 * tokens (raw natural-language dates, `(from [[…]])`, `@done`, trailing `[[Topic]]`)
 * survive verbatim through TaskWriter.updateTaskFields.
 */
export class TaskEditModal extends Modal {
	// Current form state
	private text: string;
	private status: TaskStatus;
	private priority: string;
	private dueIso: string;
	private snoozeIso: string;
	private someday: boolean;
	private typeTag: string;
	private workType: string;
	private purpose: string;
	private description: string;

	// Initial values for diffing
	private readonly init: {
		text: string; status: TaskStatus; priority: string; dueIso: string; snoozeIso: string;
		someday: boolean; typeTag: string; workType: string; purpose: string; description: string;
	};

	constructor(
		app: App,
		private task: TaskItem,
		private settings: PluginSettings,
		private onSubmit: (edits: TaskFieldEdits) => void,
	) {
		super(app);

		// Token-level initials come from the raw line (workType/purpose on TaskItem are
		// resolved display names, not the codes the dropdowns are keyed by).
		const rawType = task.rawLine.match(TYPE_TAG_REGEX)?.[1]?.toLowerCase() ?? '';
		const rawW = task.rawLine.match(WORK_TYPE_REGEX)?.[1] ?? '';
		const rawP = task.rawLine.match(PURPOSE_REGEX)?.[1] ?? '';
		const codeOf = (raw: string, cats: { name: string; shortCode: string }[]): string => {
			if (!raw) return '';
			const m = cats.find(c =>
				c.shortCode.toLowerCase() === raw.toLowerCase() || c.name.toLowerCase() === raw.toLowerCase());
			return m?.shortCode ?? '';
		};

		this.init = {
			text: task.text,
			status: task.status,
			priority: task.priority ?? Priority.None,
			dueIso: task.dueDate ? formatDateISO(task.dueDate) : '',
			snoozeIso: task.snoozeDate ? formatDateISO(task.snoozeDate) : '',
			someday: task.someday,
			typeTag: rawType,
			workType: codeOf(rawW, settings.workTypes),
			purpose: codeOf(rawP, settings.purposes),
			description: task.description ?? '',
		};
		Object.assign(this, this.init);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('friday-insert-modal');
		this.modalEl.addClass('friday-edit-modal');
		contentEl.createEl('h2', { text: 'Edit Task' });

		new Setting(contentEl)
			.setName('Task text')
			.addText(text => {
				text.setValue(this.text).onChange(v => { this.text = v; });
				text.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter' && !e.shiftKey) this.submit();
				});
			});

		new Setting(contentEl)
			.setName('Status')
			.addDropdown(dd => {
				for (const [value, label] of STATUS_OPTIONS) dd.addOption(value, label);
				dd.setValue(this.status).onChange(v => { this.status = v as TaskStatus; });
			});

		new Setting(contentEl)
			.setName('Priority')
			.addDropdown(dd => dd
				.addOptions({ none: 'None', high: 'High', medium: 'Medium', low: 'Low' })
				.setValue(this.priority)
				.onChange(v => { this.priority = v; })
			);

		const dueSetting = new Setting(contentEl).setName('Due date');
		if (this.task.dueDateRaw && !this.init.dueIso) {
			dueSetting.setDesc(`Currently "@due ${this.task.dueDateRaw}" (unresolved) — picking a date replaces it.`);
		}
		dueSetting.addText(text => {
			text.inputEl.type = 'date';
			text.inputEl.value = this.dueIso;
			text.onChange(v => { this.dueIso = v; });
		});

		const snoozeSetting = new Setting(contentEl)
			.setName('Snooze until')
			.setDesc('Hides the task from Today/Overdue until this date. Empty = not snoozed.');
		snoozeSetting.addText(text => {
			text.inputEl.type = 'date';
			text.inputEl.value = this.snoozeIso;
			text.onChange(v => { this.snoozeIso = v; });
		});

		new Setting(contentEl)
			.setName('Someday')
			.setDesc('Dateless backlog — turning this on clears due & snooze on save.')
			.addToggle(t => t.setValue(this.someday).onChange(v => { this.someday = v; }));

		new Setting(contentEl)
			.setName('Type')
			.addDropdown(dd => dd
				.addOptions({ '': 'Auto (from heading)', 'task': 'Task', 'openpoint': 'Open Point' })
				.setValue(this.typeTag)
				.onChange(v => { this.typeTag = v; })
			);

		if (this.settings.workTypes.length > 0) {
			new Setting(contentEl)
				.setName('Work type')
				.addDropdown(dd => {
					const options: Record<string, string> = { '': 'None' };
					for (const wt of this.settings.workTypes) options[wt.shortCode] = `${wt.name} (${wt.shortCode})`;
					dd.addOptions(options).setValue(this.workType).onChange(v => { this.workType = v; });
				});
		}

		if (this.settings.purposes.length > 0) {
			new Setting(contentEl)
				.setName('Purpose')
				.addDropdown(dd => {
					const options: Record<string, string> = { '': 'None' };
					for (const p of this.settings.purposes) options[p.shortCode] = `${p.name} (${p.shortCode})`;
					dd.addOptions(options).setValue(this.purpose).onChange(v => { this.purpose = v; });
				});
		}

		const descSetting = new Setting(contentEl)
			.setName('Description')
			.setDesc('Indented lines below the task. Subtasks are not affected.');
		const descArea = descSetting.controlEl.createEl('textarea', {
			cls: 'friday-insert-description',
			attr: { rows: '3', placeholder: 'Additional context, notes, links...' },
		});
		descArea.value = this.description;
		descArea.addEventListener('input', () => { this.description = descArea.value; });

		const buttons = new Setting(contentEl);
		buttons.addButton(btn => btn
			.setButtonText('Save')
			.setCta()
			.onClick(() => this.submit())
		);
		buttons.addButton(btn => btn
			.setButtonText('Cancel')
			.onClick(() => this.close())
		);
	}

	/** Convert an ISO date-input value to the write format the settings dictate. */
	private toWriteFormat(iso: string): string {
		return this.settings.dateFormat === 'dmy' ? isoToPluginDate(iso) : iso;
	}

	private submit(): void {
		if (!this.text.trim()) {
			new Notice('Task text cannot be empty.');
			return;
		}

		// Diff against initial values — only changed fields are written.
		const edits: TaskFieldEdits = {};
		if (this.text.trim() !== this.init.text) edits.text = this.text;
		if (this.status !== this.init.status) edits.status = this.status;
		if (this.priority !== this.init.priority) edits.priority = this.priority;
		if (this.dueIso !== this.init.dueIso) {
			edits.dueDateRaw = this.dueIso ? this.toWriteFormat(this.dueIso) : null;
		}
		if (this.snoozeIso !== this.init.snoozeIso) {
			edits.snoozeDateRaw = this.snoozeIso ? this.toWriteFormat(this.snoozeIso) : null;
		}
		if (this.someday !== this.init.someday) {
			edits.someday = this.someday;
			// The Someday contract (same as TaskWriter.setSomeday): a Someday task is dateless.
			if (this.someday) { edits.dueDateRaw = null; edits.snoozeDateRaw = null; }
		}
		if (this.typeTag !== this.init.typeTag) edits.typeTag = this.typeTag || null;
		if (this.workType !== this.init.workType) edits.workType = this.workType || null;
		if (this.purpose !== this.init.purpose) edits.purpose = this.purpose || null;
		if (this.description !== this.init.description) edits.description = this.description || null;

		this.onSubmit(edits);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
