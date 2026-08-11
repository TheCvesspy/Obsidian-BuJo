import { Vault, TFile } from 'obsidian';
import { TaskItem, TaskStatus } from '../types';
import { CHECKBOX_REGEX, DUE_DATE_REGEX, SNOOZE_DATE_REGEX, SOMEDAY_TAG_REGEX, DONE_DATE_REGEX, SYNC_CLEAR_DELAY_MS } from '../constants';
import { locateTaskLine } from '../utils/lineLocator';

/** Collapse the double-spaces and dangling trailing whitespace left after a tag is stripped
 *  from a line, while preserving the leading indentation (tabs/spaces) that encodes hierarchy. */
function tidy(line: string): string {
    const indent = line.match(/^(\s*)/)?.[1] ?? '';
    const body = line.slice(indent.length).replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, '');
    return indent + body;
}

/** Toggle a checkbox line's status char AND manage the @done stamp: closing (Done/Cancelled)
 *  adds `@done <today>` if absent; reopening (any other status) strips it. */
function withStatus(line: string, newStatus: TaskStatus): string {
    let out = line.replace(/\[([ xX><!/-])\]/, `[${newStatus}]`);
    const closed = newStatus === TaskStatus.Done || newStatus === TaskStatus.Cancelled;
    if (closed) {
        if (!DONE_DATE_REGEX.test(out)) {
            const iso = new Date().toISOString().slice(0, 10);
            out = `${tidy(out)} @done ${iso}`;
        }
    } else {
        out = out.replace(DONE_DATE_REGEX, '');
    }
    return tidy(out);
}

export class TaskWriter {
    // Paths with an in-flight sync write, with a per-path depth counter so overlapping
    // syncs to the same file can't prematurely clear each other. Decrement is deferred
    // via setTimeout(SYNC_CLEAR_DELAY_MS) so the vault modify event and the scanner's
    // ~300ms debounced scan both still see the path as a sync target. Tracking the
    // specific path (instead of a global flag) means edits to unrelated files during
    // the window are processed normally.
    private syncTargets = new Map<string, number>();

    constructor(private vault: Vault) {}

    /** Whether `path` was just written by a two-way sync. The scanner uses this to
     *  suppress sync *detection* for that file (preventing sync→scan→sync loops)
     *  while still re-parsing it so the store stays fresh. */
    isSyncTarget(path: string): boolean {
        return (this.syncTargets.get(path) ?? 0) > 0;
    }

    private markSyncTarget(path: string): void {
        this.syncTargets.set(path, (this.syncTargets.get(path) ?? 0) + 1);
    }

    private scheduleSyncTargetClear(path: string): void {
        setTimeout(() => {
            const depth = (this.syncTargets.get(path) ?? 0) - 1;
            if (depth <= 0) this.syncTargets.delete(path);
            else this.syncTargets.set(path, depth);
        }, SYNC_CLEAR_DELAY_MS);
    }

    /** Update the status checkbox of a task in its source file */
    async setStatus(task: TaskItem, newStatus: TaskStatus): Promise<boolean> {
        return this.processTaskLine(task, line => withStatus(line, newStatus));
    }

    /** Update the @due date of a task in its source file */
    async updateDueDate(task: TaskItem, newDateRaw: string): Promise<boolean> {
        return this.processTaskLine(task, line =>
            DUE_DATE_REGEX.test(line)
                ? line.replace(DUE_DATE_REGEX, `@due ${newDateRaw}`)
                : `${line} @due ${newDateRaw}`,
        );
    }

    /** Snooze a task until `newDateRaw` — suppresses it from Today/Overdue until then.
     *  Leaves the @due deadline untouched. Adds or replaces the @snooze annotation. */
    async setSnooze(task: TaskItem, newDateRaw: string): Promise<boolean> {
        return this.processTaskLine(task, line =>
            tidy(
                SNOOZE_DATE_REGEX.test(line)
                    ? line.replace(SNOOZE_DATE_REGEX, `@snooze ${newDateRaw}`)
                    : `${line} @snooze ${newDateRaw}`,
            ),
        );
    }

    /** Remove any @snooze annotation, waking the task immediately. */
    async clearSnooze(task: TaskItem): Promise<boolean> {
        return this.processTaskLine(task, line => tidy(line.replace(SNOOZE_DATE_REGEX, '')));
    }

    /** Toggle the `#someday` deferral. Turning it on strips @due and @snooze (a Someday
     *  task is dateless); turning it off just removes the tag so the user can re-date it. */
    async setSomeday(task: TaskItem, on: boolean): Promise<boolean> {
        return this.processTaskLine(task, line => {
            if (on) {
                let out = line.replace(DUE_DATE_REGEX, '').replace(SNOOZE_DATE_REGEX, '');
                if (!SOMEDAY_TAG_REGEX.test(out)) out = `${tidy(out)} #someday`;
                return tidy(out);
            }
            return tidy(line.replace(SOMEDAY_TAG_REGEX, ''));
        });
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

        this.markSyncTarget(originalFile.path);
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
                        lines[i] = withStatus(lines[i], newStatus);
                        found = true;
                        break;
                    }
                }

                return found ? lines.join('\n') : content;
            });
        } finally {
            // Deferred decrement so the ensuing modify event + scan debounce
            // still observe the path as a sync target and skip sync detection.
            this.scheduleSyncTargetClear(originalFile.path);
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
                // Track claimed indices so tasks sharing an identical rawLine don't
                // both resolve to the same line (which would over-count `count`).
                const usedIndices = new Set<number>();
                for (const task of fileTasks) {
                    const index = locateTaskLine(task, lines, usedIndices);
                    if (index === -1) continue;
                    usedIndices.add(index);
                    lines[index] = withStatus(lines[index], newStatus);
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
            const index = locateTaskLine(task, lines);
            if (index === -1) return content;
            const updated = transform(lines[index]);
            if (updated === lines[index]) return content;
            lines[index] = updated;
            matched = true;
            return lines.join('\n');
        });
        return matched;
    }
}
