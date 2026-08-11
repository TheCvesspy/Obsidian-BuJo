import { Vault, TFile, TFolder } from 'obsidian';
import { PluginSettings } from '../types';
import { formatDateISO } from '../utils/dateUtils';

/**
 * Owns the central loose-task inbox file (`settings.tasksFilePath`, default `BuJo/Tasks.md`).
 * This is one of the two v3 task homes: quick-add lands here, and the daily-note `## Inbox`
 * sweep drains into here. Topics own their own task lists; this service never touches them.
 */
export class TasksInboxService {
	constructor(private vault: Vault, private getSettings: () => PluginSettings) {}

	private get path(): string {
		return this.getSettings().tasksFilePath || 'BuJo/Tasks.md';
	}

	/** Get or create the Tasks.md file (creating parent folders + a heading on first use). */
	async getOrCreate(): Promise<TFile> {
		const path = this.path;
		const existing = this.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;

		const folderPath = path.substring(0, path.lastIndexOf('/'));
		if (folderPath && !(this.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) {
			try { await this.vault.createFolder(folderPath); } catch { /* may already exist */ }
		}
		return this.vault.create(path, '# Tasks\n\nLoose tasks awaiting triage. Give one a `@due`, `@snooze`, `#someday`, or a trailing `[[Topic]]` link.\n\n');
	}

	/** Append one or more raw task lines to the end of Tasks.md. */
	async appendLines(lines: string[]): Promise<void> {
		if (lines.length === 0) return;
		const file = await this.getOrCreate();
		await this.vault.process(file, content =>
			content.trimEnd() + '\n' + lines.join('\n') + '\n',
		);
	}

	/** Append a single raw task line. */
	async appendLine(line: string): Promise<void> {
		return this.appendLines([line]);
	}

	/**
	 * Sweep a daily note's `## Inbox` section into Tasks.md: every non-empty line under the
	 * heading (checkbox lines and their indented continuations, verbatim) is appended to
	 * Tasks.md and removed from the daily note, leaving an empty `## Inbox` heading behind.
	 * Returns the number of top-level checkbox items moved.
	 */
	async sweepDailyInbox(dailyNotePath: string): Promise<number> {
		const file = this.vault.getAbstractFileByPath(dailyNotePath);
		if (!(file instanceof TFile)) return 0;

		const content = await this.vault.read(file);
		const lines = content.split('\n');

		const startIdx = lines.findIndex(l => /^##\s+Inbox\s*$/i.test(l));
		if (startIdx === -1) return 0;

		// Section runs from just after the heading to the next heading (any level) or EOF.
		let endIdx = lines.length;
		for (let i = startIdx + 1; i < lines.length; i++) {
			if (/^#{1,6}\s+/.test(lines[i])) { endIdx = i; break; }
		}

		const block = lines.slice(startIdx + 1, endIdx);
		const moved = block.filter(l => l.trim().length > 0);
		if (moved.length === 0) return 0;
		const topLevelCount = moved.filter(l => /^\s*-\s*\[[ xX><!/-]\]/.test(l)).length;

		await this.appendLines(moved);

		// Rebuild the daily note with an emptied Inbox section (heading + one blank line).
		const rebuilt = [
			...lines.slice(0, startIdx + 1),
			'',
			...lines.slice(endIdx),
		].join('\n');
		await this.vault.process(file, () => rebuilt);

		return topLevelCount || moved.length;
	}

	/** Path of today's daily note, for the sweep command. */
	todayDailyPath(date: Date): string {
		return `${this.getSettings().dailyNotePath}/${formatDateISO(date)}.md`;
	}
}
