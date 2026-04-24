import { Vault, TFile } from 'obsidian';
import { TaskItem, TaskStatus } from '../types';
import { CHECKBOX_REGEX, DUE_DATE_REGEX, SYNC_CLEAR_DELAY_MS } from '../constants';

export class TaskWriter {
    // Depth counter (not boolean): overlapping syncs can't prematurely clear each other.
    // Decrement is deferred via setTimeout(SYNC_CLEAR_DELAY_MS) so the vault modify event
    // and the scanner's ~300ms debounced scan both still see isSyncing=true.
    private syncDepth = 0;

    constructor(private vault: Vault) {}

    /** Whether a sync write is in progress (used to avoid re-scan loops) */
    get isSyncing(): boolean {
        return this.syncDepth > 0;
    }

    /** Update the status checkbox of a task in its source file */
    async setStatus(task: TaskItem, newStatus: TaskStatus): Promise<boolean> {
        return this.processTaskLine(task, line =>
            line.replace(/\[([ x><!-])\]/i, `[${newStatus}]`),
        );
    }

    /** Update the @due date of a task in its source file */
    async updateDueDate(task: TaskItem, newDateRaw: string): Promise<boolean> {
        return this.processTaskLine(task, line =>
            DUE_DATE_REGEX.test(line)
                ? line.replace(DUE_DATE_REGEX, `@due ${newDateRaw}`)
                : `${line} @due ${newDateRaw}`,
        );
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

        const cleanText = task.text.trim();
        let found = false;

        this.syncDepth++;
        try {
            await this.vault.process(originalFile, content => {
                const lines = content.split('\n');

                // Find the original task: migrated status [>] with matching text
                for (let i = 0; i < lines.length; i++) {
                    const match = lines[i].match(CHECKBOX_REGEX);
                    if (!match) continue;
                    if (match[2] !== '>') continue;

                    // Extract text portion and compare (strip tags for comparison)
                    const lineText = match[3]
                        .replace(/#priority\/\w+/g, '')
                        .replace(/@due\s+\S+/g, '')
                        .replace(/#type\/\w+/g, '')
                        .replace(/\s{2,}/g, ' ')
                        .trim();

                    if (lineText === cleanText) {
                        lines[i] = lines[i].replace(/\[([ x><!-])\]/i, `[${newStatus}]`);
                        found = true;
                        break;
                    }
                }

                return found ? lines.join('\n') : content;
            });
        } finally {
            // Deferred decrement so the ensuing modify event + scan debounce
            // still observe isSyncing=true and skip the re-scan.
            setTimeout(() => { this.syncDepth--; }, SYNC_CLEAR_DELAY_MS);
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

            await this.vault.process(abstract, content => {
                const lines = content.split('\n');
                let mutated = false;
                for (const task of fileTasks) {
                    const index = this.locateTaskLine(task, lines);
                    if (index === -1) continue;
                    lines[index] = lines[index].replace(
                        /\[([ x><!-])\]/i,
                        `[${newStatus}]`,
                    );
                    count++;
                    mutated = true;
                }
                return mutated ? lines.join('\n') : content;
            });
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

    /** Apply a transform to a task's line inside a single atomic vault.process call. */
    private async processTaskLine(
        task: TaskItem,
        transform: (line: string) => string,
    ): Promise<boolean> {
        const file = this.vault.getAbstractFileByPath(task.sourcePath);
        if (!(file instanceof TFile)) return false;

        let matched = false;
        await this.vault.process(file, content => {
            const lines = content.split('\n');
            const index = this.locateTaskLine(task, lines);
            if (index === -1) return content;
            const updated = transform(lines[index]);
            if (updated === lines[index]) return content;
            lines[index] = updated;
            matched = true;
            return lines.join('\n');
        });
        return matched;
    }

    /** Locate a task's line in freshly-read content. Prefers the recorded
     *  lineNumber when rawLine still matches; falls back to exact-line search. */
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
