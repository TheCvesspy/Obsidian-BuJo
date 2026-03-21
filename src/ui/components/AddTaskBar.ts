import { App, TFile } from 'obsidian';
import { PluginSettings } from '../../types';
import { formatDateISO } from '../../utils/dateUtils';
import { buildTaskLine } from '../InsertTaskModal';

export interface AddTaskBarCallbacks {
	onTaskAdded: () => void;
}

export class AddTaskBar {
	private el: HTMLElement;

	constructor(
		container: HTMLElement,
		private app: App,
		private getSettings: () => PluginSettings,
		private callbacks: AddTaskBarCallbacks
	) {
		this.el = container.createDiv({ cls: 'task-bujo-add-bar' });
		this.render();
	}

	private render(): void {
		const form = this.el.createDiv({ cls: 'task-bujo-add-form' });

		const textInput = form.createEl('input', {
			type: 'text',
			placeholder: 'Quick add task...',
			cls: 'task-bujo-add-input',
		});

		const prioritySelect = form.createEl('select', { cls: 'task-bujo-add-priority' });
		const options: [string, string][] = [
			['none', '—'],
			['high', 'H'],
			['medium', 'M'],
			['low', 'L'],
		];
		for (const [val, label] of options) {
			prioritySelect.createEl('option', { value: val, text: label });
		}

		const dateInput = form.createEl('input', {
			type: 'text',
			placeholder: 'DD-MM-YYYY',
			cls: 'task-bujo-add-date',
		});

		const addBtn = form.createEl('button', {
			text: '+ Add',
			cls: 'task-bujo-add-btn',
		});

		const doAdd = async () => {
			const text = textInput.value.trim();
			if (!text) return;

			const priority = prioritySelect.value;
			const dueDate = dateInput.value.trim();
			const taskLine = buildTaskLine(text, priority, dueDate);

			await this.appendToDaily(taskLine);

			textInput.value = '';
			dateInput.value = '';
			prioritySelect.value = 'none';
			textInput.focus();
			this.callbacks.onTaskAdded();
		};

		addBtn.addEventListener('click', doAdd);
		textInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') doAdd();
		});
	}

	/** Append a task line to today's daily note */
	private async appendToDaily(taskLine: string): Promise<void> {
		const settings = this.getSettings();
		const today = new Date();
		const dateStr = formatDateISO(today);
		const filePath = `${settings.dailyNotePath}/${dateStr}.md`;

		const existing = this.app.vault.getAbstractFileByPath(filePath);
		if (existing && existing instanceof TFile) {
			const content = await this.app.vault.read(existing);
			// Try to insert under "## Tasks" or "## New Tasks"
			const insertAfterHeading = this.findTasksSection(content);
			if (insertAfterHeading !== -1) {
				const updated = content.slice(0, insertAfterHeading) +
					taskLine + '\n' +
					content.slice(insertAfterHeading);
				await this.app.vault.modify(existing, updated);
			} else {
				await this.app.vault.modify(existing, content + '\n' + taskLine + '\n');
			}
		} else {
			// Ensure folder exists
			const folderPath = settings.dailyNotePath;
			if (!this.app.vault.getAbstractFileByPath(folderPath)) {
				try { await this.app.vault.createFolder(folderPath); } catch { /* exists */ }
			}
			const template = `# Daily Log — ${dateStr}\n\n## Tasks\n\n${taskLine}\n\n## Migrated Tasks\n`;
			await this.app.vault.create(filePath, template);
		}
	}

	/** Find insertion point after a tasks heading. Returns index or -1. */
	private findTasksSection(content: string): number {
		const headings = ['## Tasks', '## New Tasks', '## TODO'];
		for (const h of headings) {
			const idx = content.indexOf(h);
			if (idx !== -1) {
				// Find end of heading line
				const lineEnd = content.indexOf('\n', idx);
				if (lineEnd !== -1) {
					// Skip any blank line after heading
					let pos = lineEnd + 1;
					while (pos < content.length && content[pos] === '\n') pos++;
					return pos;
				}
			}
		}
		return -1;
	}

	getElement(): HTMLElement {
		return this.el;
	}
}
