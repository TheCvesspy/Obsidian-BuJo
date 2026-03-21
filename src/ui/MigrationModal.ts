import { App, Modal, Setting } from 'obsidian';
import { TaskItem, TaskStatus, Priority } from '../types';
import { MigrationService, MigrationAction, MigrationDecision, MigrationResult, MorningReviewData } from '../services/migrationService';
import { TaskStore } from '../services/taskStore';
import { DailyNoteService } from '../services/dailyNoteService';
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
        private onComplete: (result: MigrationResult | null) => void
    ) {
        super(app);
    }

    onOpen(): void {
        this.modalEl.addClass('task-bujo-migration-modal');
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Morning Review' });

        const { yesterdayTasks, overdueTasks, todayTasks } = this.reviewData;
        const hasActionable = yesterdayTasks.length > 0 || overdueTasks.length > 0;

        if (!hasActionable && todayTasks.length === 0) {
            contentEl.createEl('p', {
                text: 'No tasks to review. Your slate is clean!',
                cls: 'task-bujo-empty'
            });
            this.renderQuickAdd(contentEl);
            this.renderCloseButton(contentEl);
            return;
        }

        // Section 1: Yesterday's incomplete tasks
        if (yesterdayTasks.length > 0) {
            this.renderSection(contentEl, 'Yesterday\'s Incomplete', yesterdayTasks, true);
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
            this.summaryEl = contentEl.createDiv({ cls: 'task-bujo-migration-summary' });
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
            const addSelectedContainer = contentEl.createDiv({ cls: 'task-bujo-picker-actions' });
            const addSelectedBtn = addSelectedContainer.createEl('button', { text: 'Add Selected to Today', cls: 'mod-cta' });
            const addedFeedback = addSelectedContainer.createDiv({ cls: 'task-bujo-picker-feedback' });

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
        const buttonContainer = contentEl.createDiv({ cls: 'task-bujo-migration-actions' });

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
        const section = container.createDiv({ cls: 'task-bujo-review-section' });
        const header = section.createDiv({ cls: 'task-bujo-review-section-header' });
        header.createSpan({ text: title, cls: 'task-bujo-review-section-title' });
        header.createSpan({ text: ` (${tasks.length})`, cls: 'task-bujo-review-section-count' });

        for (const task of tasks) {
            if (actionable) {
                this.renderActionableTask(section, task);
            } else {
                this.renderPreviewTask(section, task);
            }
        }
    }

    private renderActionableTask(container: HTMLElement, task: TaskItem): void {
        const itemEl = container.createDiv({ cls: 'task-bujo-migration-item' });

        // Task info
        const infoEl = itemEl.createDiv({ cls: 'task-bujo-migration-item-info' });
        const textEl = infoEl.createDiv({ cls: 'task-bujo-migration-item-text' });
        if (task.priority && task.priority !== Priority.None) {
            textEl.createSpan({ cls: `task-bujo-priority-dot task-bujo-priority-${task.priority}` });
        }
        textEl.createSpan({ text: task.text });

        const metaEl = infoEl.createDiv({ cls: 'task-bujo-migration-item-meta' });
        metaEl.createSpan({ cls: 'task-bujo-migration-item-source', text: this.getFileName(task.sourcePath) });
        if (task.dueDate) {
            metaEl.createSpan({ text: ' · ' });
            metaEl.createSpan({ cls: 'task-bujo-migration-item-date', text: formatDateDisplay(task.dueDate) });
        }

        // Show children as read-only context
        if (task.childrenIds.length > 0) {
            for (const childId of task.childrenIds) {
                const child = this.store.getTaskById(childId);
                if (child) {
                    const childEl = itemEl.createDiv({ cls: 'task-bujo-migration-subtask' });
                    const statusIcon = child.status === TaskStatus.Done ? '[x]' : child.status === TaskStatus.Cancelled ? '[-]' : '[ ]';
                    childEl.textContent = `${statusIcon} ${child.text}`;
                }
            }
        }

        // Action buttons
        const actionsEl = itemEl.createDiv({ cls: 'task-bujo-migration-item-actions' });

        const actions: { action: MigrationAction; label: string; cls: string }[] = [
            { action: 'forward', label: 'Forward', cls: 'task-bujo-btn-forward' },
            { action: 'reschedule', label: 'Reschedule', cls: 'task-bujo-btn-reschedule' },
            { action: 'done', label: 'Done', cls: 'task-bujo-btn-done' },
            { action: 'cancel', label: 'Cancel', cls: 'task-bujo-btn-cancel' },
        ];

        const buttons: HTMLElement[] = [];
        const dateInputContainer = itemEl.createDiv({ cls: 'task-bujo-migration-date-input' });
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
        const itemEl = container.createDiv({ cls: 'task-bujo-migration-item task-bujo-preview-item' });

        const infoEl = itemEl.createDiv({ cls: 'task-bujo-migration-item-info' });
        const textEl = infoEl.createDiv({ cls: 'task-bujo-migration-item-text' });
        if (task.priority && task.priority !== Priority.None) {
            textEl.createSpan({ cls: `task-bujo-priority-dot task-bujo-priority-${task.priority}` });
        }
        textEl.createSpan({ text: task.text });

        const metaEl = infoEl.createDiv({ cls: 'task-bujo-migration-item-meta' });
        metaEl.createSpan({ cls: 'task-bujo-migration-item-source', text: this.getFileName(task.sourcePath) });

        // Show children as read-only context
        if (task.childrenIds.length > 0) {
            for (const childId of task.childrenIds) {
                const child = this.store.getTaskById(childId);
                if (child) {
                    const childEl = itemEl.createDiv({ cls: 'task-bujo-migration-subtask' });
                    const statusIcon = child.status === TaskStatus.Done ? '[x]' : child.status === TaskStatus.Cancelled ? '[-]' : '[ ]';
                    childEl.textContent = `${statusIcon} ${child.text}`;
                }
            }
        }
    }

    private renderQuickAdd(container: HTMLElement): void {
        const section = container.createDiv({ cls: 'task-bujo-review-quickadd' });
        section.createEl('h3', { text: 'Add Task for Today' });

        const form = section.createDiv({ cls: 'task-bujo-add-form' });

        const textInput = form.createEl('input', {
            type: 'text', placeholder: 'New task...', cls: 'task-bujo-add-input'
        });

        const prioritySelect = form.createEl('select', { cls: 'task-bujo-add-priority' });
        const opts: [string, string][] = [['none', '--'], ['high', 'H'], ['medium', 'M'], ['low', 'L']];
        for (const [val, label] of opts) {
            prioritySelect.createEl('option', { value: val, text: label });
        }

        const dateInput = form.createEl('input', {
            type: 'date', cls: 'task-bujo-add-date'
        });

        const addBtn = form.createEl('button', { text: '+ Add', cls: 'task-bujo-add-btn' });

        const addedList = section.createDiv({ cls: 'task-bujo-review-added' });

        const doAdd = async () => {
            const text = textInput.value.trim();
            if (!text) return;
            const priority = prioritySelect.value;
            const due = dateInput.value ? isoToPluginDate(dateInput.value) : '';
            const line = buildTaskLine(text, priority, due);

            await this.dailyNotes.addRawTaskLine(line, new Date());

            addedList.createDiv({ cls: 'task-bujo-muted', text: `Added: ${text}` });
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
        const section = container.createDiv({ cls: 'task-bujo-picker-section' });

        const header = section.createDiv({ cls: 'task-bujo-picker-header' });
        header.createSpan({ text: title, cls: 'task-bujo-review-section-title' });
        header.createSpan({ text: ` (${items.length})`, cls: 'task-bujo-review-section-count' });

        // Search filter
        const searchInput = section.createEl('input', {
            type: 'text',
            placeholder: 'Search...',
            cls: 'task-bujo-picker-search'
        });

        const listEl = section.createDiv({ cls: 'task-bujo-picker-list' });
        const MAX_VISIBLE = 50;

        const renderList = (query: string) => {
            listEl.empty();
            const q = query.toLowerCase();
            const filtered = q
                ? items.filter(t => t.text.toLowerCase().includes(q) || t.sourcePath.toLowerCase().includes(q))
                : items;

            const visible = filtered.slice(0, MAX_VISIBLE);

            if (visible.length === 0) {
                listEl.createDiv({ cls: 'task-bujo-muted', text: 'No items match' });
                return;
            }

            for (const item of visible) {
                const row = listEl.createDiv({ cls: 'task-bujo-picker-item' });

                const checkbox = row.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
                checkbox.checked = selectedSet.has(item.id);
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        selectedSet.add(item.id);
                    } else {
                        selectedSet.delete(item.id);
                    }
                });

                const textEl = row.createDiv({ cls: 'task-bujo-picker-item-text' });
                if (item.priority && item.priority !== Priority.None) {
                    textEl.createSpan({ cls: `task-bujo-priority-dot task-bujo-priority-${item.priority}` });
                }
                textEl.createSpan({ text: item.text });

                const sourceEl = row.createDiv({ cls: 'task-bujo-picker-item-source' });
                sourceEl.textContent = this.getFileName(item.sourcePath);
                if (item.dueDate) {
                    sourceEl.textContent += ` · ${formatDateDisplay(item.dueDate)}`;
                }
            }

            if (filtered.length > MAX_VISIBLE) {
                listEl.createDiv({ cls: 'task-bujo-muted', text: `+ ${filtered.length - MAX_VISIBLE} more (use search to narrow)` });
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
        const buttonContainer = container.createDiv({ cls: 'task-bujo-migration-actions' });
        const closeBtn = buttonContainer.createEl('button', { text: 'Close' });
        closeBtn.addEventListener('click', () => {
            this.onComplete(null);
            this.close();
        });
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
