import { Vault, TFile, TFolder } from 'obsidian';
import { TaskItem, TaskStatus, PluginSettings } from '../types';
import { TaskStore } from './taskStore';

export interface ArchiveResult {
	archived: number;
	files: string[];
	skipped: number;
}

export class ArchiveService {
	constructor(
		private vault: Vault,
		private store: TaskStore,
		private getSettings: () => PluginSettings,
	) {}

	/**
	 * Archive all completed (Done + Cancelled) tasks from the vault.
	 * Moves task lines to archive files and removes them from source files.
	 * Tasks whose rawLine can no longer be located in the source (file edited
	 * since last scan) are counted under `skipped` and left in place.
	 */
	async archiveCompleted(): Promise<ArchiveResult> {
		const settings = this.getSettings();

		// Get all completed root tasks
		const allTasks = [
			...this.store.getTasks(),
			...this.store.getOpenPoints(),
			...this.store.getInbox(),
			...this.store.getUncategorized(),
		];

		const completedTasks = allTasks.filter(t =>
			t.status === TaskStatus.Done || t.status === TaskStatus.Cancelled,
		);

		if (completedTasks.length === 0) {
			return { archived: 0, files: [], skipped: 0 };
		}

		// Group tasks by archive file path
		const archiveGroups = new Map<string, TaskItem[]>();
		for (const task of completedTasks) {
			const archivePath = this.getArchivePath(task, settings);
			if (!archiveGroups.has(archivePath)) {
				archiveGroups.set(archivePath, []);
			}
			archiveGroups.get(archivePath)!.push(task);
		}

		// Group tasks by source file for removal
		const sourceGroups = new Map<string, TaskItem[]>();
		for (const task of completedTasks) {
			if (!sourceGroups.has(task.sourcePath)) {
				sourceGroups.set(task.sourcePath, []);
			}
			sourceGroups.get(task.sourcePath)!.push(task);
		}

		const touchedFiles = new Set<string>();
		let skipped = 0;

		// Write to archive files first — if anything goes wrong we prefer over-archiving
		// to data loss in the source file.
		for (const [archivePath, tasks] of archiveGroups) {
			await this.appendToArchive(archivePath, tasks);
			touchedFiles.add(archivePath);
		}

		// Remove archived lines from source files. Tasks whose rawLine can't be
		// re-located (file edited since scan) are left alone.
		for (const [sourcePath, tasks] of sourceGroups) {
			skipped += await this.removeFromSource(sourcePath, tasks);
		}

		return {
			archived: completedTasks.length - skipped,
			files: Array.from(touchedFiles),
			skipped,
		};
	}

	/** Resolve the archive file path for a task.
	 *  Month-grouped archives prefer in descending order:
	 *    1. the task's own due date,
	 *    2. the YYYY-MM-DD date embedded in a daily-note filename,
	 *    3. the source file's last-modified time,
	 *    4. current date (last resort — should be rare in practice). */
	private getArchivePath(task: TaskItem, settings: PluginSettings): string {
		const folder = settings.archiveFolderPath || 'BuJo/Archive';
		if (settings.archiveGroupBy === 'source') {
			const basename = task.sourcePath.replace(/\.md$/, '').split('/').pop() || 'misc';
			return `${folder}/${basename}.md`;
		}
		const date = task.dueDate
			?? this.inferDateFromSourcePath(task.sourcePath)
			?? this.inferDateFromMtime(task.sourcePath)
			?? new Date();
		const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
		return `${folder}/${month}.md`;
	}

	private inferDateFromSourcePath(sourcePath: string): Date | null {
		const match = sourcePath.match(/(\d{4})-(\d{2})-(\d{2})\.md$/);
		if (!match) return null;
		const year = Number(match[1]);
		const month = Number(match[2]);
		const day = Number(match[3]);
		const d = new Date(year, month - 1, day);
		if (Number.isNaN(d.getTime())) return null;
		return d;
	}

	private inferDateFromMtime(sourcePath: string): Date | null {
		const file = this.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile)) return null;
		return new Date(file.stat.mtime);
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		const existing = this.vault.getAbstractFileByPath(folderPath);
		if (existing instanceof TFolder) return;

		// Create folder recursively
		const parts = folderPath.split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const folder = this.vault.getAbstractFileByPath(current);
			if (!folder) {
				await this.vault.createFolder(current);
			}
		}
	}

	private async appendToArchive(archivePath: string, tasks: TaskItem[]): Promise<void> {
		const folder = archivePath.substring(0, archivePath.lastIndexOf('/'));
		await this.ensureFolder(folder);

		const existing = this.vault.getAbstractFileByPath(archivePath);
		const appended = this.buildArchiveSection(tasks);

		if (existing instanceof TFile) {
			// Atomic read-modify-write: guarantees concurrent edits don't clobber.
			await this.vault.process(existing, current =>
				current.trimEnd() + '\n\n' + appended,
			);
		} else {
			const title = archivePath.split('/').pop()?.replace(/\.md$/, '') || 'Archive';
			const header = `# Archived Tasks — ${title}\n\n`;
			await this.vault.create(archivePath, header + appended);
		}
	}

	/** Build the "## From [[…]]" sections for a batch of tasks. */
	private buildArchiveSection(tasks: TaskItem[]): string {
		const bySource = new Map<string, TaskItem[]>();
		for (const task of tasks) {
			if (!bySource.has(task.sourcePath)) {
				bySource.set(task.sourcePath, []);
			}
			bySource.get(task.sourcePath)!.push(task);
		}

		const lines: string[] = [];
		for (const [source, sourceTasks] of bySource) {
			const sourceName = source.replace(/\.md$/, '').split('/').pop() || source;
			lines.push(`## From [[${sourceName}]]`);
			lines.push('');
			for (const task of sourceTasks) {
				lines.push(task.rawLine);
			}
			lines.push('');
		}
		return lines.join('\n');
	}

	/** Remove archived task lines (and their description continuations) from a source file.
	 *  Returns the number of tasks that could NOT be re-located and were skipped. */
	private async removeFromSource(sourcePath: string, tasks: TaskItem[]): Promise<number> {
		const file = this.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile)) return tasks.length;

		let skipped = 0;
		await this.vault.process(file, content => {
			const lines = content.split('\n');

			// Re-locate every task against the freshly-read content. Stored lineNumbers
			// may be stale if the file was edited between scan and archive.
			const taskLocations: number[] = [];
			for (const task of tasks) {
				const idx = this.locateTaskLine(task, lines);
				if (idx === -1) {
					skipped++;
					continue;
				}
				taskLocations.push(idx);
			}
			if (taskLocations.length === 0) return content;

			const allLinesToRemove = new Set<number>();
			const sorted = [...taskLocations].sort((a, b) => a - b);

			for (const lineNum of sorted) {
				allLinesToRemove.add(lineNum);
				this.collectDescriptionLines(lines, lineNum, allLinesToRemove);
			}

			return lines.filter((_, idx) => !allLinesToRemove.has(idx)).join('\n');
		});

		return skipped;
	}

	/** Walk lines after a task and mark its description continuations for removal.
	 *  Stops at: blank line, heading, another checkbox, or any line at the task's
	 *  indent or shallower. Fenced code blocks opened inside the description are
	 *  consumed whole so a ``` or markdown heading *inside* the fence doesn't
	 *  prematurely terminate the description. */
	private collectDescriptionLines(
		lines: string[],
		taskLineNum: number,
		out: Set<number>,
	): void {
		const taskLine = lines[taskLineNum];
		const taskIndent = (taskLine.match(/^(\s*)/)?.[1] || '').length;
		let inFence = false;

		for (let j = taskLineNum + 1; j < lines.length; j++) {
			const nextLine = lines[j];
			const nextIndent = (nextLine.match(/^(\s*)/)?.[1] || '').length;

			if (inFence) {
				// A line at or below task indent terminates the description even
				// inside a fence — mismatched fences shouldn't eat unrelated content.
				if (nextLine.trim().length > 0 && nextIndent <= taskIndent) break;
				out.add(j);
				if (/^\s*```/.test(nextLine)) inFence = false;
				continue;
			}

			if (nextLine.trim().length === 0) break;
			if (nextIndent <= taskIndent) break;
			if (/^\s*#{1,6}\s/.test(nextLine)) break;
			if (/^\s*-\s*\[/.test(nextLine)) break; // another checkbox
			out.add(j);
			if (/^\s*```/.test(nextLine)) inFence = true;
		}
	}

	/** Locate a task's line in freshly-read content: prefer stored lineNumber
	 *  (O(1) check); fall back to exact rawLine search. Returns -1 if the task
	 *  can't be found (e.g., file edited since scan). */
	private locateTaskLine(task: TaskItem, lines: string[]): number {
		if (
			task.lineNumber >= 0 &&
			task.lineNumber < lines.length &&
			lines[task.lineNumber] === task.rawLine
		) {
			return task.lineNumber;
		}
		return lines.indexOf(task.rawLine);
	}
}
