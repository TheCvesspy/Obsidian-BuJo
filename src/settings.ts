import { App, Notice, PluginSettingTab, Setting, TFolder } from 'obsidian';
import {
    PluginSettings,
    FolderState,
    GroupMode,
    BuJoViewMode,
    TagCategory,
    DEFAULT_WORK_TYPES,
    DEFAULT_PURPOSES,
} from './types';
import { getEffectiveState } from './utils/pathUtils';
import { SETTINGS_DEBOUNCE_MS } from './constants';
import { JiraService } from './services/jiraService';
import { JiraDashboardService } from './services/jiraDashboardService';

interface TaskBuJoPlugin {
    settings: PluginSettings;
    saveSettings(requiresRescan?: boolean): Promise<void>;
    jiraService: JiraService;
    jiraDashboardService: JiraDashboardService;
}

/** Recursive folder tree node */
interface FolderNode {
    path: string;
    name: string;
    children: FolderNode[];
}

export class TaskBuJoSettingTab extends PluginSettingTab {
    plugin: TaskBuJoPlugin;
    /** Tracks which folder paths are collapsed (persists across re-renders) */
    private collapsedFolders: Set<string> = new Set();
    /** Reference to the tree container for partial re-renders */
    private treeContainer: HTMLElement | null = null;
    /** Debounce timer for text settings */
    private settingsDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(app: App, plugin: TaskBuJoPlugin) {
        super(app, plugin as any);
        this.plugin = plugin;
    }

    /** Debounced save for text input settings */
    private debouncedSave(requiresRescan: boolean): void {
        if (this.settingsDebounceTimer !== null) {
            clearTimeout(this.settingsDebounceTimer);
        }
        this.settingsDebounceTimer = setTimeout(async () => {
            this.settingsDebounceTimer = null;
            await this.plugin.saveSettings(requiresRescan);
        }, SETTINGS_DEBOUNCE_MS);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // ── Scanning ──────────────────────────────────────────────
        containerEl.createEl('h2', { text: 'Scanning' });
        containerEl.createEl('p', {
            text: 'Click folders to cycle their state: [+] Include → [-] Exclude → [~] Inherit from parent.',
            cls: 'setting-item-description'
        });

        this.renderFolderTree(containerEl);

        // ── Display ───────────────────────────────────────────────
        containerEl.createEl('h2', { text: 'Display' });

        new Setting(containerEl)
            .setName('Show completed tasks')
            .setDesc('Show or hide completed tasks in the task list.')
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.showCompletedTasks)
                    .onChange(async value => {
                        this.plugin.settings.showCompletedTasks = value;
                        await this.plugin.saveSettings(false);
                    })
            );

        new Setting(containerEl)
            .setName('Default grouping mode')
            .setDesc('How tasks are grouped by default.')
            .addDropdown(dropdown =>
                dropdown
                    .addOptions({
                        [GroupMode.ByPage]: 'By Page',
                        [GroupMode.ByPriority]: 'By Priority',
                        [GroupMode.ByDueDate]: 'By Due Date',
                    })
                    .setValue(this.plugin.settings.defaultGroupMode)
                    .onChange(async value => {
                        this.plugin.settings.defaultGroupMode = value as GroupMode;
                        await this.plugin.saveSettings(false);
                    })
            );

        new Setting(containerEl)
            .setName('Default view mode')
            .setDesc('The view mode shown when the plugin opens.')
            .addDropdown(dropdown =>
                dropdown
                    .addOptions({
                        [BuJoViewMode.Daily]: 'Daily',
                        [BuJoViewMode.Weekly]: 'Weekly',
                        [BuJoViewMode.Monthly]: 'Monthly',
                        [BuJoViewMode.Calendar]: 'Calendar',
                        [BuJoViewMode.Sprint]: 'Sprint',
                        [BuJoViewMode.Topics]: 'Topics',
                        [BuJoViewMode.Overdue]: 'Overdue',
                        [BuJoViewMode.Overview]: 'Overview',
                        [BuJoViewMode.Analytics]: 'Analytics',
                    })
                    .setValue(this.plugin.settings.defaultViewMode)
                    .onChange(async value => {
                        this.plugin.settings.defaultViewMode = value as BuJoViewMode;
                        await this.plugin.saveSettings(false);
                    })
            );

        // ── Classification ────────────────────────────────────────
        containerEl.createEl('h2', { text: 'Classification' });

        new Setting(containerEl)
            .setName('Task headings')
            .setDesc('Comma-separated heading names that identify task sections.')
            .addText(text =>
                text
                    .setPlaceholder('Tasks, TODO, Action Items')
                    .setValue(this.plugin.settings.taskHeadings.join(', '))
                    .onChange(value => {
                        this.plugin.settings.taskHeadings = value
                            .split(',')
                            .map(s => s.trim())
                            .filter(s => s.length > 0);
                        this.debouncedSave(true);
                    })
            );

        new Setting(containerEl)
            .setName('Open point headings')
            .setDesc('Comma-separated heading names that identify open-point sections.')
            .addText(text =>
                text
                    .setPlaceholder('Open Points, Questions, Discussion Points')
                    .setValue(this.plugin.settings.openPointHeadings.join(', '))
                    .onChange(value => {
                        this.plugin.settings.openPointHeadings = value
                            .split(',')
                            .map(s => s.trim())
                            .filter(s => s.length > 0);
                        this.debouncedSave(true);
                    })
            );

        new Setting(containerEl)
            .setName('Goal headings')
            .setDesc('Comma-separated heading names that identify goal sections.')
            .addText(text =>
                text
                    .setPlaceholder('Goals')
                    .setValue(this.plugin.settings.goalHeadings.join(', '))
                    .onChange(value => {
                        this.plugin.settings.goalHeadings = value
                            .split(',')
                            .map(s => s.trim())
                            .filter(s => s.length > 0);
                        this.debouncedSave(true);
                    })
            );

        // ── BuJo ──────────────────────────────────────────────────
        containerEl.createEl('h2', { text: 'BuJo' });

        new Setting(containerEl)
            .setName('Daily note folder path')
            .setDesc('Folder where daily notes are stored.')
            .addText(text =>
                text
                    .setPlaceholder('BuJo/Daily')
                    .setValue(this.plugin.settings.dailyNotePath)
                    .onChange(value => {
                        this.plugin.settings.dailyNotePath = value.trim();
                        this.debouncedSave(false);
                    })
            );

        new Setting(containerEl)
            .setName('Migration prompt on startup')
            .setDesc('Prompt to migrate incomplete tasks when Obsidian starts.')
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.migrationPromptOnStartup)
                    .onChange(async value => {
                        this.plugin.settings.migrationPromptOnStartup = value;
                        await this.plugin.saveSettings(false);
                    })
            );

        new Setting(containerEl)
            .setName('Monthly note folder path')
            .setDesc('Folder where monthly notes are stored.')
            .addText(text =>
                text
                    .setPlaceholder('BuJo/Monthly')
                    .setValue(this.plugin.settings.monthlyNotePath)
                    .onChange(value => {
                        this.plugin.settings.monthlyNotePath = value.trim();
                        this.debouncedSave(false);
                    })
            );

        new Setting(containerEl)
            .setName('Monthly migration prompt on startup')
            .setDesc('Prompt to migrate incomplete goals at the start of each month.')
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.monthlyMigrationPromptOnStartup)
                    .onChange(async value => {
                        this.plugin.settings.monthlyMigrationPromptOnStartup = value;
                        await this.plugin.saveSettings(false);
                    })
            );

        // ── Sprints ───────────────────────────────────────────────
        containerEl.createEl('h2', { text: 'Sprints' });

        new Setting(containerEl)
            .setName('Default sprint length')
            .setDesc('Length of a sprint in days.')
            .addText(text =>
                text
                    .setPlaceholder('14')
                    .setValue(String(this.plugin.settings.defaultSprintLength))
                    .onChange(value => {
                        const parsed = parseInt(value, 10);
                        if (!isNaN(parsed) && parsed > 0) {
                            this.plugin.settings.defaultSprintLength = parsed;
                            this.debouncedSave(false);
                        }
                    })
            );

        new Setting(containerEl)
            .setName('Sprint topics folder path')
            .setDesc('Folder where sprint topic files are stored.')
            .addText(text =>
                text
                    .setPlaceholder('BuJo/Sprints/Topics')
                    .setValue(this.plugin.settings.sprintTopicsPath)
                    .onChange(value => {
                        this.plugin.settings.sprintTopicsPath = value.trim();
                        this.debouncedSave(true);
                    })
            );

        new Setting(containerEl)
            .setName('Auto-start next sprint')
            .setDesc('Automatically start a new sprint when the current one ends.')
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.autoStartNextSprint)
                    .onChange(async value => {
                        this.plugin.settings.autoStartNextSprint = value;
                        await this.plugin.saveSettings(false);
                    })
            );

        new Setting(containerEl)
            .setName('Count work days only')
            .setDesc('Sprint duration and remaining days count only Mon–Fri (excludes weekends).')
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.sprintWorkDaysOnly)
                    .onChange(async value => {
                        this.plugin.settings.sprintWorkDaysOnly = value;
                        await this.plugin.saveSettings(false);
                    })
            );

        // ── Archive ──────────────────────────────────────────────
        containerEl.createEl('h2', { text: 'Archive' });

        new Setting(containerEl)
            .setName('Archive folder path')
            .setDesc('Folder where completed tasks are archived.')
            .addText(text =>
                text
                    .setPlaceholder('BuJo/Archive')
                    .setValue(this.plugin.settings.archiveFolderPath)
                    .onChange(value => {
                        this.plugin.settings.archiveFolderPath = value.trim();
                        this.debouncedSave(false);
                    })
            );

        new Setting(containerEl)
            .setName('Archive grouping')
            .setDesc('How archived tasks are organized into files.')
            .addDropdown(dropdown =>
                dropdown
                    .addOptions({
                        'month': 'By Month (2026-03.md)',
                        'source': 'By Source File',
                    })
                    .setValue(this.plugin.settings.archiveGroupBy)
                    .onChange(async value => {
                        this.plugin.settings.archiveGroupBy = value as 'month' | 'source';
                        await this.plugin.saveSettings(false);
                    })
            );

        // ── Views ────────────────────────────────────────────────
        containerEl.createEl('h2', { text: 'Views' });

        new Setting(containerEl)
            .setName('Urgency threshold (days)')
            .setDesc('Tasks due within this many days are considered "urgent" in the Eisenhower view.')
            .addText(text =>
                text
                    .setPlaceholder('2')
                    .setValue(String(this.plugin.settings.urgencyThresholdDays))
                    .onChange(value => {
                        const parsed = parseInt(value, 10);
                        if (!isNaN(parsed) && parsed >= 0) {
                            this.plugin.settings.urgencyThresholdDays = parsed;
                            this.debouncedSave(false);
                        }
                    })
            );

        // ── Analytics ─────────────────────────────────────────────
        containerEl.createEl('h2', { text: 'Analytics' });

        new Setting(containerEl)
            .setName('Week start day')
            .setDesc('First day of the week for analytics.')
            .addDropdown(dropdown =>
                dropdown
                    .addOptions({
                        '0': 'Sunday',
                        '1': 'Monday',
                        '2': 'Tuesday',
                        '3': 'Wednesday',
                        '4': 'Thursday',
                        '5': 'Friday',
                        '6': 'Saturday',
                    })
                    .setValue(String(this.plugin.settings.weekStartDay))
                    .onChange(async value => {
                        this.plugin.settings.weekStartDay = parseInt(value, 10);
                        await this.plugin.saveSettings(false);
                    })
            );

        new Setting(containerEl)
            .setName('Work types')
            .setDesc('Comma-separated: Name(Code). E.g. "Deep Work(DW), Review(RV)"')
            .addText(text =>
                text
                    .setPlaceholder('Deep Work(DW), Review(RV), ...')
                    .setValue(this.formatTagCategories(this.plugin.settings.workTypes))
                    .onChange(value => {
                        const parsed = this.parseTagCategories(value);
                        if (parsed.length > 0) {
                            this.plugin.settings.workTypes = parsed;
                            this.debouncedSave(true);
                        }
                    })
            );

        new Setting(containerEl)
            .setName('Purposes')
            .setDesc('Comma-separated: Name(Code). E.g. "Delivery(D), Capability(CA)"')
            .addText(text =>
                text
                    .setPlaceholder('Delivery(D), Capability(CA), ...')
                    .setValue(this.formatTagCategories(this.plugin.settings.purposes))
                    .onChange(value => {
                        const parsed = this.parseTagCategories(value);
                        if (parsed.length > 0) {
                            this.plugin.settings.purposes = parsed;
                            this.debouncedSave(true);
                        }
                    })
            );

        // ── JIRA Integration ─────────────────────────────────────
        containerEl.createEl('h2', { text: 'JIRA Integration' });
        containerEl.createEl('p', {
            text: 'Optional module. When enabled, topics with a "jira" frontmatter field (e.g. jira: PROJ-123) will fetch live status and assignee data from your JIRA Cloud instance. Credentials are stored in the plugin data file, alongside your vault.',
            cls: 'setting-item-description',
        });

        new Setting(containerEl)
            .setName('Enable JIRA integration')
            .setDesc('Master switch. When off, no fetches happen and no JIRA UI appears on cards.')
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.jiraEnabled)
                    .onChange(async value => {
                        this.plugin.settings.jiraEnabled = value;
                        await this.plugin.saveSettings(false);
                        // Re-render settings pane so conditional fields show/hide
                        this.display();
                    })
            );

        if (this.plugin.settings.jiraEnabled) {
            new Setting(containerEl)
                .setName('JIRA base URL')
                .setDesc('Your Atlassian Cloud URL, e.g. https://mycompany.atlassian.net (no trailing slash).')
                .addText(text =>
                    text
                        .setPlaceholder('https://mycompany.atlassian.net')
                        .setValue(this.plugin.settings.jiraBaseUrl)
                        .onChange(value => {
                            this.plugin.settings.jiraBaseUrl = value.trim().replace(/\/+$/, '');
                            this.debouncedSave(false);
                        })
                );

            new Setting(containerEl)
                .setName('Email')
                .setDesc('Your Atlassian account email (used as the Basic-auth username).')
                .addText(text =>
                    text
                        .setPlaceholder('you@example.com')
                        .setValue(this.plugin.settings.jiraEmail)
                        .onChange(value => {
                            this.plugin.settings.jiraEmail = value.trim();
                            this.debouncedSave(false);
                        })
                );

            new Setting(containerEl)
                .setName('API token')
                .setDesc('Personal API token from id.atlassian.com. Stored in plugin data.json — as sensitive as the rest of your vault.')
                .addText(text => {
                    text.inputEl.type = 'password';
                    text
                        .setPlaceholder('••••••••')
                        .setValue(this.plugin.settings.jiraApiToken)
                        .onChange(value => {
                            this.plugin.settings.jiraApiToken = value.trim();
                            this.debouncedSave(false);
                        });
                });

            new Setting(containerEl)
                .setName('Cache TTL (minutes)')
                .setDesc('How long to keep fetched issue data before re-hitting the API.')
                .addText(text =>
                    text
                        .setPlaceholder('10')
                        .setValue(String(this.plugin.settings.jiraCacheTtlMinutes))
                        .onChange(value => {
                            const parsed = parseInt(value, 10);
                            if (!isNaN(parsed) && parsed >= 0) {
                                this.plugin.settings.jiraCacheTtlMinutes = parsed;
                                this.debouncedSave(false);
                            }
                        })
                );

            // ── JIRA Dashboard sub-section ──────────────────────
            containerEl.createEl('h3', { text: 'JIRA Dashboard' });
            containerEl.createEl('p', {
                text: 'Controls the JIRA Dashboard view — a read-only list of issues where you are assignee, reporter, or watcher. One JQL round-trip per refresh; no background polling.',
                cls: 'setting-item-description',
            });

            new Setting(containerEl)
                .setName('Dashboard projects')
                .setDesc('Comma-separated JIRA project keys to limit the dashboard search (e.g. "PROJ, DEV"). Leave empty to include all projects you can see.')
                .addText(text =>
                    text
                        .setPlaceholder('PROJ, DEV')
                        .setValue(this.plugin.settings.jiraDashboardProjects.join(', '))
                        .onChange(value => {
                            this.plugin.settings.jiraDashboardProjects = value
                                .split(',')
                                .map(s => s.trim().toUpperCase())
                                .filter(s => s.length > 0);
                            this.debouncedSave(false);
                        })
                );

            new Setting(containerEl)
                .setName('Dashboard cache TTL (minutes)')
                .setDesc('How long to cache the dashboard result before auto-refresh (when the view is visible). Separate from the per-issue cache above.')
                .addText(text =>
                    text
                        .setPlaceholder('10')
                        .setValue(String(this.plugin.settings.jiraDashboardTtlMinutes))
                        .onChange(value => {
                            const parsed = parseInt(value, 10);
                            if (!isNaN(parsed) && parsed >= 0) {
                                this.plugin.settings.jiraDashboardTtlMinutes = parsed;
                                this.debouncedSave(false);
                            }
                        })
                );

            new Setting(containerEl)
                .setName('Sprint custom field ID')
                .setDesc('JIRA custom field ID for the Sprint field. Most Cloud instances use "customfield_10020" — change only if your JIRA is configured differently.')
                .addText(text =>
                    text
                        .setPlaceholder('customfield_10020')
                        .setValue(this.plugin.settings.jiraSprintFieldId)
                        .onChange(value => {
                            this.plugin.settings.jiraSprintFieldId = value.trim();
                            this.debouncedSave(false);
                        })
                );

            new Setting(containerEl)
                .setName('Test connection')
                .setDesc('Verify your credentials by calling /rest/api/3/myself.')
                .addButton(btn =>
                    btn
                        .setButtonText('Test connection')
                        .onClick(async () => {
                            btn.setDisabled(true);
                            btn.setButtonText('Testing…');
                            try {
                                const result = await this.plugin.jiraService.testConnection();
                                new Notice(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
                            } finally {
                                btn.setDisabled(false);
                                btn.setButtonText('Test connection');
                            }
                        })
                );
        }
    }

    /** Build folder tree from vault and render it */
    private renderFolderTree(containerEl: HTMLElement): void {
        this.treeContainer = containerEl.createDiv({ cls: 'task-bujo-folder-tree' });
        this.renderTreeContent();
    }

    /** Re-render just the tree content, preserving collapse state and scroll */
    private renderTreeContent(): void {
        if (!this.treeContainer) return;
        const scrollTop = this.treeContainer.scrollTop;
        this.treeContainer.empty();

        const root = this.buildFolderTree();

        for (const node of root) {
            this.renderFolderNode(this.treeContainer, node, 0);
        }

        if (root.length === 0) {
            this.treeContainer.createDiv({
                cls: 'task-bujo-empty',
                text: 'No folders found in vault.'
            });
        }

        this.treeContainer.scrollTop = scrollTop;
    }

    /** Build a tree structure from vault folders */
    private buildFolderTree(): FolderNode[] {
        const rootFolder = this.app.vault.getRoot();
        const nodes: FolderNode[] = [];

        for (const child of rootFolder.children) {
            if (child instanceof TFolder) {
                nodes.push(this.folderToNode(child));
            }
        }

        nodes.sort((a, b) => a.name.localeCompare(b.name));
        return nodes;
    }

    private folderToNode(folder: TFolder): FolderNode {
        const children: FolderNode[] = [];
        for (const child of folder.children) {
            if (child instanceof TFolder) {
                children.push(this.folderToNode(child));
            }
        }
        children.sort((a, b) => a.name.localeCompare(b.name));

        return {
            path: folder.path,
            name: folder.name,
            children,
        };
    }

    /** Render a single folder node and its children */
    private renderFolderNode(container: HTMLElement, node: FolderNode, depth: number): void {
        const row = container.createDiv({ cls: 'task-bujo-folder-row' });
        row.style.paddingLeft = `${depth * 20}px`;

        // Collapse/expand chevron (only if has children)
        const chevron = row.createSpan({ cls: 'task-bujo-folder-chevron' });
        const isCollapsed = this.collapsedFolders.has(node.path);
        if (node.children.length > 0) {
            chevron.textContent = isCollapsed ? '▶' : '▼';
            chevron.addClass('task-bujo-clickable');
        } else {
            chevron.textContent = ' ';
        }

        // State indicator button
        const stateBtn = row.createEl('button', { cls: 'task-bujo-folder-state-btn' });
        const updateStateBtn = () => {
            const explicitState = this.plugin.settings.folderStates[node.path];
            const effective = getEffectiveState(node.path + '/dummy.md', this.plugin.settings.folderStates);

            if (explicitState === 'exclude') {
                stateBtn.textContent = '✗';
                stateBtn.setAttribute('aria-label', 'Excluded');
                row.addClass('task-bujo-folder-excluded');
                row.removeClass('task-bujo-folder-inherit');
            } else if (explicitState === 'inherit') {
                stateBtn.textContent = '~';
                stateBtn.setAttribute('aria-label', `Inherit (${effective})`);
                row.removeClass('task-bujo-folder-excluded');
                row.addClass('task-bujo-folder-inherit');
                if (effective === 'exclude') {
                    row.addClass('task-bujo-folder-excluded');
                }
            } else {
                // include (explicit or default)
                stateBtn.textContent = '✓';
                stateBtn.setAttribute('aria-label', 'Included');
                row.removeClass('task-bujo-folder-excluded');
                row.removeClass('task-bujo-folder-inherit');
            }
        };
        updateStateBtn();

        // Cycle state on click: include → exclude → inherit → include
        stateBtn.addEventListener('click', async () => {
            const current = this.plugin.settings.folderStates[node.path];
            let next: FolderState;
            if (!current || current === 'include') {
                next = 'exclude';
            } else if (current === 'exclude') {
                next = 'inherit';
            } else {
                next = 'include';
            }

            if (next === 'include') {
                // Remove from map (include is the default)
                delete this.plugin.settings.folderStates[node.path];
            } else {
                this.plugin.settings.folderStates[node.path] = next;
            }

            await this.plugin.saveSettings();
            // Re-render only the tree, preserving collapse states and scroll
            this.renderTreeContent();
        });

        // Folder name
        row.createSpan({ cls: 'task-bujo-folder-name', text: node.name });

        // Children container
        if (node.children.length > 0) {
            const childContainer = container.createDiv({ cls: 'task-bujo-folder-children' });
            if (isCollapsed) {
                childContainer.addClass('task-bujo-collapsed');
            }

            for (const child of node.children) {
                this.renderFolderNode(childContainer, child, depth + 1);
            }

            // Collapse/expand toggle
            chevron.addEventListener('click', () => {
                if (this.collapsedFolders.has(node.path)) {
                    this.collapsedFolders.delete(node.path);
                } else {
                    this.collapsedFolders.add(node.path);
                }
                const nowCollapsed = this.collapsedFolders.has(node.path);
                childContainer.toggleClass('task-bujo-collapsed', nowCollapsed);
                chevron.textContent = nowCollapsed ? '▶' : '▼';
            });
        }
    }

    /** Format tag categories as "Name(Code), ..." */
    private formatTagCategories(categories: TagCategory[]): string {
        return categories.map(c => `${c.name}(${c.shortCode})`).join(', ');
    }

    /** Parse "Name(Code), Name(Code)" into TagCategory[] */
    private parseTagCategories(value: string): TagCategory[] {
        const results: TagCategory[] = [];
        const parts = value.split(',').map(s => s.trim()).filter(s => s.length > 0);
        for (const part of parts) {
            const match = part.match(/^(.+?)\((\w+)\)$/);
            if (match) {
                results.push({ name: match[1].trim(), shortCode: match[2] });
            }
        }
        return results;
    }
}
