import { Vault, TFile, TFolder } from 'obsidian';
import { TaskItem, TaskStatus, PluginSettings, Priority } from '../types';
import { formatDateDisplay, formatDateISO } from '../utils/dateUtils';

export class DailyNoteService {
	constructor(private vault: Vault, private getSettings: () => PluginSettings) {}

	/** Get the file path for a daily note */
	getDailyNotePath(date: Date): string {
		const settings = this.getSettings();
		return `${settings.dailyNotePath}/${formatDateISO(date)}.md`;
	}

	/** Get or create today's daily note file. Creates folders if needed. */
	async getOrCreateDailyNote(date: Date): Promise<TFile> {
		const path = this.getDailyNotePath(date);
		const existing = this.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			return existing;
		}

		// Ensure parent folders exist
		const folderPath = path.substring(0, path.lastIndexOf('/'));
		if (folderPath && !(this.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) {
			try {
				await this.vault.createFolder(folderPath);
			} catch {
				// Folder might already exist
			}
		}

		const displayDate = formatDateDisplay(date);
		const year = date.getFullYear();
		const template = `# Daily Log — ${displayDate}, ${year}\n\n## Tasks\n\n## Migrated Tasks\n`;

		const file = await this.vault.create(path, template);
		return file;
	}

	/** Add a task to the daily note under ## Tasks heading */
	async addTaskToDaily(task: TaskItem, date: Date): Promise<void> {
		const file = await this.getOrCreateDailyNote(date);
		const content = await this.vault.read(file);
		const taskLine = this.buildTaskLine(task);
		const newContent = this.insertAfterHeading(content, '## Tasks', taskLine);
		await this.vault.modify(file, newContent);
	}

	/** Add a migrated task to the daily note under ## Migrated Tasks heading */
	async addMigratedTask(task: TaskItem, date: Date): Promise<void> {
		const file = await this.getOrCreateDailyNote(date);
		const content = await this.vault.read(file);
		const taskLine = this.buildTaskLine(task);
		const newContent = this.insertAfterHeading(content, '## Migrated Tasks', taskLine);
		await this.vault.modify(file, newContent);
	}

	/** Add a migrated parent task with its children as a block under ## Migrated Tasks */
	async addMigratedTaskWithChildren(parent: TaskItem, children: TaskItem[], date: Date): Promise<void> {
		const file = await this.getOrCreateDailyNote(date);
		const content = await this.vault.read(file);
		const parentLine = this.buildTaskLine(parent);
		const childLines = children.map(child => '\t' + this.buildChildTaskLine(child));
		const block = [parentLine, ...childLines].join('\n');
		const newContent = this.insertAfterHeading(content, '## Migrated Tasks', block);
		await this.vault.modify(file, newContent);
	}

	/** Add a raw task line to the daily note under ## Tasks heading */
	async addRawTaskLine(taskLine: string, date: Date): Promise<void> {
		const file = await this.getOrCreateDailyNote(date);
		const content = await this.vault.read(file);
		const newContent = this.insertAfterHeading(content, '## Tasks', taskLine);
		await this.vault.modify(file, newContent);
	}

	/** Insert a line after a heading, or append to end if heading not found */
	private insertAfterHeading(content: string, heading: string, line: string): string {
		const headingIndex = content.indexOf(heading);
		if (headingIndex !== -1) {
			// Find end of heading line
			let insertPos = content.indexOf('\n', headingIndex);
			if (insertPos === -1) insertPos = content.length;
			else insertPos += 1;
			// Skip blank lines after heading
			while (insertPos < content.length && content[insertPos] === '\n') insertPos++;
			return content.slice(0, insertPos) + line + '\n' + content.slice(insertPos);
		}
		// Heading not found — append to end
		return content.trimEnd() + '\n\n' + line + '\n';
	}

	private buildTaskLine(task: TaskItem): string {
		let line = `- [ ] ${task.text}`;

		if (task.priority !== Priority.None) {
			line += ` #priority/${task.priority}`;
		}

		if (task.dueDateRaw) {
			line += ` @due ${task.dueDateRaw}`;
		}

		// Preserve original source across multi-hop migrations
		const originName = task.migratedFrom
			?? this.extractFileName(task.sourcePath);
		line += ` (from [[${originName}]])`;

		return line;
	}

	/** Build a task line for a child (no migration source annotation, preserves own status) */
	private buildChildTaskLine(task: TaskItem): string {
		const statusChar = task.status === TaskStatus.Done ? 'x' : task.status === TaskStatus.Cancelled ? '-' : ' ';
		let line = `- [${statusChar}] ${task.text}`;

		if (task.priority !== Priority.None) {
			line += ` #priority/${task.priority}`;
		}

		if (task.dueDateRaw) {
			line += ` @due ${task.dueDateRaw}`;
		}

		return line;
	}

	private extractFileName(sourcePath: string): string {
		const withExt = sourcePath.split('/').pop() ?? sourcePath;
		const dotIndex = withExt.lastIndexOf('.');
		return dotIndex !== -1 ? withExt.substring(0, dotIndex) : withExt;
	}
}
