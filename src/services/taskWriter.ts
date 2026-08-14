import { Vault, TFile } from 'obsidian';
import { TaskItem, TaskStatus } from '../types';
import {
	CHECKBOX_REGEX, DUE_DATE_REGEX, SNOOZE_DATE_REGEX, SOMEDAY_TAG_REGEX, DONE_DATE_REGEX,
	PRIORITY_TAG_REGEX, TYPE_TAG_REGEX, MIGRATED_FROM_REGEX, WORK_TYPE_REGEX, PURPOSE_REGEX,
	TRAILING_WIKILINK_REGEX, SYNC_CLEAR_DELAY_MS,
} from '../constants';
import { locateTaskLine } from '../utils/lineLocator';

/**
 * A partial edit of a task's fields (v3 task edit dialog). Only the keys present are
 * rewritten — everything else on the line survives verbatim, including raw date formats,
 * `(from [[…]])` annotations, `@done` stamps, and the trailing `[[Topic]]` link.
 * `null` clears the field where clearing is meaningful.
 */
export interface TaskFieldEdits {
	text?: string;
	status?: TaskStatus;
	/** 'none' clears the #priority tag. */
	priority?: string;
	dueDateRaw?: string | null;
	snoozeDateRaw?: string | null;
	someday?: boolean;
	/** null = Auto (no #type tag). */
	typeTag?: string | null;
	/** Work-type short code; null clears. */
	workType?: string | null;
	/** Purpose short code; null clears. */
	purpose?: string | null;
	/** Replaces the task's immediate description block (the non-checkbox continuation
	 *  lines directly under it, before any child checkbox). null/'' clears it. */
	description?: string | null;
}

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
     * Apply a partial field edit to a task: rebuilds its line from the edited values
     * plus the tokens already present (parsed with the same regex order as taskParser,
     * so nothing is misread), and optionally replaces its immediate description block.
     * Status changes route through the same @done-stamp logic as setStatus. Returns
     * false when the task can't be located.
     */
    async updateTaskFields(task: TaskItem, edits: TaskFieldEdits): Promise<boolean> {
        const file = this.vault.getAbstractFileByPath(task.sourcePath);
        if (!(file instanceof TFile)) return false;

        let matched = false;
        await this.vault.process(file, content => {
            const lines = content.split('\n');
            const start = locateTaskLine(task, lines);
            if (start === -1) return content;
            const cb = lines[start].match(CHECKBOX_REGEX);
            if (!cb) return content;
            matched = true;

            const indent = cb[1];
            const statusChar = cb[2];
            let rest = cb[3];

            // Capture current tokens, then strip them in the parser's order so the
            // remaining string is exactly what the parser would call the task text.
            const curPriority = rest.match(PRIORITY_TAG_REGEX)?.[1]?.toLowerCase() ?? null;
            const curType = rest.match(TYPE_TAG_REGEX)?.[1]?.toLowerCase() ?? null;
            const curDueRaw = rest.match(DUE_DATE_REGEX)?.[1] ?? null;
            const curSnoozeRaw = rest.match(SNOOZE_DATE_REGEX)?.[1] ?? null;
            const curSomeday = SOMEDAY_TAG_REGEX.test(rest);
            const doneStamp = rest.match(DONE_DATE_REGEX)?.[0] ?? null;
            const migratedFrom = rest.match(MIGRATED_FROM_REGEX)?.[1] ?? null;
            const curW = rest.match(WORK_TYPE_REGEX)?.[1] ?? null;
            const curP = rest.match(PURPOSE_REGEX)?.[1] ?? null;

            rest = rest
                .replace(PRIORITY_TAG_REGEX, '')
                .replace(TYPE_TAG_REGEX, '')
                .replace(DUE_DATE_REGEX, '')
                .replace(SNOOZE_DATE_REGEX, '')
                .replace(SOMEDAY_TAG_REGEX, '')
                .replace(DONE_DATE_REGEX, '')
                .replace(MIGRATED_FROM_REGEX, ' ')
                .replace(WORK_TYPE_REGEX, '')
                .replace(PURPOSE_REGEX, '');
            const trailingLink = rest.match(TRAILING_WIKILINK_REGEX)?.[0]?.trim() ?? null;
            if (trailingLink) rest = rest.replace(TRAILING_WIKILINK_REGEX, '');
            const curText = rest.replace(/\s{2,}/g, ' ').trim();

            // Edited values win; absent keys keep what the line already had.
            const text = edits.text !== undefined ? edits.text.trim() : curText;
            const priority = edits.priority !== undefined ? edits.priority : (curPriority ?? 'none');
            const dueRaw = edits.dueDateRaw !== undefined ? edits.dueDateRaw : curDueRaw;
            const snoozeRaw = edits.snoozeDateRaw !== undefined ? edits.snoozeDateRaw : curSnoozeRaw;
            const isSomeday = edits.someday !== undefined ? edits.someday : curSomeday;
            const typeTag = edits.typeTag !== undefined ? edits.typeTag : curType;
            const workType = edits.workType !== undefined ? edits.workType : curW;
            const purpose = edits.purpose !== undefined ? edits.purpose : curP;

            const parts = [`${indent}- [${statusChar}] ${text}`];
            if (priority && priority !== 'none') parts.push(`#priority/${priority}`);
            if (dueRaw) parts.push(`@due ${dueRaw}`);
            if (snoozeRaw) parts.push(`@snooze ${snoozeRaw}`);
            if (typeTag) parts.push(`#type/${typeTag}`);
            if (workType) parts.push(`#w/${workType}`);
            if (purpose) parts.push(`#p/${purpose}`);
            if (isSomeday) parts.push('#someday');
            if (migratedFrom) parts.push(`(from [[${migratedFrom}]])`);
            if (doneStamp) parts.push(doneStamp);
            if (trailingLink) parts.push(trailingLink); // tail position — parser contract

            let newLine = tidy(parts.join(' '));
            if (edits.status !== undefined) newLine = withStatus(newLine, edits.status);
            lines[start] = newLine;

            // Description: replace the contiguous non-checkbox continuation lines directly
            // under the task (children and their own descriptions are untouched).
            if (edits.description !== undefined) {
                let end = start + 1;
                while (end < lines.length) {
                    const l = lines[end];
                    if (l.trim().length === 0) break;
                    if (/^#{1,6}\s/.test(l)) break;
                    if (CHECKBOX_REGEX.test(l)) break;
                    const lineIndent = (l.match(/^(\s*)/)?.[1] ?? '').length;
                    if (lineIndent <= indent.length) break;
                    end++;
                }
                const desc = (edits.description ?? '').trim();
                const descLines = desc ? desc.split('\n').map(l => `${indent}    ${l}`) : [];
                lines.splice(start + 1, end - (start + 1), ...descLines);
            }

            return lines.join('\n');
        });
        return matched;
    }

    /**
     * Remove a task's line plus its continuation block — deeper-indented lines
     * (checkbox children and description), including interior blank lines — from its
     * source file. Returns the removed lines dedented to the root's column, or null
     * when the task can't be located. Used by triage's "send to Topic": the block is
     * re-homed into the topic file, not duplicated.
     */
    async removeTaskBlock(task: TaskItem): Promise<string[] | null> {
        const file = this.vault.getAbstractFileByPath(task.sourcePath);
        if (!(file instanceof TFile)) return null;

        let removed: string[] | null = null;
        await this.vault.process(file, content => {
            const lines = content.split('\n');
            const start = locateTaskLine(task, lines);
            if (start === -1) return content;

            const prefix = lines[start].match(/^(\s*)/)?.[1] ?? '';
            let end = start + 1;
            while (end < lines.length) {
                const line = lines[end];
                if (line.trim().length === 0) { end++; continue; } // blanks may sit inside a block
                if (/^#{1,6}\s/.test(line)) break;
                const indent = (line.match(/^(\s*)/)?.[1] ?? '').length;
                if (indent <= prefix.length) break;
                end++;
            }
            // Trailing blank lines are separation, not content — leave them behind.
            let lastContent = end;
            while (lastContent > start + 1 && lines[lastContent - 1].trim().length === 0) lastContent--;

            removed = lines
                .slice(start, lastContent)
                .map(l => (l.startsWith(prefix) ? l.slice(prefix.length) : l));
            return [...lines.slice(0, start), ...lines.slice(lastContent)].join('\n');
        });
        return removed;
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
