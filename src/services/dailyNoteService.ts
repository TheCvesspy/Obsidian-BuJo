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

	/** Find the path of the most recent daily note dated strictly before `today`.
	 *  Returns null if no prior daily note exists. Walks the configured
	 *  daily-notes folder and matches files named `YYYY-MM-DD.md`. */
	getMostRecentPriorDailyNotePath(today: Date): string | null {
		const settings = this.getSettings();
		const folder = this.vault.getAbstractFileByPath(settings.dailyNotePath);
		if (!(folder instanceof TFolder)) return null;

		const todayIso = formatDateISO(today);
		let bestIso: string | null = null;
		let bestPath: string | null = null;

		for (const child of folder.children) {
			if (!(child instanceof TFile)) continue;
			const m = child.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
			if (!m) continue;
			const iso = m[1];
			if (iso >= todayIso) continue;
			if (!bestIso || iso > bestIso) {
				bestIso = iso;
				bestPath = child.path;
			}
		}
		return bestPath;
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
		// v3: the daily note is a journal (capture + time log). `## Inbox` holds quick
		// captures (swept into Tasks.md), `## Tasks` holds tasks that genuinely live here.
		// The old `## Migrated Tasks` heading is gone — nothing writes to it since the
		// morning-shuffle was retired (tasks float by date now).
		const template = `# Daily Log — ${displayDate}, ${year}\n\n## Inbox\n\n## Tasks\n`;

		const file = await this.vault.create(path, template);
		return file;
	}

	/** Add a task to the daily note under ## Tasks heading.
	 *  Still used by the MCP `tasks_add_to_daily` tool and a couple of other
	 *  user-initiated capture paths. Morning migration no longer calls this —
	 *  it just stamps `@due today` on the source task instead. */
	async addTaskToDaily(task: TaskItem, date: Date): Promise<void> {
		const file = await this.getOrCreateDailyNote(date);
		const taskLine = this.buildTaskLine(task);
		await this.vault.process(file, content =>
			this.insertAfterHeading(content, '## Tasks', taskLine),
		);
	}

	// addMigratedTask / addMigratedTaskWithChildren removed (2026-06).
	// Forwarding from the morning review used to copy tasks into today's daily
	// note under `## Migrated Tasks`; that's now a no-op — the dashboard
	// aggregates from across the vault by due date. If you need the old behavior
	// back, restore from git history.

	/** Add a raw task line to the daily note under ## Tasks heading */
	async addRawTaskLine(taskLine: string, date: Date): Promise<void> {
		const file = await this.getOrCreateDailyNote(date);
		await this.vault.process(file, content =>
			this.insertAfterHeading(content, '## Tasks', taskLine),
		);
	}

	/** Add a raw task line to the daily note under ## Inbox heading.
	 *  If the heading is missing, it's created just above ## Tasks (or at the end). */
	async addRawInboxLine(taskLine: string, date: Date): Promise<void> {
		const file = await this.getOrCreateDailyNote(date);
		await this.vault.process(file, content => {
			let updated = content;
			if (updated.indexOf('## Inbox') === -1) {
				const tasksIdx = updated.indexOf('## Tasks');
				const block = '## Inbox\n\n';
				if (tasksIdx !== -1) {
					updated = updated.slice(0, tasksIdx) + block + updated.slice(tasksIdx);
				} else {
					updated = updated.trimEnd() + '\n\n' + block;
				}
			}
			return this.insertAfterHeading(updated, '## Inbox', taskLine);
		});
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
