import { App, TFile } from 'obsidian';
import { PluginSettings } from '../../types';
import { formatDateISO } from '../../utils/dateUtils';
import { buildTaskLine } from '../InsertTaskModal';

export interface AddTaskBarCallbacks {
	onTaskAdded: () => void;
}

type TargetHeading = 'tasks' | 'inbox';

export class AddTaskBar {
	private el: HTMLElement;
	private target: TargetHeading;

	constructor(
		container: HTMLElement,
		private app: App,
		private getSettings: () => PluginSettings,
		private callbacks: AddTaskBarCallbacks
	) {
		this.el = container.createDiv({ cls: 'friday-add-bar' });
		this.target = this.getSettings().defaultQuickAddTarget ?? 'tasks';
		this.render();
	}

	private render(): void {
		this.el.empty();
		const form = this.el.createDiv({ cls: 'friday-add-form' });

		// Target toggle — Tasks vs Inbox. Inbox mode strips priority/date so capture
		// stays frictionless; triage happens later from the Inbox view.
		const targetToggle = form.createEl('button', {
			cls: 'friday-add-target-toggle',
			text: this.target === 'inbox' ? '\u{1F4E5} Inbox' : '\u2713 Tasks',
		});
		targetToggle.setAttribute('title', 'Toggle between Tasks and Inbox');
		targetToggle.addEventListener('click', (e) => {
			e.preventDefault();
			this.target = this.target === 'inbox' ? 'tasks' : 'inbox';
			this.render();
		});

		const textInput = form.createEl('input', {
			type: 'text',
			placeholder: this.target === 'inbox' ? 'Quick capture note...' : 'Quick add task...',
			cls: 'friday-add-input',
		});

		// Priority + date only show up for the Tasks target — Inbox is intentionally minimal.
		let prioritySelect: HTMLSelectElement | null = null;
		let dateInput: HTMLInputElement | null = null;
		if (this.target === 'tasks') {
			prioritySelect = form.createEl('select', { cls: 'friday-add-priority' });
			const options: [string, string][] = [
				['none', '—'],
				['high', 'H'],
				['medium', 'M'],
				['low', 'L'],
			];
			for (const [val, label] of options) {
				prioritySelect.createEl('option', { value: val, text: label });
			}

			dateInput = form.createEl('input', {
				type: 'text',
				placeholder: 'DD-MM-YYYY',
				cls: 'friday-add-date',
			});
		}

		const addBtn = form.createEl('button', {
			text: this.target === 'inbox' ? 'Capture' : '+ Add',
			cls: 'friday-add-btn',
		});

		const doAdd = async () => {
			const text = textInput.value.trim();
			if (!text) return;

			const line = this.target === 'inbox'
				? `- [ ] ${text}`
				: buildTaskLine(text, prioritySelect?.value ?? 'none', dateInput?.value.trim() ?? '');

			await this.appendToDaily(line);

			textInput.value = '';
			if (dateInput) dateInput.value = '';
			if (prioritySelect) prioritySelect.value = 'none';
			textInput.focus();
			this.callbacks.onTaskAdded();
		};

		addBtn.addEventListener('click', doAdd);
		textInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') doAdd();
		});
	}

	/** Append a task line to today's daily note under the selected target heading. */
	private async appendToDaily(taskLine: string): Promise<void> {
		const settings = this.getSettings();
		const today = new Date();
		const dateStr = formatDateISO(today);
		const filePath = `${settings.dailyNotePath}/${dateStr}.md`;

		const existing = this.app.vault.getAbstractFileByPath(filePath);
		if (existing && existing instanceof TFile) {
			let content = await this.app.vault.read(existing);
			let insertPos = this.findHeadingSection(content, this.target);
			if (insertPos === -1) {
				// Heading missing — append one before writing the line so future adds land there.
				content = this.appendHeading(content, this.target);
				insertPos = this.findHeadingSection(content, this.target);
			}
			if (insertPos !== -1) {
				const updated = content.slice(0, insertPos) + taskLine + '\n' + content.slice(insertPos);
				await this.app.vault.modify(existing, updated);
			} else {
				await this.app.vault.modify(existing, content + '\n' + taskLine + '\n');
			}
		} else {
			const folderPath = settings.dailyNotePath;
			if (!this.app.vault.getAbstractFileByPath(folderPath)) {
				try { await this.app.vault.createFolder(folderPath); } catch { /* exists */ }
			}
			// New daily notes always seed both Inbox and Tasks headings so either target works.
			const template =
				`# Daily Log — ${dateStr}\n\n## Inbox\n\n${this.target === 'inbox' ? taskLine + '\n\n' : ''}## Tasks\n\n${this.target === 'tasks' ? taskLine + '\n\n' : ''}## Migrated Tasks\n`;
			await this.app.vault.create(filePath, template);
		}
	}

	/** Find insertion point after the requested heading. Returns index or -1. */
	private findHeadingSection(content: string, target: TargetHeading): number {
		const candidates = target === 'inbox'
			? ['## Inbox', '## Triage']
			: ['## Tasks', '## New Tasks', '## TODO'];
		for (const h of candidates) {
			const idx = content.indexOf(h);
			if (idx !== -1) {
				const lineEnd = content.indexOf('\n', idx);
				if (lineEnd !== -1) {
					let pos = lineEnd + 1;
					while (pos < content.length && content[pos] === '\n') pos++;
					return pos;
				}
			}
		}
		return -1;
	}

	/** Append a `## Inbox` or `## Tasks` heading block at the end of the content. */
	private appendHeading(content: string, target: TargetHeading): string {
		const heading = target === 'inbox' ? '## Inbox' : '## Tasks';
		const needsNewline = content.endsWith('\n') ? '' : '\n';
		return content + needsNewline + '\n' + heading + '\n\n';
	}

	getElement(): HTMLElement {
		return this.el;
	}
}
