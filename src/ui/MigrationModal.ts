import { App, Modal, Notice, Setting } from 'obsidian';
import { TaskItem, TaskStatus, Priority, SprintTopic, PluginSettings, TeamMember } from '../types';
import { MigrationService, MigrationAction, MigrationDecision, MigrationResult, MorningReviewData } from '../services/migrationService';
import { TaskStore } from '../services/taskStore';
import { DailyNoteService } from '../services/dailyNoteService';
import { TeamMemberService, OverdueOneOnOne } from '../services/teamMemberService';
import { SprintTopicService } from '../services/sprintTopicService';
import { formatDateDisplay, isoToPluginDate } from '../utils/dateUtils';
import { buildTaskLine } from './InsertTaskModal';

export class MigrationModal extends Modal {
    private decisions: Map<string, MigrationDecision> = new Map();
    private summaryEl: HTMLElement | null = null;
    private selectedTasks: Set<string> = new Set();
    private selectedOpenPoints: Set<string> = new Set();
    private pickerSearchTimers: ReturnType<typeof setTimeout>[] = [];

    constructor(
        app: App,
        private migrationService: MigrationService,
        private dailyNotes: DailyNoteService,
        private store: TaskStore,
        private reviewData: MorningReviewData,
        private onComplete: (result: MigrationResult | null) => void,
        /** Optional — when omitted, the Overdue 1:1s section is hidden. Makes the
         *  modal usable in contexts that don't have a TeamMemberService wired up. */
        private teamService?: TeamMemberService,
        /** Optional — when omitted, the Waiting-on Topics section is hidden. */
        private topicService?: SprintTopicService,
        /** Optional — needed to resolve team-member emails to nicknames in the
         *  Waiting-on section and to read the stale threshold. */
        private settings?: PluginSettings,
    ) {
        super(app);
    }

    async onOpen(): Promise<void> {
        this.modalEl.addClass('friday-migration-modal');
        const { contentEl } = this;
        contentEl.empty();

        try {
            await this.dailyNotes.getOrCreateDailyNote(new Date());
        } catch (e) {
            new Notice(`Could not create today's daily note: ${e instanceof Error ? e.message : 'unknown error'}`);
        }

        contentEl.createEl('h2', { text: 'Morning Review' });

        const overdueOneOnOnes = this.teamService?.getOverdueOneOnOnes() ?? [];
        if (overdueOneOnOnes.length > 0) {
            this.renderOverdueOneOnOnes(contentEl, overdueOneOnOnes);
        }

        const staleWaitingTopics = await this.getStaleWaitingTopics();
        if (staleWaitingTopics.length > 0) {
            this.renderStaleWaitingTopics(contentEl, staleWaitingTopics);
        }

        const { yesterdayTasks, overdueTasks, todayTasks } = this.reviewData;
        const hasActionable = yesterdayTasks.length > 0 || overdueTasks.length > 0;

        if (!hasActionable && todayTasks.length === 0 && overdueOneOnOnes.length === 0 && staleWaitingTopics.length === 0) {
            contentEl.createEl('p', {
                text: 'No tasks to review. Your slate is clean!',
                cls: 'friday-empty'
            });
            this.renderQuickAdd(contentEl);
            this.renderCloseButton(contentEl);
            return;
        }

        // Section 1: Incomplete tasks from the most recent prior daily note
        if (yesterdayTasks.length > 0) {
            const label = this.reviewData.yesterdayDate
                ? `Incomplete from ${formatDateDisplay(new Date(this.reviewData.yesterdayDate + 'T00:00:00'))}`
                : "Yesterday's Incomplete";
            this.renderSection(contentEl, label, yesterdayTasks, true);
        }

        // Section 2: Overdue tasks from elsewhere
        if (overdueTasks.length > 0) {
            this.renderSection(contentEl, 'Overdue', overdueTasks, true);
        }

        // Section 3: Due today (read-only preview with optional actions)
        if (todayTasks.length > 0) {
            this.renderSection(contentEl, 'Due Today', todayTasks, false);
        }

        // Summary bar
        if (hasActionable) {
            this.summaryEl = contentEl.createDiv({ cls: 'friday-migration-summary' });
            this.updateSummary();
        }

        // Picker: existing open tasks
        if (this.reviewData.availableTasks.length > 0) {
            this.renderPicker(contentEl, 'Pick from Open Tasks', this.reviewData.availableTasks, this.selectedTasks);
        }

        // Picker: open points
        if (this.reviewData.availableOpenPoints.length > 0) {
            this.renderPicker(contentEl, 'Pick from Open Points', this.reviewData.availableOpenPoints, this.selectedOpenPoints);
        }

        // Add selected button (if pickers have items)
        if (this.reviewData.availableTasks.length > 0 || this.reviewData.availableOpenPoints.length > 0) {
            const addSelectedContainer = contentEl.createDiv({ cls: 'friday-picker-actions' });
            const addSelectedBtn = addSelectedContainer.createEl('button', { text: 'Add Selected to Today', cls: 'mod-cta' });
            const addedFeedback = addSelectedContainer.createDiv({ cls: 'friday-picker-feedback' });

            addSelectedBtn.addEventListener('click', async () => {
                const allItems = [...this.reviewData.availableTasks, ...this.reviewData.availableOpenPoints];
                const itemMap = new Map(allItems.map(t => [t.id, t]));
                let added = 0;

                for (const id of this.selectedTasks) {
                    const task = itemMap.get(id);
                    if (task) {
                        await this.dailyNotes.addMigratedTask(task, new Date());
                        added++;
                    }
                }

                for (const id of this.selectedOpenPoints) {
                    const op = itemMap.get(id);
                    if (op) {
                        await this.dailyNotes.addMigratedTask(op, new Date());
                        added++;
                    }
                }

                if (added > 0) {
                    addedFeedback.textContent = `Added ${added} item(s) to today's daily note`;
                    addSelectedBtn.disabled = true;
                    this.selectedTasks.clear();
                    this.selectedOpenPoints.clear();
                }
            });
        }

        // Quick Add
        this.renderQuickAdd(contentEl);

        // Action buttons
        const buttonContainer = contentEl.createDiv({ cls: 'friday-migration-actions' });

        if (hasActionable) {
            const applyBtn = buttonContainer.createEl('button', { text: 'Apply', cls: 'mod-cta' });
            applyBtn.addEventListener('click', async () => {
                const decisions = Array.from(this.decisions.values());
                const result = await this.migrationService.executeMigrations(decisions);
                this.onComplete(result);
                this.close();
            });
        }

        const skipBtn = buttonContainer.createEl('button', { text: hasActionable ? 'Skip for Now' : 'Close' });
        skipBtn.addEventListener('click', () => {
            this.onComplete(null);
            this.close();
        });
    }

    onClose(): void {
        for (const timer of this.pickerSearchTimers) clearTimeout(timer);
        this.pickerSearchTimers = [];
        this.decisions.clear();
        this.selectedTasks.clear();
        this.selectedOpenPoints.clear();
        this.summaryEl = null;
        this.contentEl.empty();
    }

    private renderSection(container: HTMLElement, title: string, tasks: TaskItem[], actionable: boolean): void {
        const section = container.createDiv({ cls: 'friday-review-section' });
        const header = section.createDiv({ cls: 'friday-review-section-header' });
        header.createSpan({ text: title, cls: 'friday-review-section-title' });
        header.createSpan({ text: ` (${tasks.length})`, cls: 'friday-review-section-count' });

        for (const task of tasks) {
            if (actionable) {
                this.renderActionableTask(section, task);
            } else {
                this.renderPreviewTask(section, task);
            }
        }
    }

    private renderActionableTask(container: HTMLElement, task: TaskItem): void {
        const itemEl = container.createDiv({ cls: 'friday-migration-item' });

        // Task info
        const infoEl = itemEl.createDiv({ cls: 'friday-migration-item-info' });
        const textEl = infoEl.createDiv({ cls: 'friday-migration-item-text' });
        if (task.priority && task.priority !== Priority.None) {
            textEl.createSpan({ cls: `friday-priority-dot friday-priority-${task.priority}` });
        }
        textEl.createSpan({ text: task.text });

        const metaEl = infoEl.createDiv({ cls: 'friday-migration-item-meta' });
        metaEl.createSpan({ cls: 'friday-migration-item-source', text: this.getFileName(task.sourcePath) });
        if (task.dueDate) {
            metaEl.createSpan({ text: ' · ' });
            metaEl.createSpan({ cls: 'friday-migration-item-date', text: formatDateDisplay(task.dueDate) });
        }

        // Show children as read-only context
        if (task.childrenIds.length > 0) {
            for (const childId of task.childrenIds) {
                const child = this.store.getTaskById(childId);
                if (child) {
                    const childEl = itemEl.createDiv({ cls: 'friday-migration-subtask' });
                    const statusIcon = child.status === TaskStatus.Done ? '[x]' : child.status === TaskStatus.Cancelled ? '[-]' : '[ ]';
                    childEl.textContent = `${statusIcon} ${child.text}`;
                }
            }
        }

        // Action buttons
        const actionsEl = itemEl.createDiv({ cls: 'friday-migration-item-actions' });

        const actions: { action: MigrationAction; label: string; cls: string }[] = [
            { action: 'forward', label: 'Forward', cls: 'friday-btn-forward' },
            { action: 'reschedule', label: 'Reschedule', cls: 'friday-btn-reschedule' },
            { action: 'done', label: 'Done', cls: 'friday-btn-done' },
            { action: 'cancel', label: 'Cancel', cls: 'friday-btn-cancel' },
        ];

        const buttons: HTMLElement[] = [];
        const dateInputContainer = itemEl.createDiv({ cls: 'friday-migration-date-input' });
        dateInputContainer.style.display = 'none';
        const dateInput = dateInputContainer.createEl('input', { type: 'date' }) as HTMLInputElement;

        for (const { action, label, cls } of actions) {
            const btn = actionsEl.createEl('button', { text: label, cls });
            buttons.push(btn);

            btn.addEventListener('click', () => {
                const decision: MigrationDecision = { task, action };

                if (action === 'reschedule') {
                    dateInputContainer.style.display = '';
                    decision.newDate = dateInput.value ? isoToPluginDate(dateInput.value) : undefined;
                } else {
                    dateInputContainer.style.display = 'none';
                }

                this.decisions.set(task.id, decision);

                for (const b of buttons) {
                    b.removeClass('is-active');
                    b.addClass('is-dimmed');
                }
                btn.addClass('is-active');
                btn.removeClass('is-dimmed');

                this.updateSummary();
            });
        }

        dateInput.addEventListener('input', () => {
            const current = this.decisions.get(task.id);
            if (current && current.action === 'reschedule') {
                current.newDate = dateInput.value ? isoToPluginDate(dateInput.value) : undefined;
            }
        });

        // Default: forward is pre-selected
        this.decisions.set(task.id, { task, action: 'forward' });
        buttons[0].addClass('is-active');
        for (let i = 1; i < buttons.length; i++) buttons[i].addClass('is-dimmed');
    }

    private renderPreviewTask(container: HTMLElement, task: TaskItem): void {
        const itemEl = container.createDiv({ cls: 'friday-migration-item friday-preview-item' });

        const infoEl = itemEl.createDiv({ cls: 'friday-migration-item-info' });
        const textEl = infoEl.createDiv({ cls: 'friday-migration-item-text' });
        if (task.priority && task.priority !== Priority.None) {
            textEl.createSpan({ cls: `friday-priority-dot friday-priority-${task.priority}` });
        }
        textEl.createSpan({ text: task.text });

        const metaEl = infoEl.createDiv({ cls: 'friday-migration-item-meta' });
        metaEl.createSpan({ cls: 'friday-migration-item-source', text: this.getFileName(task.sourcePath) });

        // Show children as read-only context
        if (task.childrenIds.length > 0) {
            for (const childId of task.childrenIds) {
                const child = this.store.getTaskById(childId);
                if (child) {
                    const childEl = itemEl.createDiv({ cls: 'friday-migration-subtask' });
                    const statusIcon = child.status === TaskStatus.Done ? '[x]' : child.status === TaskStatus.Cancelled ? '[-]' : '[ ]';
                    childEl.textContent = `${statusIcon} ${child.text}`;
                }
            }
        }
    }

    private renderQuickAdd(container: HTMLElement): void {
        const section = container.createDiv({ cls: 'friday-review-quickadd' });
        section.createEl('h3', { text: 'Add Task for Today' });

        const form = section.createDiv({ cls: 'friday-add-form' });

        const textInput = form.createEl('input', {
            type: 'text', placeholder: 'New task...', cls: 'friday-add-input'
        });

        const prioritySelect = form.createEl('select', { cls: 'friday-add-priority' });
        const opts: [string, string][] = [['none', '--'], ['high', 'H'], ['medium', 'M'], ['low', 'L']];
        for (const [val, label] of opts) {
            prioritySelect.createEl('option', { value: val, text: label });
        }

        const dateInput = form.createEl('input', {
            type: 'date', cls: 'friday-add-date'
        });

        const addBtn = form.createEl('button', { text: '+ Add', cls: 'friday-add-btn' });

        const addedList = section.createDiv({ cls: 'friday-review-added' });

        const doAdd = async () => {
            const text = textInput.value.trim();
            if (!text) return;
            const priority = prioritySelect.value;
            const due = dateInput.value ? isoToPluginDate(dateInput.value) : '';
            const line = buildTaskLine(text, priority, due);

            await this.dailyNotes.addRawTaskLine(line, new Date());

            addedList.createDiv({ cls: 'friday-muted', text: `Added: ${text}` });
            textInput.value = '';
            dateInput.value = '';
            prioritySelect.value = 'none';
            textInput.focus();
        };

        addBtn.addEventListener('click', doAdd);
        textInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doAdd();
        });
    }

    private renderPicker(container: HTMLElement, title: string, items: TaskItem[], selectedSet: Set<string>): void {
        const section = container.createDiv({ cls: 'friday-picker-section' });

        const header = section.createDiv({ cls: 'friday-picker-header' });
        header.createSpan({ text: title, cls: 'friday-review-section-title' });
        header.createSpan({ text: ` (${items.length})`, cls: 'friday-review-section-count' });

        // Search filter
        const searchInput = section.createEl('input', {
            type: 'text',
            placeholder: 'Search...',
            cls: 'friday-picker-search'
        });

        const listEl = section.createDiv({ cls: 'friday-picker-list' });
        const MAX_VISIBLE = 50;

        const renderList = (query: string) => {
            listEl.empty();
            const q = query.toLowerCase();
            const filtered = q
                ? items.filter(t => t.text.toLowerCase().includes(q) || t.sourcePath.toLowerCase().includes(q))
                : items;

            const visible = filtered.slice(0, MAX_VISIBLE);

            if (visible.length === 0) {
                listEl.createDiv({ cls: 'friday-muted', text: 'No items match' });
                return;
            }

            for (const item of visible) {
                const row = listEl.createDiv({ cls: 'friday-picker-item' });

                const checkbox = row.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
                checkbox.checked = selectedSet.has(item.id);
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        selectedSet.add(item.id);
                    } else {
                        selectedSet.delete(item.id);
                    }
                });

                const textEl = row.createDiv({ cls: 'friday-picker-item-text' });
                if (item.priority && item.priority !== Priority.None) {
                    textEl.createSpan({ cls: `friday-priority-dot friday-priority-${item.priority}` });
                }
                textEl.createSpan({ text: item.text });

                const sourceEl = row.createDiv({ cls: 'friday-picker-item-source' });
                sourceEl.textContent = this.getFileName(item.sourcePath);
                if (item.dueDate) {
                    sourceEl.textContent += ` · ${formatDateDisplay(item.dueDate)}`;
                }
            }

            if (filtered.length > MAX_VISIBLE) {
                listEl.createDiv({ cls: 'friday-muted', text: `+ ${filtered.length - MAX_VISIBLE} more (use search to narrow)` });
            }
        };

        renderList('');

        let searchTimer: ReturnType<typeof setTimeout> | null = null;
        searchInput.addEventListener('input', () => {
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(() => renderList(searchInput.value.trim()), 200);
            this.pickerSearchTimers.push(searchTimer!);
        });
    }

    private renderCloseButton(container: HTMLElement): void {
        const buttonContainer = container.createDiv({ cls: 'friday-migration-actions' });
        const closeBtn = buttonContainer.createEl('button', { text: 'Close' });
        closeBtn.addEventListener('click', () => {
            this.onComplete(null);
            this.close();
        });
    }

    /** Top-of-modal nudge: team members whose 1:1 cadence has elapsed.
     *  Each row offers a single "Schedule 1:1" action that appends a reminder
     *  line to today's daily note — the author still decides when to actually
     *  hold the 1:1 and can trigger `Start 1:1` from the Team view at that point. */
    private renderOverdueOneOnOnes(container: HTMLElement, overdue: OverdueOneOnOne[]): void {
        const section = container.createDiv({ cls: 'friday-review-section friday-review-oneonones' });
        const header = section.createDiv({ cls: 'friday-review-section-header' });
        header.createSpan({ text: 'Overdue 1:1s', cls: 'friday-review-section-title' });
        header.createSpan({ text: ` (${overdue.length})`, cls: 'friday-review-section-count' });

        for (const { member, daysOverdue } of overdue) {
            const row = section.createDiv({ cls: 'friday-migration-item friday-oneonone-row' });

            const infoEl = row.createDiv({ cls: 'friday-migration-item-info' });
            const textEl = infoEl.createDiv({ cls: 'friday-migration-item-text' });
            textEl.createSpan({ text: member.name, cls: 'friday-oneonone-name' });
            if (member.role) {
                textEl.createSpan({ text: ` — ${member.role}`, cls: 'friday-oneonone-role' });
            }

            const metaEl = infoEl.createDiv({ cls: 'friday-migration-item-meta' });
            metaEl.createSpan({
                cls: 'friday-oneonone-overdue',
                text: `${daysOverdue}d overdue · cadence ${member.cadence}`,
            });

            const actionsEl = row.createDiv({ cls: 'friday-migration-item-actions' });
            const scheduleBtn = actionsEl.createEl('button', {
                text: 'Schedule 1:1',
                cls: 'friday-btn-forward',
            });
            scheduleBtn.addEventListener('click', async () => {
                try {
                    // Append a plain checkbox reminder with a @to-style annotation so the
                    // user can convert it into a calendar event or mark it done later.
                    // Kept as a raw task line so it appears in the regular Friday daily view.
                    const line = `- [ ] Schedule 1:1 with [[${member.name}]] (${daysOverdue}d overdue)`;
                    await this.dailyNotes.addRawTaskLine(line, new Date());
                    scheduleBtn.setText('Scheduled ✓');
                    scheduleBtn.disabled = true;
                    scheduleBtn.addClass('is-active');
                } catch (e) {
                    new Notice(`Could not schedule reminder: ${e instanceof Error ? e.message : 'unknown error'}`);
                }
            });
        }
    }

    /** Topics the user is waiting on where either no nudge was ever logged, or the last
     *  nudge is older than the configured threshold. Returns empty if no service wired up. */
    private async getStaleWaitingTopics(): Promise<SprintTopic[]> {
        if (!this.topicService) return [];
        const threshold = this.settings?.nudgeThresholdDays ?? 7;
        const all = await this.topicService.getAllTopics();
        const now = new Date();
        const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        return all
            .filter(t => t.status !== 'done' && t.waitingOn)
            .filter(t => {
                if (!t.lastNudged) return true;
                if (!/^\d{4}-\d{2}-\d{2}$/.test(t.lastNudged)) return true;
                const then = new Date(t.lastNudged + 'T00:00:00').getTime();
                if (isNaN(then)) return true;
                const daysSince = Math.floor((todayMs - then) / (24 * 60 * 60 * 1000));
                return daysSince > threshold;
            });
    }

    /** Section: topics waiting on someone with no recent nudge. Each row lets the user
     *  mark the nudge as done (updates `lastNudged`) or clear the waitingOn flag. */
    private renderStaleWaitingTopics(container: HTMLElement, topics: SprintTopic[]): void {
        const section = container.createDiv({ cls: 'friday-review-section friday-review-waiting' });
        const header = section.createDiv({ cls: 'friday-review-section-header' });
        header.createSpan({ text: 'Waiting on', cls: 'friday-review-section-title' });
        header.createSpan({ text: ` (${topics.length})`, cls: 'friday-review-section-count' });

        const members: TeamMember[] = this.settings?.teamMembers ?? [];
        const byEmail = new Map(members.map(m => [m.email, m]));

        for (const topic of topics) {
            const row = section.createDiv({ cls: 'friday-migration-item friday-waiting-row' });

            const infoEl = row.createDiv({ cls: 'friday-migration-item-info' });
            const textEl = infoEl.createDiv({ cls: 'friday-migration-item-text' });
            textEl.createSpan({ text: topic.title, cls: 'friday-waiting-topic' });

            const waitingOn = topic.waitingOn ?? '';
            const member = byEmail.get(waitingOn);
            const label = member ? (member.nickname || member.fullName || member.email) : waitingOn;

            const metaEl = infoEl.createDiv({ cls: 'friday-migration-item-meta' });
            const summary = topic.lastNudged
                ? `Waiting on ${label} · last nudged ${topic.lastNudged}`
                : `Waiting on ${label} · never nudged`;
            metaEl.createSpan({ text: summary, cls: 'friday-waiting-meta' });

            const actionsEl = row.createDiv({ cls: 'friday-migration-item-actions' });

            const nudgedBtn = actionsEl.createEl('button', {
                text: 'Just nudged',
                cls: 'friday-btn-forward',
            });
            nudgedBtn.addEventListener('click', async () => {
                try {
                    await this.topicService!.markNudged(topic.filePath);
                    nudgedBtn.setText('Nudged ✓');
                    nudgedBtn.disabled = true;
                    nudgedBtn.addClass('is-active');
                } catch (e) {
                    new Notice(`Could not mark nudged: ${e instanceof Error ? e.message : 'unknown error'}`);
                }
            });

            const clearBtn = actionsEl.createEl('button', {
                text: 'Unblock',
                cls: 'friday-btn',
            });
            clearBtn.addEventListener('click', async () => {
                try {
                    await this.topicService!.updateTopicFrontmatter(topic.filePath, {
                        waitingOn: null,
                        lastNudged: null,
                    });
                    clearBtn.setText('Cleared ✓');
                    clearBtn.disabled = true;
                    nudgedBtn.disabled = true;
                    clearBtn.addClass('is-active');
                } catch (e) {
                    new Notice(`Could not unblock: ${e instanceof Error ? e.message : 'unknown error'}`);
                }
            });
        }
    }

    private updateSummary(): void {
        if (!this.summaryEl) return;
        let forwarded = 0, rescheduled = 0, cancelled = 0, completed = 0;
        for (const d of this.decisions.values()) {
            switch (d.action) {
                case 'forward': forwarded++; break;
                case 'reschedule': rescheduled++; break;
                case 'done': completed++; break;
                case 'cancel': cancelled++; break;
            }
        }
        const parts: string[] = [];
        if (forwarded) parts.push(`${forwarded} forward`);
        if (rescheduled) parts.push(`${rescheduled} reschedule`);
        if (completed) parts.push(`${completed} done`);
        if (cancelled) parts.push(`${cancelled} cancel`);
        this.summaryEl.textContent = parts.join(' · ') || 'Select actions for tasks';
    }

    private getFileName(path: string): string {
        const segments = path.replace(/\\/g, '/').split('/');
        const filename = segments[segments.length - 1] || '';
        return filename.replace(/\.md$/, '');
    }
}
