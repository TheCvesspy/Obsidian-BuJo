import { Vault, TFile, TFolder } from 'obsidian';
import { TaskItem, TaskStatus, PluginSettings, Priority } from '../types';
import { getMonthId, formatMonthDisplay } from '../utils/monthUtils';

export class MonthlyNoteService {
	constructor(private vault: Vault, private getSettings: () => PluginSettings) {}

	/** Get the file path for a monthly note */
	getMonthlyNotePath(date: Date): string {
		const settings = this.getSettings();
		return `${settings.monthlyNotePath}/${getMonthId(date)}.md`;
	}

	/** Get or create a monthly note file. Creates folders if needed. */
	async getOrCreateMonthlyNote(date: Date): Promise<TFile> {
		const path = this.getMonthlyNotePath(date);
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

		const displayDate = formatMonthDisplay(date);
		const template = `# Monthly Log — ${displayDate}\n\n## Goals\n\n## Tasks\n\n## Reflections\n`;

		const file = await this.vault.create(path, template);
		return file;
	}

	/** Add a migrated goal with its open sub-tasks to the monthly note under ## Goals */
	async addMigratedGoal(goal: TaskItem, openChildren: TaskItem[], date: Date): Promise<void> {
		const file = await this.getOrCreateMonthlyNote(date);
		const content = await this.vault.read(file);
		const goalLine = this.buildGoalLine(goal);
		const childLines = openChildren.map(child => '\t' + this.buildChildLine(child));
		const block = [goalLine, ...childLines].join('\n');
		const newContent = this.insertAfterHeading(content, '## Goals', block);
		await this.vault.modify(file, newContent);
	}

	/** Add a migrated goal without sub-tasks (fresh start) to the monthly note under ## Goals */
	async addMigratedGoalOnly(goal: TaskItem, date: Date): Promise<void> {
		const file = await this.getOrCreateMonthlyNote(date);
		const content = await this.vault.read(file);
		const goalLine = this.buildGoalLine(goal);
		const newContent = this.insertAfterHeading(content, '## Goals', goalLine);
		await this.vault.modify(file, newContent);
	}

	/** Read the reflections content from a monthly note */
	async readReflections(date: Date): Promise<string> {
		const path = this.getMonthlyNotePath(date);
		const file = this.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return '';

		const content = await this.vault.read(file);
		const headingStr = '## Reflections';
		const headingIndex = content.indexOf(headingStr);
		if (headingIndex === -1) return '';

		// Find start of content after heading
		let start = content.indexOf('\n', headingIndex);
		if (start === -1) return '';
		start += 1;

		// Find next heading or EOF
		const nextHeading = content.indexOf('\n## ', start);
		const end = nextHeading !== -1 ? nextHeading : content.length;

		return content.slice(start, end).trim();
	}

	/** Write reflections content to a monthly note under ## Reflections */
	async writeReflections(date: Date, text: string): Promise<void> {
		const file = await this.getOrCreateMonthlyNote(date);
		const content = await this.vault.read(file);
		const headingStr = '## Reflections';
		const headingIndex = content.indexOf(headingStr);

		if (headingIndex === -1) {
			// Append reflections section
			const newContent = content.trimEnd() + '\n\n## Reflections\n\n' + text + '\n';
			await this.vault.modify(file, newContent);
			return;
		}

		// Find the range to replace
		let start = content.indexOf('\n', headingIndex);
		if (start === -1) start = content.length;
		else start += 1;

		const nextHeading = content.indexOf('\n## ', start);
		const end = nextHeading !== -1 ? nextHeading : content.length;

		const newContent = content.slice(0, start) + '\n' + text + '\n' + content.slice(end);
		await this.vault.modify(file, newContent);
	}

	/** Insert a line after a heading, or append to end if heading not found */
	private insertAfterHeading(content: string, heading: string, line: string): string {
		const headingIndex = content.indexOf(heading);
		if (headingIndex !== -1) {
			let insertPos = content.indexOf('\n', headingIndex);
			if (insertPos === -1) insertPos = content.length;
			else insertPos += 1;
			// Skip blank lines after heading
			while (insertPos < content.length && content[insertPos] === '\n') insertPos++;
			return content.slice(0, insertPos) + line + '\n' + content.slice(insertPos);
		}
		return content.trimEnd() + '\n\n' + line + '\n';
	}

	private buildGoalLine(goal: TaskItem): string {
		let line = `- [ ] ${goal.text}`;

		if (goal.priority !== Priority.None) {
			line += ` #priority/${goal.priority}`;
		}

		if (goal.dueDateRaw) {
			line += ` @due ${goal.dueDateRaw}`;
		}

		// Add migration source annotation
		const originName = goal.migratedFrom ?? this.extractFileName(goal.sourcePath);
		line += ` (from [[${originName}]])`;

		return line;
	}

	private buildChildLine(task: TaskItem): string {
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
