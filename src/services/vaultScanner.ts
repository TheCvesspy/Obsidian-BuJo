import { Vault, TFile, TAbstractFile, EventRef } from 'obsidian';
import { TaskItem, TaskStatus, PluginSettings, SprintTopic } from '../types';
import { parseTasksFromContent } from '../parser/taskParser';
import { parseTopicFile } from '../parser/topicParser';
import { HeadingClassifier } from '../parser/headingClassifier';
import { shouldIncludeFile } from '../utils/pathUtils';
import { SCAN_DEBOUNCE_MS, SCAN_BATCH_SIZE } from '../constants';
import { TaskWriter } from './taskWriter';

export class VaultScanner {
    private tasksByFile: Map<string, TaskItem[]> = new Map();
    private cachedAllTasks: TaskItem[] | null = null;
    private topicsByFile: Map<string, SprintTopic> = new Map();
    private cachedAllTopics: SprintTopic[] | null = null;
    private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private eventRefs: EventRef[] = [];
    private onChangeCallbacks: (() => void)[] = [];
    private onTopicsChangeCallbacks: (() => void)[] = [];
    private writer: TaskWriter | null = null;
    private cachedClassifier: HeadingClassifier | null = null;

    constructor(private vault: Vault, private getSettings: () => PluginSettings) {}

    /** Set the task writer for two-way sync */
    setWriter(writer: TaskWriter): void {
        this.writer = writer;
    }

    /** Invalidate cached classifier (call when heading settings change) */
    invalidateClassifier(): void {
        this.cachedClassifier = null;
    }

    /** Check if a file path is inside the sprint topics folder */
    private isTopicFile(path: string): boolean {
        const topicsPath = this.getSettings().sprintTopicsPath;
        return topicsPath.length > 0 && path.startsWith(topicsPath + '/');
    }

    /** Perform initial full scan of the vault */
    async fullScan(): Promise<void> {
        const settings = this.getSettings();
        const files = this.vault.getMarkdownFiles().filter(file =>
            shouldIncludeFile(file.path, settings.folderStates)
        );

        this.tasksByFile.clear();
        this.cachedAllTasks = null;
        this.topicsByFile.clear();
        this.cachedAllTopics = null;

        const classifier = new HeadingClassifier(settings.taskHeadings, settings.openPointHeadings, settings.goalHeadings);
        this.cachedClassifier = classifier;

        // Process files in parallel batches
        let topicsChanged = false;
        for (let i = 0; i < files.length; i += SCAN_BATCH_SIZE) {
            const batch = files.slice(i, i + SCAN_BATCH_SIZE);
            const results = await Promise.all(
                batch.map(async (file) => {
                    const content = await this.vault.cachedRead(file);
                    const isTopic = this.isTopicFile(file.path);
                    return {
                        path: file.path,
                        tasks: parseTasksFromContent(content, file.path, classifier, settings.workTypes, settings.purposes),
                        topic: isTopic ? parseTopicFile(content, file.path) : null,
                    };
                })
            );
            for (const { path, tasks, topic } of results) {
                if (tasks.length > 0) {
                    this.tasksByFile.set(path, tasks);
                }
                if (topic) {
                    this.topicsByFile.set(path, topic);
                    topicsChanged = true;
                }
            }
        }

        this.notifyChange();
        if (topicsChanged) this.notifyTopicsChange();
    }

    /** Get all tasks across all scanned files */
    getAllTasks(): TaskItem[] {
        if (!this.cachedAllTasks) {
            this.cachedAllTasks = [];
            this.tasksByFile.forEach(tasks => {
                this.cachedAllTasks!.push(...tasks);
            });
        }
        return this.cachedAllTasks;
    }

    /** Get tasks for a specific file */
    getTasksForFile(path: string): TaskItem[] {
        return this.tasksByFile.get(path) ?? [];
    }

    /**
     * Register vault event listeners for incremental updates.
     * Returns EventRef[] that should be cleaned up on plugin unload.
     */
    registerEvents(): EventRef[] {
        const modifyRef = this.vault.on('modify', (file: TAbstractFile) => {
            if (file instanceof TFile && file.extension === 'md') {
                this.debounceScanFile(file);
            }
        });

        const deleteRef = this.vault.on('delete', (file: TAbstractFile) => {
            this.cancelDebounce(file.path);
            let changed = false;
            if (this.tasksByFile.delete(file.path)) {
                this.cachedAllTasks = null;
                changed = true;
            }
            if (this.topicsByFile.delete(file.path)) {
                this.cachedAllTopics = null;
                this.notifyTopicsChange();
            }
            if (changed) this.notifyChange();
        });

        const renameRef = this.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
            this.cancelDebounce(oldPath);
            this.tasksByFile.delete(oldPath);
            this.cachedAllTasks = null;
            if (this.topicsByFile.delete(oldPath)) {
                this.cachedAllTopics = null;
            }
            if (file instanceof TFile && file.extension === 'md') {
                this.debounceScanFile(file);
            } else {
                this.notifyChange();
            }
        });

        const createRef = this.vault.on('create', (file: TAbstractFile) => {
            if (file instanceof TFile && file.extension === 'md') {
                // Delay slightly for new files — content may not be available immediately
                this.debounceScanFile(file);
            }
        });

        this.eventRefs = [modifyRef, deleteRef, renameRef, createRef];
        return this.eventRefs;
    }

    /** Get all sprint topics across all scanned topic files */
    getAllTopics(): SprintTopic[] {
        if (!this.cachedAllTopics) {
            this.cachedAllTopics = [];
            this.topicsByFile.forEach(topic => {
                this.cachedAllTopics!.push(topic);
            });
        }
        return this.cachedAllTopics;
    }

    /** Register a callback for when tasks change */
    onChange(callback: () => void): void {
        this.onChangeCallbacks.push(callback);
    }

    /** Register a callback for when topics change */
    onTopicsChange(callback: () => void): void {
        this.onTopicsChangeCallbacks.push(callback);
    }

    /** Clean up */
    destroy(): void {
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        this.eventRefs = [];
        this.onChangeCallbacks = [];
        this.onTopicsChangeCallbacks = [];
    }

    /** Per-file debounce so concurrent edits to different files don't cancel each other */
    private debounceScanFile(file: TFile): void {
        this.cancelDebounce(file.path);
        const timer = setTimeout(() => {
            this.debounceTimers.delete(file.path);
            this.scanFile(file);
        }, SCAN_DEBOUNCE_MS);
        this.debounceTimers.set(file.path, timer);
    }

    private cancelDebounce(path: string): void {
        const existing = this.debounceTimers.get(path);
        if (existing !== undefined) {
            clearTimeout(existing);
            this.debounceTimers.delete(path);
        }
    }

    private async scanFile(file: TFile): Promise<void> {
        const settings = this.getSettings();
        if (!shouldIncludeFile(file.path, settings.folderStates)) {
            if (this.tasksByFile.delete(file.path)) {
                this.cachedAllTasks = null;
                this.notifyChange();
            }
            if (this.topicsByFile.delete(file.path)) {
                this.cachedAllTopics = null;
                this.notifyTopicsChange();
            }
            return;
        }

        // Skip scan if this modify was triggered by a sync write
        if (this.writer?.isSyncing) return;

        // Use vault.read() instead of cachedRead() to get the latest content
        const content = await this.vault.read(file);
        const classifier = this.cachedClassifier ??
            new HeadingClassifier(settings.taskHeadings, settings.openPointHeadings, settings.goalHeadings);
        const newTasks = parseTasksFromContent(content, file.path, classifier, settings.workTypes, settings.purposes);

        // Detect status changes on migrated copies for two-way sync
        const oldTasks = this.tasksByFile.get(file.path) ?? [];
        if (this.writer) {
            this.detectAndSyncStatusChanges(oldTasks, newTasks);
        }

        if (newTasks.length > 0) {
            this.tasksByFile.set(file.path, newTasks);
        } else {
            this.tasksByFile.delete(file.path);
        }

        this.cachedAllTasks = null;
        this.notifyChange();

        // Also parse as topic if in the topics folder
        if (this.isTopicFile(file.path)) {
            const topic = parseTopicFile(content, file.path);
            this.topicsByFile.set(file.path, topic);
            this.cachedAllTopics = null;
            this.notifyTopicsChange();
        }
    }

    /**
     * Detect tasks with migratedFrom that changed to done/cancelled.
     * Trigger sync to update the original task.
     */
    private detectAndSyncStatusChanges(oldTasks: TaskItem[], newTasks: TaskItem[]): void {
        if (!this.writer) return;

        const oldById = new Map(oldTasks.map(t => [t.id, t]));

        for (const newTask of newTasks) {
            if (!newTask.migratedFrom) continue;

            const oldTask = oldById.get(newTask.id);
            if (!oldTask) continue;

            // Status changed to done or cancelled
            const wasOpen = oldTask.status === TaskStatus.Open;
            const nowTerminal = newTask.status === TaskStatus.Done || newTask.status === TaskStatus.Cancelled;

            if (wasOpen && nowTerminal) {
                // Fire-and-forget: sync original in background
                this.writer.syncOriginalStatus(newTask, newTask.status);
            }
        }
    }

    private notifyChange(): void {
        for (const callback of this.onChangeCallbacks) {
            callback();
        }
    }

    private notifyTopicsChange(): void {
        for (const callback of this.onTopicsChangeCallbacks) {
            callback();
        }
    }
}
