import {
    TaskItem,
    ItemCategory,
    TaskStatus,
    Priority,
    GroupMode,
    Sprint,
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
    private goalItems: TaskItem[] = [];
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
        this.goalItems = [];
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
                case ItemCategory.Goal:
                    this.goalItems.push(t);
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

    /** Get all items classified as Goals */
    getGoals(): TaskItem[] {
        return this.goalItems;
    }

    /** Get root goals from a specific file path */
    getGoalsForPath(path: string): TaskItem[] {
        return this.goalItems.filter(t => t.parentId === null && t.sourcePath === path);
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

    /** Tasks due within a sprint's date range */
    getTasksForSprint(sprint: Sprint): TaskItem[] {
        const start = new Date(sprint.startDate);
        const end = new Date(sprint.endDate);
        return this.getTasksForDateRange(start, end);
    }

    /** Open root tasks with due date before today */
    getOverdueTasks(): TaskItem[] {
        return this.taskItems.filter(
            t => t.parentId === null && t.dueDate != null && isOverdue(t.dueDate) && t.status === TaskStatus.Open
        );
    }

    /** Open root tasks with no due date */
    getUnscheduledTasks(): TaskItem[] {
        return this.taskItems.filter(
            t => t.parentId === null && t.dueDate == null && t.status === TaskStatus.Open
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
