import { Vault, TFile, TAbstractFile, EventRef } from 'obsidian';
import { TaskItem, TaskStatus, PluginSettings, SprintTopic, TeamMemberPage, OneOnOneSession } from '../types';
import { parseTasksFromContent } from '../parser/taskParser';
import { parseTopicFile } from '../parser/topicParser';
import { parseTeamMemberPage, parseOneOnOneSession } from '../parser/teamMemberParser';
import { HeadingClassifier } from '../parser/headingClassifier';
import { shouldIncludeFile } from '../utils/pathUtils';
import { SCAN_DEBOUNCE_MS, SCAN_BATCH_SIZE } from '../constants';
import { TaskWriter } from './taskWriter';

export class VaultScanner {
    private tasksByFile: Map<string, TaskItem[]> = new Map();
    private cachedAllTasks: TaskItem[] | null = null;
    private topicsByFile: Map<string, SprintTopic> = new Map();
    private cachedAllTopics: SprintTopic[] | null = null;
    // Team pages are stored without session composition — `getAllTeamPages` folds
    // in `sessionsByFile` on read so there's only one source of truth per field.
    private teamPagesByFile: Map<string, TeamMemberPage> = new Map();
    private sessionsByFile: Map<string, OneOnOneSession> = new Map();
    private cachedAllTeamPages: TeamMemberPage[] | null = null;
    private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private eventRefs: EventRef[] = [];
    private onChangeCallbacks: (() => void)[] = [];
    private onTopicsChangeCallbacks: (() => void)[] = [];
    private onTeamChangeCallbacks: (() => void)[] = [];
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

    /** Check if a file is a person page: {teamFolderPath}/{Name}/{Name}.md.
     *  A file qualifies only when its basename (minus .md) matches its parent folder name —
     *  this distinguishes the canonical page from other notes a user might drop inside the folder. */
    private isTeamMemberFile(path: string): boolean {
        const teamPath = this.getSettings().teamFolderPath;
        if (!teamPath || !path.startsWith(teamPath + '/')) return false;
        const rel = path.substring(teamPath.length + 1);
        const parts = rel.split('/');
        // Exactly two segments — `{Name}/{Name}.md`
        if (parts.length !== 2) return false;
        if (!parts[1].endsWith('.md')) return false;
        return parts[0] === parts[1].replace(/\.md$/, '');
    }

    /** Check if a file is a 1:1 session: {teamFolderPath}/{Name}/1on1/*.md */
    private isOneOnOneFile(path: string): boolean {
        const teamPath = this.getSettings().teamFolderPath;
        if (!teamPath || !path.startsWith(teamPath + '/')) return false;
        const rel = path.substring(teamPath.length + 1);
        const parts = rel.split('/');
        // Exactly three segments: `{Name}/1on1/YYYY-MM-DD.md`. Requiring the ISO
        // date filename aligns detection with parseOneOnOneSession's own regex —
        // an oddly-named .md dropped in a 1on1/ folder is treated as a regular
        // task file instead of being silently dropped from scanning.
        return parts.length === 3
            && parts[1] === '1on1'
            && /^\d{4}-\d{2}-\d{2}\.md$/.test(parts[2]);
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
        this.teamPagesByFile.clear();
        this.sessionsByFile.clear();
        this.cachedAllTeamPages = null;

        const classifier = new HeadingClassifier(settings.taskHeadings, settings.openPointHeadings, settings.inboxHeadings);
        this.cachedClassifier = classifier;

        // Process files in parallel batches
        let topicsChanged = false;
        let teamChanged = false;
        for (let i = 0; i < files.length; i += SCAN_BATCH_SIZE) {
            const batch = files.slice(i, i + SCAN_BATCH_SIZE);
            const results = await Promise.all(
                batch.map(async (file) => {
                    // Per-file try/catch: one bad file (broken frontmatter,
                    // unexpected parser throw) must not reject Promise.all and
                    // leave tasksByFile partially populated for the whole vault.
                    try {
                        const isTopic = this.isTopicFile(file.path);
                        const isTeamMember = this.isTeamMemberFile(file.path);
                        const isOneOnOne = this.isOneOnOneFile(file.path);
                        // Skip reading content for session files — only the path is needed.
                        const needsContent = !isOneOnOne;
                        const content = needsContent ? await this.vault.cachedRead(file) : '';
                        return {
                            path: file.path,
                            tasks: parseTasksFromContent(content, file.path, classifier, settings.workTypes, settings.purposes),
                            topic: isTopic ? parseTopicFile(content, file.path) : null,
                            teamPage: isTeamMember ? parseTeamMemberPage(content, file.path) : null,
                            session: isOneOnOne ? parseOneOnOneSession(file.path) : null,
                        };
                    } catch (e) {
                        console.warn('[Friday scan] failed to process', file.path, e);
                        return { path: file.path, tasks: [], topic: null, teamPage: null, session: null };
                    }
                })
            );
            for (const { path, tasks, topic, teamPage, session } of results) {
                if (tasks.length > 0) {
                    this.tasksByFile.set(path, tasks);
                }
                if (topic) {
                    this.topicsByFile.set(path, topic);
                    topicsChanged = true;
                }
                if (teamPage) {
                    this.teamPagesByFile.set(path, teamPage);
                    teamChanged = true;
                }
                if (session) {
                    this.sessionsByFile.set(path, session);
                    teamChanged = true;
                }
            }
        }

        this.notifyChange();
        if (topicsChanged) this.notifyTopicsChange();
        if (teamChanged) this.notifyTeamChange();
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
            let teamChanged = false;
            if (this.tasksByFile.delete(file.path)) {
                this.cachedAllTasks = null;
                changed = true;
            }
            if (this.topicsByFile.delete(file.path)) {
                this.cachedAllTopics = null;
                this.notifyTopicsChange();
            }
            if (this.teamPagesByFile.delete(file.path)) {
                this.cachedAllTeamPages = null;
                teamChanged = true;
            }
            if (this.sessionsByFile.delete(file.path)) {
                this.cachedAllTeamPages = null; // last-session date is derived from sessions
                teamChanged = true;
            }
            if (changed) this.notifyChange();
            if (teamChanged) this.notifyTeamChange();
        });

        const renameRef = this.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
            this.cancelDebounce(oldPath);
            this.tasksByFile.delete(oldPath);
            this.cachedAllTasks = null;
            if (this.topicsByFile.delete(oldPath)) {
                this.cachedAllTopics = null;
            }
            let teamChanged = false;
            if (this.teamPagesByFile.delete(oldPath)) {
                this.cachedAllTeamPages = null;
                teamChanged = true;
            }
            if (this.sessionsByFile.delete(oldPath)) {
                this.cachedAllTeamPages = null;
                teamChanged = true;
            }
            if (file instanceof TFile && file.extension === 'md') {
                this.debounceScanFile(file);
            } else {
                this.notifyChange();
                if (teamChanged) this.notifyTeamChange();
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

    /** Get all team pages, composed with their current session data.
     *  `sessionPaths` and `lastOneOnOne` are (re)derived here from `sessionsByFile`
     *  so adding/deleting a session file doesn't require rewriting the person page. */
    getAllTeamPages(): TeamMemberPage[] {
        if (this.cachedAllTeamPages) return this.cachedAllTeamPages;

        // Build a {folderPath -> session[]} index once, rather than O(members * sessions).
        const sessionsByMember = new Map<string, OneOnOneSession[]>();
        this.sessionsByFile.forEach(session => {
            const list = sessionsByMember.get(session.memberFolderPath) ?? [];
            list.push(session);
            sessionsByMember.set(session.memberFolderPath, list);
        });

        const result: TeamMemberPage[] = [];
        this.teamPagesByFile.forEach(page => {
            const sessions = sessionsByMember.get(page.folderPath) ?? [];
            let lastOneOnOne: Date | null = null;
            const sessionPaths: string[] = [];
            for (const s of sessions) {
                sessionPaths.push(s.filePath);
                if (s.sessionDate && (!lastOneOnOne || s.sessionDate > lastOneOnOne)) {
                    lastOneOnOne = s.sessionDate;
                }
            }
            result.push({ ...page, sessionPaths, lastOneOnOne });
        });

        this.cachedAllTeamPages = result;
        return result;
    }

    /** Get 1:1 sessions belonging to a specific person (by their folder path). */
    getSessionsForMember(memberFolderPath: string): OneOnOneSession[] {
        const out: OneOnOneSession[] = [];
        this.sessionsByFile.forEach(s => {
            if (s.memberFolderPath === memberFolderPath) out.push(s);
        });
        return out;
    }

    /** Register a callback for when tasks change */
    onChange(callback: () => void): void {
        this.onChangeCallbacks.push(callback);
    }

    /** Register a callback for when topics change */
    onTopicsChange(callback: () => void): void {
        this.onTopicsChangeCallbacks.push(callback);
    }

    /** Register a callback for when team pages or 1:1 sessions change. */
    onTeamChange(callback: () => void): void {
        this.onTeamChangeCallbacks.push(callback);
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
        this.onTeamChangeCallbacks = [];
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
            let teamChanged = false;
            if (this.teamPagesByFile.delete(file.path)) { this.cachedAllTeamPages = null; teamChanged = true; }
            if (this.sessionsByFile.delete(file.path)) { this.cachedAllTeamPages = null; teamChanged = true; }
            if (teamChanged) this.notifyTeamChange();
            return;
        }

        // Skip scan if this modify was triggered by a sync write
        if (this.writer?.isSyncing) return;

        // Use vault.read() instead of cachedRead() to get the latest content
        const content = await this.vault.read(file);
        const classifier = this.cachedClassifier ??
            new HeadingClassifier(settings.taskHeadings, settings.openPointHeadings, settings.inboxHeadings);
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

        // Team-management indexing: person page vs 1:1 session.
        // A single change to either invalidates the composed team page cache so
        // the overview re-renders with fresh session counts / last-session dates.
        if (this.isTeamMemberFile(file.path)) {
            this.teamPagesByFile.set(file.path, parseTeamMemberPage(content, file.path));
            this.cachedAllTeamPages = null;
            this.notifyTeamChange();
        } else if (this.isOneOnOneFile(file.path)) {
            this.sessionsByFile.set(file.path, parseOneOnOneSession(file.path));
            this.cachedAllTeamPages = null;
            this.notifyTeamChange();
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

    private notifyTeamChange(): void {
        for (const callback of this.onTeamChangeCallbacks) {
            callback();
        }
    }
}
