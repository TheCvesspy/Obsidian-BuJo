import { Vault, TFile, TFolder } from 'obsidian';
import { TaskItem, TaskStatus, PluginSettings } from '../types';
import { TaskStore } from './taskStore';
import { locateTaskLine } from '../utils/lineLocator';

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
	 * Moves task lines (with their description continuations) to archive files
	 * and removes them from source files.
	 *
	 * Three phases: (1) locate every task in a fresh read and capture its verbatim
	 * block — tasks that can't be located are counted under `skipped` and never
	 * archived, so retries are idempotent; (2) append the captured blocks to the
	 * archive files; (3) remove the blocks from the source files. Archive-before-
	 * remove ordering is kept: on a mid-flight edit we prefer over-archiving to
	 * losing content from the source.
	 */
	async archiveCompleted(extraFilter?: (t: TaskItem) => boolean): Promise<ArchiveResult> {
		const settings = this.getSettings();

		// Get all completed root tasks
		const allTasks = [
			...this.store.getTasks(),
			...this.store.getOpenPoints(),
			...this.store.getInbox(),
			...this.store.getUncategorized(),
		];

		const completedTasks = allTasks.filter(t =>
			(t.status === TaskStatus.Done || t.status === TaskStatus.Cancelled)
			&& (!extraFilter || extraFilter(t)),
		);

		if (completedTasks.length === 0) {
			return { archived: 0, files: [], skipped: 0 };
		}

		// Group tasks by source file
		const sourceGroups = new Map<string, TaskItem[]>();
		for (const task of completedTasks) {
			if (!sourceGroups.has(task.sourcePath)) {
				sourceGroups.set(task.sourcePath, []);
			}
			sourceGroups.get(task.sourcePath)!.push(task);
		}

		// Phase 1 — locate every task against a fresh read and capture its verbatim
		// block: the task line plus description continuations, original indentation
		// intact. Unlocatable tasks (file edited since scan) never enter the archive.
		const blocks = new Map<TaskItem, string>();
		let skipped = 0;
		for (const [sourcePath, tasks] of sourceGroups) {
			const file = this.vault.getAbstractFileByPath(sourcePath);
			if (!(file instanceof TFile)) {
				skipped += tasks.length;
				continue;
			}
			const lines = (await this.vault.read(file)).split('\n');
			const usedIndices = new Set<number>();
			for (const task of tasks) {
				const idx = locateTaskLine(task, lines, usedIndices);
				if (idx === -1) {
					skipped++;
					continue;
				}
				usedIndices.add(idx);
				const blockLines = new Set<number>([idx]);
				this.collectDescriptionLines(lines, idx, blockLines);
				const sorted = [...blockLines].sort((a, b) => a - b);
				blocks.set(task, sorted.map(i => lines[i]).join('\n'));
			}
		}

		if (blocks.size === 0) {
			return { archived: 0, files: [], skipped };
		}

		// Phase 2 — group located tasks by archive file and append their blocks.
		const archiveGroups = new Map<string, TaskItem[]>();
		for (const task of completedTasks) {
			if (!blocks.has(task)) continue;
			const archivePath = this.getArchivePath(task, settings);
			if (!archiveGroups.has(archivePath)) {
				archiveGroups.set(archivePath, []);
			}
			archiveGroups.get(archivePath)!.push(task);
		}

		const touchedFiles = new Set<string>();
		for (const [archivePath, tasks] of archiveGroups) {
			await this.appendToArchive(archivePath, tasks, blocks);
			touchedFiles.add(archivePath);
		}

		// Phase 3 — remove archived blocks from source files (re-locates against the
		// content inside vault.process). A task that moved since phase 1 stays in the
		// source; it was already archived, which is the preferred failure direction.
		let notRemoved = 0;
		for (const [sourcePath, tasks] of sourceGroups) {
			const located = tasks.filter(t => blocks.has(t));
			if (located.length === 0) continue;
			notRemoved += await this.removeFromSource(sourcePath, located);
		}

		return {
			archived: blocks.size - notRemoved,
			files: Array.from(touchedFiles),
			skipped: skipped + notRemoved,
		};
	}

	/**
	 * v3 inbox cleanup. Archives completed (Done/Cancelled) tasks that live in the central
	 * `tasksFilePath` and have been closed for at least `afterDays` (judged by the `@done`
	 * stamp; unstamped legacy items are treated as eligible). Topic files and daily notes are
	 * intentionally left untouched — Topics keep their completed tasks as a permanent record.
	 * Returns a no-op result when disabled (afterDays < 0) or no inbox path is configured.
	 */
	async cleanupInbox(afterDays: number, tasksFilePath: string): Promise<ArchiveResult> {
		if (!tasksFilePath || afterDays < 0) return { archived: 0, files: [], skipped: 0 };
		const cutoff = new Date();
		cutoff.setHours(0, 0, 0, 0);
		cutoff.setDate(cutoff.getDate() - afterDays);
		return this.archiveCompleted(t =>
			t.sourcePath === tasksFilePath
			&& (t.completedDate == null || t.completedDate.getTime() <= cutoff.getTime()),
		);
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

	private async appendToArchive(
		archivePath: string,
		tasks: TaskItem[],
		blocks: Map<TaskItem, string>,
	): Promise<void> {
		const folder = archivePath.substring(0, archivePath.lastIndexOf('/'));
		await this.ensureFolder(folder);

		const existing = this.vault.getAbstractFileByPath(archivePath);
		const appended = this.buildArchiveSection(tasks, blocks);

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

	/** Build the "## From [[…]]" sections for a batch of tasks. Each task's captured
	 *  block (task line + description continuations) is emitted verbatim so notes
	 *  under a task survive archiving. */
	private buildArchiveSection(tasks: TaskItem[], blocks: Map<TaskItem, string>): string {
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
				lines.push(blocks.get(task) ?? task.rawLine);
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
			// `usedIndices` prevents two tasks with an identical rawLine (e.g. the same
			// `- [x] …` on two days) from both resolving to the same physical line —
			// which would leave one behind while the archive already holds both.
			const usedIndices = new Set<number>();
			const taskLocations: number[] = [];
			for (const task of tasks) {
				const idx = locateTaskLine(task, lines, usedIndices);
				if (idx === -1) {
					skipped++;
					continue;
				}
				usedIndices.add(idx);
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
}
