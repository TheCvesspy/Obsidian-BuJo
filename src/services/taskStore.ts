import {
    TaskItem,
    ItemCategory,
    TaskStatus,
    Priority,
    GroupMode,
    StoreEventType,
    StoreEventCallback
} from '../types';
import { isToday, isThisWeek, isOverdue, isSameDay } from '../utils/dateUtils';

export class TaskStore {
    private tasks: TaskItem[] = [];
    private listeners: StoreEventCallback[] = [];
    private _version = 0;

    // Cached category indices — rebuilt on setTasks()
    private taskItems: TaskItem[] = [];
    private openPointItems: TaskItem[] = [];
    private inboxItems: TaskItem[] = [];
    private uncategorizedItems: TaskItem[] = [];

    // Hierarchy lookup — rebuilt on setTasks()
    private taskByIdMap: Map<string, TaskItem> = new Map();

    /** Monotonically increasing version, bumped on every setTasks() */
    get version(): number { return this._version; }

    /** Update the full task list (called by VaultScanner) */
    setTasks(tasks: TaskItem[]): void {
        this._version++;
        this.tasks = tasks;
        this.rebuildIndices();
        this.emit('tasks-updated');
    }

    private rebuildIndices(): void {
        this.taskItems = [];
        this.openPointItems = [];
        this.inboxItems = [];
        this.uncategorizedItems = [];
        this.taskByIdMap = new Map();
        for (const t of this.tasks) {
            this.taskByIdMap.set(t.id, t);
            switch (t.category) {
                case ItemCategory.Task:
                    this.taskItems.push(t);
                    break;
                case ItemCategory.OpenPoint:
                    this.openPointItems.push(t);
                    break;
                case ItemCategory.Inbox:
                    this.inboxItems.push(t);
                    break;
                case ItemCategory.Uncategorized:
                    this.uncategorizedItems.push(t);
                    break;
            }
        }
    }

    /** Subscribe to store changes */
    on(callback: StoreEventCallback): void {
        this.listeners.push(callback);
    }

    /** Unsubscribe */
    off(callback: StoreEventCallback): void {
        this.listeners = this.listeners.filter(cb => cb !== callback);
    }

    private emit(type: StoreEventType): void {
        for (const cb of this.listeners) {
            cb(type);
        }
    }

    // --- Category queries (return cached arrays — do NOT mutate) ---

    /** Get all items classified as Tasks */
    getTasks(): TaskItem[] {
        return this.taskItems;
    }

    /** Get all items classified as Open Points */
    getOpenPoints(): TaskItem[] {
        return this.openPointItems;
    }

    /** Get all items classified as Inbox (quick-capture, needs triage) */
    getInbox(): TaskItem[] {
        return this.inboxItems;
    }

    /** Get uncategorized items */
    getUncategorized(): TaskItem[] {
        return this.uncategorizedItems;
    }

    // --- Hierarchy helpers ---

    /** Get a task by its ID */
    getTaskById(id: string): TaskItem | undefined {
        return this.taskByIdMap.get(id);
    }

    /** Get direct children of a task */
    getChildren(taskId: string): TaskItem[] {
        const task = this.taskByIdMap.get(taskId);
        if (!task) return [];
        return task.childrenIds
            .map(id => this.taskByIdMap.get(id))
            .filter((t): t is TaskItem => t !== undefined);
    }

    /** Get all descendants of a task (children, grandchildren, etc.) */
    getDescendants(taskId: string): TaskItem[] {
        const result: TaskItem[] = [];
        const collect = (id: string) => {
            const task = this.taskByIdMap.get(id);
            if (!task) return;
            for (const childId of task.childrenIds) {
                const child = this.taskByIdMap.get(childId);
                if (child) {
                    result.push(child);
                    collect(childId);
                }
            }
        };
        collect(taskId);
        return result;
    }

    /** Get only root-level tasks (no parent) */
    getRootTasks(tasks?: TaskItem[]): TaskItem[] {
        return (tasks ?? this.tasks).filter(t => t.parentId === null);
    }

    // --- Task filters ---

    /** Root tasks due on a specific date */
    getTasksForDate(date: Date): TaskItem[] {
        return this.taskItems.filter(t => t.parentId === null && t.dueDate != null && isSameDay(t.dueDate, date));
    }

    /** Root tasks due within a date range (inclusive) */
    getTasksForDateRange(start: Date, end: Date): TaskItem[] {
        return this.taskItems.filter(t => {
            if (t.parentId !== null) return false;
            if (t.dueDate == null) return false;
            const due = t.dueDate;
            return due >= start && due <= end;
        });
    }

    /** Midnight today, computed once per call. */
    private todayRef(): Date {
        const n = new Date();
        return new Date(n.getFullYear(), n.getMonth(), n.getDate());
    }

    /** A task is "asleep" while today is strictly before its snooze date. On the snooze
     *  date it wakes. Tasks with no snooze date are never asleep. */
    private isSnoozed(t: TaskItem, today: Date): boolean {
        return t.snoozeDate != null && t.snoozeDate.getTime() > today.getTime();
    }

    /** Open, not deferred to Someday, and not currently snoozed — i.e. eligible for the
     *  dated task surfaces (Today / Upcoming / Overdue). */
    private isActive(t: TaskItem, today: Date): boolean {
        return t.status === TaskStatus.Open && !t.someday && !this.isSnoozed(t, today);
    }

    /** Open root tasks with due date before today. Excludes snoozed & someday. */
    getOverdueTasks(): TaskItem[] {
        const today = this.todayRef();
        return this.taskItems.filter(
            t => t.parentId === null && t.dueDate != null && isOverdue(t.dueDate, today) && this.isActive(t, today)
        );
    }

    /** The daily driver: active root tasks due today or overdue (snoozed & someday excluded). */
    getToday(): TaskItem[] {
        const today = this.todayRef();
        return this.taskItems.filter(
            t => t.parentId === null && t.dueDate != null && t.dueDate.getTime() <= today.getTime() && this.isActive(t, today)
        );
    }

    /** Active root tasks due after today and within `windowDays` (default 14). */
    getUpcoming(windowDays = 14): TaskItem[] {
        const today = this.todayRef();
        const horizon = new Date(today.getTime());
        horizon.setDate(horizon.getDate() + windowDays);
        return this.taskItems.filter(
            t => t.parentId === null && t.dueDate != null
                && t.dueDate.getTime() > today.getTime()
                && t.dueDate.getTime() <= horizon.getTime()
                && this.isActive(t, today)
        );
    }

    /** Snoozed root tasks that wake within `windowDays` (shown in Upcoming as "waking"). */
    getWakingSnoozed(windowDays = 14): TaskItem[] {
        const today = this.todayRef();
        const horizon = new Date(today.getTime());
        horizon.setDate(horizon.getDate() + windowDays);
        return this.taskItems.filter(
            t => t.parentId === null && t.status === TaskStatus.Open && !t.someday
                && t.snoozeDate != null
                && t.snoozeDate.getTime() > today.getTime()
                && t.snoozeDate.getTime() <= horizon.getTime()
        );
    }

    /** Open root tasks deferred to Someday (dateless backlog). */
    getSomedayTasks(): TaskItem[] {
        return this.taskItems.filter(
            t => t.parentId === null && t.status === TaskStatus.Open && t.someday
        );
    }

    /** Triage: loose, undecided items awaiting a decision — no date, no Topic link, not
     *  snoozed or someday. Draws from the Inbox category plus the central `tasksFilePath`. */
    getTriage(tasksFilePath: string): TaskItem[] {
        const today = this.todayRef();
        const seen = new Set<string>();
        const out: TaskItem[] = [];
        const add = (t: TaskItem) => { if (!seen.has(t.id)) { seen.add(t.id); out.push(t); } };
        for (const t of this.inboxItems) {
            if (t.parentId === null && this.isActive(t, today) && t.dueDate == null && t.topicLink == null) add(t);
        }
        for (const t of this.taskItems) {
            if (t.parentId === null && t.sourcePath === tasksFilePath
                && this.isActive(t, today) && t.dueDate == null && t.topicLink == null) add(t);
        }
        return out;
    }

    /** Open root tasks with no due date. Excludes snoozed & someday. */
    getUnscheduledTasks(): TaskItem[] {
        const today = this.todayRef();
        return this.taskItems.filter(
            t => t.parentId === null && t.dueDate == null && this.isActive(t, today)
        );
    }

    /** Count of open (non-done) root tasks */
    getPendingCount(): number {
        let count = 0;
        for (const t of this.taskItems) {
            if (t.parentId === null && t.status === TaskStatus.Open) count++;
        }
        return count;
    }

    // --- Filtering ---

    /** Filter out completed tasks if requested. Migrated tasks are always hidden (they've been moved).
     *  Only filters root tasks — children follow their parent's visibility. */
    filterCompleted(tasks: TaskItem[], showCompleted: boolean): TaskItem[] {
        const roots = tasks.filter(t => t.parentId === null);
        if (showCompleted) {
            return roots.filter(t => t.status !== TaskStatus.Migrated);
        }
        return roots.filter(
            t =>
                t.status !== TaskStatus.Done &&
                t.status !== TaskStatus.Migrated &&
                t.status !== TaskStatus.Scheduled &&
                t.status !== TaskStatus.Cancelled
        );
    }

    // --- Grouping ---

    /** Group tasks by the given mode. Returns Map<groupLabel, TaskItem[]>.
     *  Only groups root tasks — children are rendered nested under their parent in the UI. */
    groupTasks(tasks: TaskItem[], mode: GroupMode, weekStartDay?: number): Map<string, TaskItem[]> {
        const rootTasks = tasks.filter(t => t.parentId === null);
        switch (mode) {
            case GroupMode.ByPage:
                return this.groupByPage(rootTasks);
            case GroupMode.ByPriority:
                return this.groupByPriority(rootTasks);
            case GroupMode.ByDueDate:
                return this.groupByDueDate(rootTasks, weekStartDay);
            default:
                return new Map([['All', rootTasks]]);
        }
    }

    private groupByPage(tasks: TaskItem[]): Map<string, TaskItem[]> {
        const groups = new Map<string, TaskItem[]>();
        for (const task of tasks) {
            const path = task.sourcePath || 'Unknown';
            const label = path.replace(/\.md$/, '').split('/').pop() || path;
            if (!groups.has(label)) groups.set(label, []);
            groups.get(label)!.push(task);
        }
        return groups;
    }

    private groupByPriority(tasks: TaskItem[]): Map<string, TaskItem[]> {
        const high: TaskItem[] = [];
        const medium: TaskItem[] = [];
        const low: TaskItem[] = [];
        const none: TaskItem[] = [];

        for (const task of tasks) {
            switch (task.priority) {
                case Priority.High:
                    high.push(task);
                    break;
                case Priority.Medium:
                    medium.push(task);
                    break;
                case Priority.Low:
                    low.push(task);
                    break;
                default:
                    none.push(task);
                    break;
            }
        }

        const groups = new Map<string, TaskItem[]>();
        if (high.length) groups.set('High', high);
        if (medium.length) groups.set('Medium', medium);
        if (low.length) groups.set('Low', low);
        if (none.length) groups.set('No Priority', none);
        return groups;
    }

    private groupByDueDate(tasks: TaskItem[], weekStartDay?: number): Map<string, TaskItem[]> {
        const overdue: TaskItem[] = [];
        const today: TaskItem[] = [];
        const thisWeek: TaskItem[] = [];
        const later: TaskItem[] = [];
        const noDate: TaskItem[] = [];

        // Precompute reference dates to avoid repeated allocations
        const now = new Date();
        const refTodayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        for (const task of tasks) {
            if (task.dueDate == null) {
                noDate.push(task);
            } else if (isOverdue(task.dueDate, refTodayStart)) {
                overdue.push(task);
            } else if (isToday(task.dueDate, now)) {
                today.push(task);
            } else if (isThisWeek(task.dueDate, weekStartDay)) {
                thisWeek.push(task);
            } else {
                later.push(task);
            }
        }

        const groups = new Map<string, TaskItem[]>();
        if (overdue.length) groups.set('Overdue', overdue);
        if (today.length) groups.set('Today', today);
        if (thisWeek.length) groups.set('This Week', thisWeek);
        if (later.length) groups.set('Later', later);
        if (noDate.length) groups.set('No Date', noDate);
        return groups;
    }
}
