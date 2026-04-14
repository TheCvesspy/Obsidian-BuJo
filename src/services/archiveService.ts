import { Vault, TFile, TFolder } from 'obsidian';
import { TaskItem, TaskStatus, PluginSettings } from '../types';
import { TaskStore } from './taskStore';

export interface ArchiveResult {
	archived: number;
	files: string[];
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
	 */
	async archiveCompleted(): Promise<ArchiveResult> {
		const settings = this.getSettings();

		// Get all completed root tasks
		const allTasks = [
			...this.store.getTasks(),
			...this.store.getOpenPoints(),
			...this.store.getGoals(),
			...this.store.getUncategorized(),
		];

		const completedTasks = allTasks.filter(t =>
			t.status === TaskStatus.Done || t.status === TaskStatus.Cancelled
		);

		if (completedTasks.length === 0) {
			return { archived: 0, files: [] };
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

		// Write to archive files
		for (const [archivePath, tasks] of archiveGroups) {
			await this.appendToArchive(archivePath, tasks, settings);
			touchedFiles.add(archivePath);
		}

		// Remove archived lines from source files
		for (const [sourcePath, tasks] of sourceGroups) {
			await this.removeFromSource(sourcePath, tasks);
		}

		return {
			archived: completedTasks.length,
			files: Array.from(touchedFiles),
		};
	}

	private getArchivePath(task: TaskItem, settings: PluginSettings): string {
		const folder = settings.archiveFolderPath || 'BuJo/Archive';
		if (settings.archiveGroupBy === 'source') {
			const basename = task.sourcePath.replace(/\.md$/, '').split('/').pop() || 'misc';
			return `${folder}/${basename}.md`;
		}
		// By month
		const date = task.dueDate || new Date();
		const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
		return `${folder}/${month}.md`;
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

	private async appendToArchive(archivePath: string, tasks: TaskItem[], settings: PluginSettings): Promise<void> {
		const folder = archivePath.substring(0, archivePath.lastIndexOf('/'));
		await this.ensureFolder(folder);

		let existingContent = '';
		const file = this.vault.getAbstractFileByPath(archivePath);
		if (file instanceof TFile) {
			existingContent = await this.vault.read(file);
		}

		// Build archive content
		const lines: string[] = [];
		if (!existingContent) {
			const title = archivePath.split('/').pop()?.replace(/\.md$/, '') || 'Archive';
			lines.push(`# Archived Tasks — ${title}`);
			lines.push('');
		}

		// Group by source for readability
		const bySource = new Map<string, TaskItem[]>();
		for (const task of tasks) {
			if (!bySource.has(task.sourcePath)) {
				bySource.set(task.sourcePath, []);
			}
			bySource.get(task.sourcePath)!.push(task);
		}

		for (const [source, sourceTasks] of bySource) {
			const sourceName = source.replace(/\.md$/, '').split('/').pop() || source;
			lines.push(`## From [[${sourceName}]]`);
			lines.push('');
			for (const task of sourceTasks) {
				lines.push(task.rawLine);
			}
			lines.push('');
		}

		const newContent = existingContent
			? existingContent.trimEnd() + '\n\n' + lines.join('\n')
			: lines.join('\n');

		if (file instanceof TFile) {
			await this.vault.modify(file, newContent);
		} else {
			await this.vault.create(archivePath, newContent);
		}
	}

	private async removeFromSource(sourcePath: string, tasks: TaskItem[]): Promise<void> {
		const file = this.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile)) return;

		const content = await this.vault.read(file);
		const lines = content.split('\n');

		// Collect line numbers to remove (in descending order to preserve indices)
		const lineNumbers = new Set(tasks.map(t => t.lineNumber));

		// Also collect description lines that follow archived tasks
		const sortedLineNums = Array.from(lineNumbers).sort((a, b) => a - b);
		const allLinesToRemove = new Set<number>();

		for (const lineNum of sortedLineNums) {
			allLinesToRemove.add(lineNum);

			// Check for description lines following this task
			const taskLine = lines[lineNum];
			const taskIndent = (taskLine.match(/^(\s*)/)?.[1] || '').length;

			for (let j = lineNum + 1; j < lines.length; j++) {
				const nextLine = lines[j];
				// Stop at empty lines, headings, or lines at same/lesser indent
				if (nextLine.trim().length === 0) break;
				if (nextLine.match(/^#{1,6}\s/)) break;
				if (nextLine.match(/^\s*-\s*\[/)) break; // another checkbox
				const nextIndent = (nextLine.match(/^(\s*)/)?.[1] || '').length;
				if (nextIndent <= taskIndent) break;
				allLinesToRemove.add(j);
			}
		}

		// Filter out removed lines
		const newLines = lines.filter((_, idx) => !allLinesToRemove.has(idx));
		await this.vault.modify(file, newLines.join('\n'));
	}
}
