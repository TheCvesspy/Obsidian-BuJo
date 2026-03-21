import { TaskItem, TaskStatus, ItemCategory, PluginData, Priority, PluginSettings } from '../types';
import { TaskStore } from './taskStore';
import { TaskWriter } from './taskWriter';
import { DailyNoteService } from './dailyNoteService';
import { isOverdue, todayStart, formatDateISO, isToday } from '../utils/dateUtils';
import { MIGRATED_FROM_REGEX } from '../constants';

export type MigrationAction = 'forward' | 'reschedule' | 'cancel' | 'done';

export interface MigrationDecision {
    task: TaskItem;
    action: MigrationAction;
    newDate?: string;
}

export interface MigrationResult {
    forwarded: number;
    rescheduled: number;
    cancelled: number;
    completed: number;
}

/** Data structure for the morning review modal */
export interface MorningReviewData {
    /** Open tasks from yesterday's daily note */
    yesterdayTasks: TaskItem[];
    /** Open overdue tasks from across the vault (excluding yesterday's) */
    overdueTasks: TaskItem[];
    /** Tasks due today from across the vault */
    todayTasks: TaskItem[];
    /** All other open tasks available to pick from */
    availableTasks: TaskItem[];
    /** All open points available to pick from */
    availableOpenPoints: TaskItem[];
}

export class MigrationService {
    constructor(
        private store: TaskStore,
        private writer: TaskWriter,
        private dailyNotes: DailyNoteService,
        private getData: () => PluginData,
        private saveData: () => Promise<void>,
        private getSettings?: () => PluginSettings
    ) {}

    needsMigration(): boolean {
        const { lastMigrationDate } = this.getData();

        if (lastMigrationDate === null) {
            return true;
        }

        if (lastMigrationDate === formatDateISO(new Date())) {
            return false;
        }

        // Check if there's anything to review
        const review = this.getMorningReviewData();
        return review.yesterdayTasks.length > 0 ||
               review.overdueTasks.length > 0 ||
               review.todayTasks.length > 0;
    }

    /** Gather all data for the morning review modal.
     *  Only root tasks (parentId === null) are actionable. Children travel with their parent. */
    getMorningReviewData(): MorningReviewData {
        const today = todayStart();
        const now = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayNotePath = this.dailyNotes.getDailyNotePath(yesterday);

        const allTasks = this.store.getTasks();
        let yesterdayTasks: TaskItem[] = [];
        let overdueTasks: TaskItem[] = [];
        let todayTasks: TaskItem[] = [];
        const availableTasks: TaskItem[] = [];
        const yesterdayIds = new Set<string>();

        // First pass: identify yesterday's open root tasks
        for (const t of allTasks) {
            if (t.parentId !== null) continue; // Skip children
            if (t.sourcePath === yesterdayNotePath && t.status === TaskStatus.Open) {
                yesterdayTasks.push(t);
                yesterdayIds.add(t.id);
            }
        }

        // Second pass: bucket everything else (root tasks only)
        for (const t of allTasks) {
            if (t.parentId !== null) continue; // Skip children
            if (yesterdayIds.has(t.id)) continue;
            if (t.status !== TaskStatus.Open) continue;
            if (t.category === ItemCategory.Task && t.dueDate && isOverdue(t.dueDate, today)) {
                overdueTasks.push(t);
            } else if (t.category === ItemCategory.Task && t.dueDate && isToday(t.dueDate, now)) {
                todayTasks.push(t);
            } else {
                availableTasks.push(t);
            }
        }

        // Deduplicate migrated tasks across daily notes — keep only the latest copy
        const dailyNotePath = this.getSettings?.().dailyNotePath;
        if (dailyNotePath) {
            yesterdayTasks = this.deduplicateDailyTasks(yesterdayTasks, dailyNotePath);
            overdueTasks = this.deduplicateDailyTasks(overdueTasks, dailyNotePath);
            todayTasks = this.deduplicateDailyTasks(todayTasks, dailyNotePath);
        }

        overdueTasks.sort((a, b) => a.dueDate!.getTime() - b.dueDate!.getTime());

        // All open points
        const availableOpenPoints = this.store
            .getOpenPoints()
            .filter(t => t.status === TaskStatus.Open);

        return { yesterdayTasks, overdueTasks, todayTasks, availableTasks, availableOpenPoints };
    }

    /** Get overdue tasks only (for backward compat / needsMigration) */
    getPendingMigrations(): TaskItem[] {
        return this.store
            .getTasks()
            .filter(t =>
                t.category === ItemCategory.Task &&
                t.status === TaskStatus.Open &&
                t.dueDate !== null &&
                isOverdue(t.dueDate)
            )
            .sort((a, b) => a.dueDate!.getTime() - b.dueDate!.getTime());
    }

    async executeMigrations(decisions: MigrationDecision[]): Promise<MigrationResult> {
        const result: MigrationResult = { forwarded: 0, rescheduled: 0, cancelled: 0, completed: 0 };

        for (const decision of decisions) {
            const { task } = decision;
            // Collect open children for structured task unit operations
            const openChildren = task.childrenIds
                .map(id => this.store.getTaskById(id))
                .filter((c): c is TaskItem => c !== undefined && c.status === TaskStatus.Open);

            switch (decision.action) {
                case 'forward': {
                    // Mark parent as migrated
                    await this.writer.setStatus(task, TaskStatus.Migrated);
                    // Mark open children as migrated
                    if (openChildren.length > 0) {
                        await this.writer.setStatusBatch(openChildren, TaskStatus.Migrated);
                    }
                    // Get all children (including completed) for migration block
                    const allChildren = task.childrenIds
                        .map(id => this.store.getTaskById(id))
                        .filter((c): c is TaskItem => c !== undefined);
                    if (allChildren.length > 0) {
                        await this.dailyNotes.addMigratedTaskWithChildren(task, allChildren, new Date());
                    } else {
                        await this.dailyNotes.addMigratedTask(task, new Date());
                    }
                    result.forwarded++;
                    break;
                }

                case 'reschedule':
                    if (decision.newDate) {
                        await this.writer.updateDueDate(task, decision.newDate);
                    }
                    result.rescheduled++;
                    break;

                case 'done': {
                    // Complete parent + all open children
                    const toComplete = openChildren.length > 0 ? [task, ...openChildren] : [task];
                    await this.writer.setStatusBatch(toComplete, TaskStatus.Done);
                    result.completed++;
                    break;
                }

                case 'cancel': {
                    // Cancel parent + all open children
                    const toCancel = openChildren.length > 0 ? [task, ...openChildren] : [task];
                    await this.writer.setStatusBatch(toCancel, TaskStatus.Cancelled);
                    result.cancelled++;
                    break;
                }
            }
        }

        await this.markMigrationDone();
        return result;
    }

    async markMigrationDone(): Promise<void> {
        this.getData().lastMigrationDate = formatDateISO(new Date());
        await this.saveData();
    }

    /**
     * Deduplicate tasks that were migrated between daily notes.
     * When the same task exists in multiple daily notes (forwarded Day1→Day2→Day3),
     * keep only the copy from the most recent daily note.
     * Non-daily tasks are always kept.
     */
    private deduplicateDailyTasks(tasks: TaskItem[], dailyNotePath: string): TaskItem[] {
        const dailyPrefix = dailyNotePath.endsWith('/') ? dailyNotePath : dailyNotePath + '/';

        // Group by normalized text (strip "(from [[...]])" annotation)
        const groups = new Map<string, TaskItem[]>();
        for (const t of tasks) {
            const key = this.normalizeTaskText(t);
            const group = groups.get(key);
            if (group) {
                group.push(t);
            } else {
                groups.set(key, [t]);
            }
        }

        const result: TaskItem[] = [];
        for (const group of groups.values()) {
            if (group.length === 1) {
                result.push(group[0]);
                continue;
            }

            // Multiple tasks with same text — keep the most recent daily note copy,
            // or the non-daily original if it exists
            let best: TaskItem = group[0];
            let bestDate: string | null = this.extractDailyDate(best.sourcePath, dailyPrefix);

            for (let i = 1; i < group.length; i++) {
                const t = group[i];
                const tDate = this.extractDailyDate(t.sourcePath, dailyPrefix);

                if (!bestDate && tDate) {
                    // Prefer daily note over non-daily (it's the latest copy)
                    best = t;
                    bestDate = tDate;
                } else if (bestDate && tDate && tDate > bestDate) {
                    // Both are daily notes — keep the more recent one
                    best = t;
                    bestDate = tDate;
                } else if (!bestDate && !tDate) {
                    // Neither is a daily note — keep first (shouldn't happen often)
                }
                // If best is daily and t is non-daily, keep best (the forwarded copy)
            }
            result.push(best);
        }

        return result;
    }

    /** Normalize task text for dedup: strip "(from [[...]])" and trim whitespace */
    private normalizeTaskText(task: TaskItem): string {
        return task.text.replace(MIGRATED_FROM_REGEX, '').trim().toLowerCase();
    }

    /** Extract YYYY-MM-DD date string from a daily note path, or null if not a daily note */
    private extractDailyDate(sourcePath: string, dailyPrefix: string): string | null {
        if (!sourcePath.startsWith(dailyPrefix)) return null;
        const match = sourcePath.match(/(\d{4}-\d{2}-\d{2})\.md$/);
        return match ? match[1] : null;
    }
}
