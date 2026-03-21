import { Vault, TFile } from 'obsidian';
import { TaskItem, TaskStatus } from '../types';
import { CHECKBOX_REGEX, DUE_DATE_REGEX, SYNC_CLEAR_DELAY_MS } from '../constants';

export class TaskWriter {
    private syncing = false;

    constructor(private vault: Vault) {}

    /** Whether a sync write is in progress (used to avoid re-scan loops) */
    get isSyncing(): boolean {
        return this.syncing;
    }

    /** Update the status checkbox of a task in its source file */
    async setStatus(task: TaskItem, newStatus: TaskStatus): Promise<boolean> {
        const line = this.findTaskLine(task, await this.readLines(task));
        if (line === null) return false;

        const { lines, index, file } = line;
        lines[index] = lines[index].replace(/\[([ x><!-])\]/i, `[${newStatus}]`);
        await this.vault.modify(file, lines.join('\n'));
        return true;
    }

    /** Update the @due date of a task in its source file */
    async updateDueDate(task: TaskItem, newDateRaw: string): Promise<boolean> {
        const line = this.findTaskLine(task, await this.readLines(task));
        if (line === null) return false;

        const { lines, index, file } = line;
        if (DUE_DATE_REGEX.test(lines[index])) {
            lines[index] = lines[index].replace(DUE_DATE_REGEX, `@due ${newDateRaw}`);
        } else {
            lines[index] = `${lines[index]} @due ${newDateRaw}`;
        }
        await this.vault.modify(file, lines.join('\n'));
        return true;
    }

    /**
     * Sync a forwarded copy's status back to its original task.
     * Called when a task with migratedFrom is completed or cancelled.
     * Finds the original by matching text content and [>] status.
     */
    async syncOriginalStatus(task: TaskItem, newStatus: TaskStatus): Promise<boolean> {
        if (!task.migratedFrom) return false;
        if (newStatus !== TaskStatus.Done && newStatus !== TaskStatus.Cancelled) return false;

        // Resolve the original file — migratedFrom is a wiki-link name (no extension)
        const originalFile = this.resolveWikiLink(task.migratedFrom);
        if (!originalFile) return false;

        const content = await this.vault.read(originalFile);
        const lines = content.split('\n');

        // Find the original task: migrated status [>] with matching text
        const cleanText = task.text.trim();
        let found = false;

        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(CHECKBOX_REGEX);
            if (!match) continue;

            const statusChar = match[2];
            if (statusChar !== '>') continue;

            // Extract text portion and compare (strip tags for comparison)
            const lineText = match[3]
                .replace(/#priority\/\w+/g, '')
                .replace(/@due\s+\S+/g, '')
                .replace(/#type\/\w+/g, '')
                .replace(/\s{2,}/g, ' ')
                .trim();

            if (lineText === cleanText) {
                this.syncing = true;
                try {
                    lines[i] = lines[i].replace(/\[([ x><!-])\]/i, `[${newStatus}]`);
                    await this.vault.modify(originalFile, lines.join('\n'));
                    found = true;
                } finally {
                    // Small delay before clearing flag so the modify event can be skipped
                    setTimeout(() => { this.syncing = false; }, SYNC_CLEAR_DELAY_MS);
                }
                break;
            }
        }

        return found;
    }

    /**
     * Update status for multiple tasks in batch, grouping by source file
     * to minimize file reads/writes. Used for completing parent + all children.
     */
    async setStatusBatch(tasks: TaskItem[], newStatus: TaskStatus): Promise<number> {
        // Group by source file
        const byFile = new Map<string, TaskItem[]>();
        for (const t of tasks) {
            const group = byFile.get(t.sourcePath) ?? [];
            group.push(t);
            byFile.set(t.sourcePath, group);
        }

        let count = 0;
        for (const [path, fileTasks] of byFile) {
            const abstract = this.vault.getAbstractFileByPath(path);
            if (!(abstract instanceof TFile)) continue;

            const content = await this.vault.read(abstract);
            const lines = content.split('\n');

            for (const task of fileTasks) {
                const result = this.findTaskLine(task, { file: abstract, lines });
                if (result) {
                    lines[result.index] = lines[result.index].replace(
                        /\[([ x><!-])\]/i,
                        `[${newStatus}]`
                    );
                    count++;
                }
            }

            await this.vault.modify(abstract, lines.join('\n'));
        }
        return count;
    }

    /** Resolve a wiki-link name to a TFile (searches vault for matching .md file) */
    private resolveWikiLink(name: string): TFile | null {
        const allFiles = this.vault.getMarkdownFiles();
        // Exact path match first (with .md)
        const exactPath = allFiles.find(f => f.path === name + '.md' || f.path === name);
        if (exactPath) return exactPath;
        // Basename match (Obsidian wiki-links resolve by basename)
        return allFiles.find(f => f.basename === name) ?? null;
    }

    private async readLines(task: TaskItem): Promise<{ file: TFile; lines: string[] } | null> {
        const abstract = this.vault.getAbstractFileByPath(task.sourcePath);
        if (!(abstract instanceof TFile)) return null;

        const content = await this.vault.read(abstract);
        return { file: abstract, lines: content.split('\n') };
    }

    private findTaskLine(
        task: TaskItem,
        result: { file: TFile; lines: string[] } | null
    ): { file: TFile; lines: string[]; index: number } | null {
        if (!result) return null;
        const { file, lines } = result;

        // Try the recorded line number first
        if (task.lineNumber >= 0 && task.lineNumber < lines.length && lines[task.lineNumber] === task.rawLine) {
            return { file, lines, index: task.lineNumber };
        }

        // Fallback: search all lines for an exact match
        const index = lines.indexOf(task.rawLine);
        if (index === -1) return null;
        return { file, lines, index };
    }
}
