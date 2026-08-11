import { App, Notice, Platform, PluginSettingTab, Setting, TFolder } from 'obsidian';
import {
    PluginSettings,
    FolderState,
    GroupMode,
    FridayViewMode,
    TagCategory,
    TopicStatus,
    DEFAULT_WORK_TYPES,
    DEFAULT_PURPOSES,
} from './types';
import { getEffectiveState } from './utils/pathUtils';
import { SETTINGS_DEBOUNCE_MS } from './constants';
import { JiraService } from './services/jiraService';
import { JiraDashboardService } from './services/jiraDashboardService';
import { JiraTeamService } from './services/jiraTeamService';
import { TeamMemberService } from './services/teamMemberService';
import { McpServer, generateMcpToken } from './mcp/server';

interface FridayPlugin {
    settings: PluginSettings;
    saveSettings(requiresRescan?: boolean): Promise<void>;
    jiraService: JiraService;
    jiraDashboardService: JiraDashboardService;
    jiraTeamService: JiraTeamService;
    teamMemberService: TeamMemberService;
    mcpServer: McpServer;
    applyMcpServerState(): Promise<void>;
}

/** Recursive folder tree node */
interface FolderNode {
    path: string;
    name: string;
    children: FolderNode[];
}

export class FridaySettingTab extends PluginSettingTab {
    plugin: FridayPlugin;
    /** Tracks which folder paths are collapsed (persists across re-renders) */
    private collapsedFolders: Set<string> = new Set();
    /** Reference to the tree container for partial re-renders */
    private treeContainer: HTMLElement | null = null;
    /** Debounce timer for text settings */
    private settingsDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(app: App, plugin: FridayPlugin) {
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
                        [FridayViewMode.Daily]: 'Daily',
                        [FridayViewMode.Topics]: 'Topics',
                        [FridayViewMode.Weekly]: 'Weekly',
                        [FridayViewMode.Monthly]: 'Monthly',
                        [FridayViewMode.Calendar]: 'Calendar',
                        [FridayViewMode.Unscheduled]: 'Unscheduled',
                        [FridayViewMode.Inbox]: 'Inbox',
                        [FridayViewMode.Overdue]: 'Overdue',
                        [FridayViewMode.Overview]: 'Overview',
                        [FridayViewMode.Analytics]: 'Analytics',
                    })
                    .setValue(this.plugin.settings.defaultViewMode)
                    .onChange(async value => {
                        this.plugin.settings.defaultViewMode = value as FridayViewMode;
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
            .setName('Inbox headings')
            .setDesc('Comma-separated heading names that identify quick-capture inbox sections.')
            .addText(text =>
                text
                    .setPlaceholder('Inbox, Triage')
                    .setValue(this.plugin.settings.inboxHeadings.join(', '))
                    .onChange(value => {
                        this.plugin.settings.inboxHeadings = value
                            .split(',')
                            .map(s => s.trim())
                            .filter(s => s.length > 0);
                        this.debouncedSave(true);
                    })
            );

        new Setting(containerEl)
            .setName('Default quick-add target')
            .setDesc('Where the Add Task bar writes by default: under ## Tasks or ## Inbox.')
            .addDropdown(dropdown => dropdown
                .addOptions({ tasks: 'Tasks', inbox: 'Inbox' })
                .setValue(this.plugin.settings.defaultQuickAddTarget)
                .onChange(value => {
                    this.plugin.settings.defaultQuickAddTarget = value as 'tasks' | 'inbox';
                    this.debouncedSave(false);
                })
            );

        // ── Friday ────────────────────────────────────────────────
        containerEl.createEl('h2', { text: 'Friday' });

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
            .setName('Tasks inbox file')
            .setDesc('Central file for loose tasks (the v3 capture home). Quick-add and the daily-Inbox sweep land here.')
            .addText(text =>
                text
                    .setPlaceholder('BuJo/Tasks.md')
                    .setValue(this.plugin.settings.tasksFilePath)
                    .onChange(value => {
                        this.plugin.settings.tasksFilePath = value.trim();
                        this.debouncedSave(false);
                    })
            );

        new Setting(containerEl)
            .setName('Upcoming window (days)')
            .setDesc('How many days ahead the Upcoming view looks — also the snooze-wake horizon.')
            .addText(text =>
                text
                    .setPlaceholder('14')
                    .setValue(String(this.plugin.settings.upcomingWindowDays))
                    .onChange(value => {
                        const n = parseInt(value, 10);
                        if (!isNaN(n) && n > 0) {
                            this.plugin.settings.upcomingWindowDays = n;
                            this.debouncedSave(false);
                        }
                    })
            );

        new Setting(containerEl)
            .setName('Auto-archive completed after (days)')
            .setDesc('Completed tasks in the Tasks inbox are swept to the archive once closed this long. 0 = manual only.')
            .addText(text =>
                text
                    .setPlaceholder('7')
                    .setValue(String(this.plugin.settings.archiveCompletedAfterDays))
                    .onChange(value => {
                        const n = parseInt(value, 10);
                        if (!isNaN(n) && n >= 0) {
                            this.plugin.settings.archiveCompletedAfterDays = n;
                            this.debouncedSave(false);
                        }
                    })
            );

        new Setting(containerEl)
            .setName('Date format')
            .setDesc('Format the plugin writes for @due / @snooze. ISO matches daily-note names and topic frontmatter.')
            .addDropdown(dd =>
                dd
                    .addOption('iso', 'ISO — 2026-08-20')
                    .addOption('dmy', 'Day-Month-Year — 20-08-2026')
                    .setValue(this.plugin.settings.dateFormat)
                    .onChange(async value => {
                        this.plugin.settings.dateFormat = value as 'iso' | 'dmy';
                        await this.plugin.saveSettings(false);
                    })
            );

        new Setting(containerEl)
            .setName('Migration prompt on startup')
            .setDesc('Legacy morning-review carry-forward. Off in v3 — tasks float by date instead.')
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

        // ── Topics (Kanban board) ─────────────────────────────────
        containerEl.createEl('h2', { text: 'Topics' });

        new Setting(containerEl)
            .setName('Topics folder path')
            .setDesc('Folder where topic files (the Kanban board) are stored.')
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
            .setName('WIP limits')
            .setDesc('Max topics per Kanban column before it warns. The board never blocks a move — it only flags the column and shows a notice. Leave a field blank for no limit.')
            .setHeading();

        const wipColumns: { status: TopicStatus; label: string }[] = [
            { status: 'backlog', label: 'Backlog' },
            { status: 'open', label: 'To Do' },
            { status: 'in-progress', label: 'In Progress' },
            { status: 'done', label: 'Done' },
        ];
        for (const { status, label } of wipColumns) {
            new Setting(containerEl)
                .setName(label)
                .addText(text => {
                    text.inputEl.type = 'number';
                    text.inputEl.min = '0';
                    const current = this.plugin.settings.wipLimits?.[status];
                    text.setValue(current != null ? String(current) : '');
                    text.onChange(value => {
                        if (!this.plugin.settings.wipLimits) {
                            this.plugin.settings.wipLimits = { backlog: null, open: null, 'in-progress': null, done: null };
                        }
                        const parsed = parseInt(value, 10);
                        this.plugin.settings.wipLimits[status] = (!isNaN(parsed) && parsed > 0) ? parsed : null;
                        this.debouncedSave(false);
                    });
                });
        }

        new Setting(containerEl)
            .setName('Aging WIP threshold (days)')
            .setDesc('In Analytics → Flow, flag any non-done topic that has sat in its column at least this many days.')
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
                text.setValue(String(this.plugin.settings.agingWipThresholdDays ?? 7));
                text.onChange(value => {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed) && parsed > 0) {
                        this.plugin.settings.agingWipThresholdDays = parsed;
                        this.debouncedSave(false);
                    }
                });
            });

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
            .setDesc('Tasks / topics due within this many days are flagged as "urgent" in views that surface urgency cues.')
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

        new Setting(containerEl)
            .setName('Nudge threshold (days)')
            .setDesc('Topics waiting on someone show up in the morning review after this many days without a nudge.')
            .addText(text =>
                text
                    .setPlaceholder('7')
                    .setValue(String(this.plugin.settings.nudgeThresholdDays))
                    .onChange(value => {
                        const parsed = parseInt(value, 10);
                        if (!isNaN(parsed) && parsed >= 0) {
                            this.plugin.settings.nudgeThresholdDays = parsed;
                            this.debouncedSave(false);
                        }
                    })
            );

        new Setting(containerEl)
            .setName('Hide done items after (days)')
            .setDesc('Hide JIRA issues and topics that have been done/closed for longer than this many days from the dashboards. Recently-completed work stays visible for follow-up; the Topics "Done" filter still shows everything, and full history stays in JIRA. Minimum 1. Default 14.')
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
                text
                    .setPlaceholder('14')
                    .setValue(String(this.plugin.settings.hideDoneAfterDays ?? 14))
                    .onChange(value => {
                        const parsed = parseInt(value, 10);
                        if (!isNaN(parsed) && parsed >= 1) {
                            this.plugin.settings.hideDoneAfterDays = parsed;
                            this.debouncedSave(false);
                        }
                    });
            });

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
                .setName('Flagged custom field ID')
                .setDesc('JIRA custom field ID for the Flagged (impediment) field. Usually "customfield_10021". Drives JIRA-derived topic blocking.')
                .addText(text =>
                    text
                        .setPlaceholder('customfield_10021')
                        .setValue(this.plugin.settings.jiraFlaggedFieldId)
                        .onChange(value => {
                            this.plugin.settings.jiraFlaggedFieldId = value.trim();
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

            // ── Team Members sub-section ───────────────────────────
            // Lead-analyst feature: configured list of team members whose JIRA work
            // gets surfaced on the dashboard as a workload heatmap + per-person sections.
            // Email is the identity used in `assignee = "email"` JQL clauses.
            containerEl.createEl('h3', { text: 'Team Members' });
            containerEl.createEl('p', {
                text: 'Configure your team so the JIRA Dashboard can show a workload heatmap and per-person sections. Email is used as the JIRA identity. Toggle "Show team section" off to hide the block without losing the list.',
                cls: 'setting-item-description',
            });

            new Setting(containerEl)
                .setName('Show team section on JIRA Dashboard')
                .setDesc('When on, the dashboard runs a second JQL scoped to the team and renders a workload heatmap plus one section per active member.')
                .addToggle(toggle =>
                    toggle
                        .setValue(this.plugin.settings.jiraTeamEnabled)
                        .onChange(async value => {
                            this.plugin.settings.jiraTeamEnabled = value;
                            await this.plugin.saveSettings(false);
                        })
                );

            new Setting(containerEl)
                .setName('Default capacity (target concurrent items)')
                .setDesc('Used for members without a per-member target. Drives the workload "committed vs. capacity" band on the Team Dashboard.')
                .addText(text => {
                    text.inputEl.type = 'number';
                    text.inputEl.min = '1';
                    text.setValue(String(this.plugin.settings.defaultTargetConcurrentItems ?? 5));
                    text.onChange(value => {
                        const n = parseInt(value, 10);
                        if (!isNaN(n) && n > 0) {
                            this.plugin.settings.defaultTargetConcurrentItems = n;
                            this.debouncedSave(false);
                        }
                    });
                });

            this.renderTeamMembersList(containerEl);
        }

        // ── Team Management ──────────────────────────────────────────
        // Person pages (one .md per teammate) + 1:1 session notes. Independent of
        // JIRA — this section appears even when JIRA is off.
        this.renderTeamManagementSection(containerEl);

        // ── MCP Server ───────────────────────────────────────────────
        // Embedded HTTP MCP server (desktop only). Lets MCP-aware clients like
        // Claude Desktop / Claude Code call Friday's task and topic operations
        // directly.
        this.renderMcpSection(containerEl);
    }

    /** MCP-server settings section: enable toggle, port, token, and live sample
     *  connector snippets for Claude Desktop / Claude Code. */
    private renderMcpSection(containerEl: HTMLElement): void {
        containerEl.createEl('h2', { text: 'MCP Server' });
        containerEl.createEl('p', {
            text:
                'Optional. When enabled, Friday hosts a small HTTP MCP server on localhost so ' +
                'Claude Desktop / Claude Code can call task and topic operations directly. ' +
                'Desktop only — does nothing on mobile.',
            cls: 'setting-item-description',
        });

        if (!Platform.isDesktop) {
            containerEl.createEl('p', {
                text: 'Not available on mobile (no Node http access).',
                cls: 'setting-item-description',
            });
            return;
        }

        new Setting(containerEl)
            .setName('Enable MCP server')
            .setDesc('Master switch. When on, Friday listens on the configured port for MCP requests.')
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.mcpEnabled)
                    .onChange(async value => {
                        this.plugin.settings.mcpEnabled = value;
                        if (value && !this.plugin.settings.mcpToken) {
                            this.plugin.settings.mcpToken = generateMcpToken();
                        }
                        await this.plugin.saveSettings(false);
                        await this.plugin.applyMcpServerState();
                        // Re-render so the status / snippets / etc. update.
                        this.display();
                    })
            );

        if (!this.plugin.settings.mcpEnabled) return;

        new Setting(containerEl)
            .setName('Port')
            .setDesc('TCP port to bind on 127.0.0.1. Default 27225. Restarts the server on change.')
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = '1024';
                text.inputEl.max = '65535';
                text
                    .setPlaceholder('27225')
                    .setValue(String(this.plugin.settings.mcpPort))
                    .onChange(value => {
                        const parsed = parseInt(value, 10);
                        if (!isNaN(parsed) && parsed >= 1024 && parsed <= 65535) {
                            this.plugin.settings.mcpPort = parsed;
                            this.debouncedMcpRestart();
                        }
                    });
            });

        // Server-status line. Refreshes on each settings render — the user gets a
        // clear "running on http://… / stopped / port-in-use" indicator.
        const status = this.plugin.mcpServer.getStatus();
        const statusEl = containerEl.createDiv({ cls: 'friday-mcp-status' });
        statusEl.style.padding = '8px 12px';
        statusEl.style.margin = '8px 0';
        statusEl.style.borderRadius = '4px';
        statusEl.style.fontSize = '0.9em';
        if (status.state === 'running') {
            statusEl.style.background = 'var(--background-modifier-success)';
            statusEl.setText(`● Running on ${status.url}`);
        } else if (status.state === 'error') {
            statusEl.style.background = 'var(--background-modifier-error)';
            statusEl.setText(`● Error: ${status.message ?? 'unknown'}`);
        } else {
            statusEl.style.background = 'var(--background-modifier-border)';
            statusEl.setText('● Stopped');
        }

        // Token row with read-only display + Copy + Regenerate buttons.
        new Setting(containerEl)
            .setName('Bearer token')
            .setDesc('Required on every MCP request. Treat this like a password — copy it into your MCP client config and keep it secret.')
            .addText(text => {
                text.inputEl.type = 'password';
                text.inputEl.readOnly = true;
                text.setValue(this.plugin.settings.mcpToken);
            })
            .addButton(btn =>
                btn
                    .setButtonText('Copy')
                    .onClick(async () => {
                        await navigator.clipboard.writeText(this.plugin.settings.mcpToken);
                        new Notice('MCP token copied to clipboard.');
                    })
            )
            .addButton(btn =>
                btn
                    .setButtonText('Regenerate')
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.mcpToken = generateMcpToken();
                        await this.plugin.saveSettings(false);
                        await this.plugin.applyMcpServerState();
                        new Notice('Token regenerated. Existing clients must be updated.');
                        this.display();
                    })
            );

        // Two install paths are surfaced, in order of recommendation:
        //   1) MCPB bundle — one-click install in Claude Desktop, no JSON editing,
        //      port/token entered in the install dialog. Best on Windows where
        //      Claude Desktop's stdio wrapping breaks paths with spaces.
        //   2) Manual JSON snippets — fallback for clients that don't ingest
        //      .mcpb bundles, or when the user wants to tweak the config.
        this.renderMcpbBundleSection(containerEl);
        this.renderMcpConnectorSnippets(containerEl);
    }

    /** Tell the user where the prebuilt .mcpb bundle lives + brief install steps. */
    private renderMcpbBundleSection(containerEl: HTMLElement): void {
        const wrap = containerEl.createDiv({ cls: 'friday-mcp-bundle' });
        wrap.style.marginTop = '12px';
        wrap.style.padding = '10px 12px';
        wrap.style.background = 'var(--background-secondary)';
        wrap.style.borderRadius = '4px';
        wrap.style.borderLeft = '3px solid var(--interactive-accent)';

        wrap.createEl('h3', { text: 'Recommended: .mcpb bundle (Claude Desktop)' })
            .style.marginTop = '0';

        const desc = wrap.createEl('p', { cls: 'setting-item-description' });
        desc.style.marginBottom = '6px';
        desc.appendText(
            'Drag-and-drop install for Claude Desktop. No JSON editing, no manual ' +
            'path-quoting workarounds — Claude Desktop spawns the bundled Node ' +
            'runtime directly. Port and token are entered in the install dialog.',
        );

        const list = wrap.createEl('ol');
        list.style.margin = '6px 0 0 20px';
        list.style.fontSize = '0.9em';
        list.createEl('li').setText('Grab friday-mcp.mcpb from the plugin folder (next to main.js).');
        list.createEl('li').setText('Open Claude Desktop → Settings → Extensions → Install Extension, or drag the file onto the Claude Desktop window.');
        const li3 = list.createEl('li');
        li3.appendText('Fill in the install dialog: ');
        li3.createEl('code', { text: '127.0.0.1' });
        li3.appendText(' / port ');
        li3.createEl('code', { text: String(this.plugin.settings.mcpPort) });
        li3.appendText(' / the bearer token above.');
        list.createEl('li').setText('Restart Claude Desktop (fully quit from the tray).');

        const note = wrap.createEl('p', { cls: 'setting-item-description' });
        note.style.marginTop = '8px';
        note.style.marginBottom = '0';
        note.style.fontSize = '0.85em';
        note.setText(
            'If the .mcpb file is missing, the plugin maintainer can produce it with ' +
            '`npm run pack-mcpb` in the source repo.',
        );
    }

    /** Debounced MCP-server restart on port changes (avoids restarting on every keystroke). */
    private mcpRestartDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private debouncedMcpRestart(): void {
        if (this.mcpRestartDebounceTimer !== null) clearTimeout(this.mcpRestartDebounceTimer);
        this.mcpRestartDebounceTimer = setTimeout(async () => {
            this.mcpRestartDebounceTimer = null;
            await this.plugin.saveSettings(false);
            await this.plugin.applyMcpServerState();
            // Refresh the section so the status + snippet ports update without a full re-render.
            this.display();
        }, SETTINGS_DEBOUNCE_MS);
    }

    /** Build the live "sample connector" panel with copy-pasteable snippets for
     *  Claude Desktop (JSON config) and Claude Code (CLI + .mcp.json). Each snippet
     *  has its own Copy button and reflects current host/port/token. */
    private renderMcpConnectorSnippets(containerEl: HTMLElement): void {
        const host = this.plugin.settings.mcpHost || '127.0.0.1';
        const port = this.plugin.settings.mcpPort;
        const token = this.plugin.settings.mcpToken;
        const url = `http://${host}:${port}/mcp`;

        const wrap = containerEl.createDiv({ cls: 'friday-mcp-snippets' });
        wrap.style.marginTop = '12px';

        const header = wrap.createEl('h3', { text: 'Alternative: manual client config' });
        header.style.marginBottom = '4px';
        wrap.createEl('p', {
            text:
                'For clients that don\'t support .mcpb bundles, or when you prefer hand-editing ' +
                'the config. The URL and token below reflect the settings above — they update ' +
                'live, so always copy from here after changing the port or regenerating the token.',
            cls: 'setting-item-description',
        });
        const note = wrap.createEl('p', { cls: 'setting-item-description' });
        note.style.fontSize = '0.85em';
        note.style.marginTop = '0';
        note.appendText(
            'Note on Claude Desktop + Windows: the direct-HTTP form below may be rejected as ' +
            '"not valid MCP" depending on your Claude Desktop version, and the mcp-remote ' +
            'fallback hits a quoting bug when Node lives under "Program Files". The .mcpb ' +
            'bundle above avoids both. The CLI/.mcp.json forms work fine for Claude Code.',
        );

        // ── Claude Desktop ────────────────────────────────────────
        const desktopJson = JSON.stringify(
            {
                mcpServers: {
                    friday: {
                        type: 'http',
                        url,
                        headers: { Authorization: `Bearer ${token}` },
                    },
                },
            },
            null,
            2,
        );
        this.renderSnippetBlock(
            wrap,
            'Claude Desktop — claude_desktop_config.json',
            desktopJson,
        );

        // ── Claude Code CLI ──────────────────────────────────────
        const claudeCodeCli =
            `claude mcp add --transport http friday ${url} ` +
            `--header "Authorization: Bearer ${token}"`;
        this.renderSnippetBlock(
            wrap,
            'Claude Code — CLI shortcut',
            claudeCodeCli,
        );

        // ── Claude Code .mcp.json ────────────────────────────────
        const claudeCodeJson = JSON.stringify(
            {
                mcpServers: {
                    friday: {
                        type: 'http',
                        url,
                        headers: { Authorization: `Bearer ${token}` },
                    },
                },
            },
            null,
            2,
        );
        this.renderSnippetBlock(
            wrap,
            'Claude Code — .mcp.json',
            claudeCodeJson,
        );
    }

    /** A single labeled <pre> code block with a Copy button. */
    private renderSnippetBlock(parent: HTMLElement, label: string, body: string): void {
        const block = parent.createDiv({ cls: 'friday-mcp-snippet' });
        block.style.marginBottom = '12px';

        const labelRow = block.createDiv();
        labelRow.style.display = 'flex';
        labelRow.style.justifyContent = 'space-between';
        labelRow.style.alignItems = 'center';
        labelRow.style.marginBottom = '4px';

        labelRow.createEl('strong', { text: label });

        const copyBtn = labelRow.createEl('button', { text: 'Copy' });
        copyBtn.addEventListener('click', async () => {
            await navigator.clipboard.writeText(body);
            new Notice(`Copied "${label}".`);
        });

        const pre = block.createEl('pre');
        pre.style.background = 'var(--background-secondary)';
        pre.style.padding = '8px';
        pre.style.borderRadius = '4px';
        pre.style.overflowX = 'auto';
        pre.style.fontSize = '0.85em';
        pre.style.margin = '0';
        pre.createEl('code', { text: body });
    }

    /** Team-management section: person-page folder + one-shot generator from
     *  the existing `teamMembers[]` list. */
    private renderTeamManagementSection(containerEl: HTMLElement): void {
        containerEl.createEl('h2', { text: 'Team Management' });
        containerEl.createEl('p', {
            text: 'One folder per teammate with a canonical person page and a 1on1/ subfolder for dated 1:1 session notes. The Team tab in the Friday view surfaces cadence signals so you don\'t miss 1:1s.',
            cls: 'setting-item-description',
        });

        new Setting(containerEl)
            .setName('Team folder path')
            .setDesc('Where person pages live. Each teammate gets a subfolder: {folder}/Alice Smith/Alice Smith.md.')
            .addText(text =>
                text
                    .setPlaceholder('BuJo/Team')
                    .setValue(this.plugin.settings.teamFolderPath)
                    .onChange(value => {
                        this.plugin.settings.teamFolderPath = value.trim() || 'BuJo/Team';
                        this.debouncedSave(true);
                    })
            );

        new Setting(containerEl)
            .setName('Generate person pages from team members')
            .setDesc('For each entry in the team-member list above, create a skeleton person page (if it doesn\'t already exist). Safe to run repeatedly — existing pages are never overwritten.')
            .addButton(btn =>
                btn
                    .setButtonText('Generate')
                    .onClick(async () => {
                        btn.setDisabled(true);
                        btn.setButtonText('Generating…');
                        try {
                            let created = 0;
                            let skipped = 0;
                            for (const member of this.plugin.settings.teamMembers) {
                                if (!member.fullName) { skipped++; continue; }
                                const made = await this.plugin.teamMemberService.ensurePageFromSettings(member);
                                made ? created++ : skipped++;
                            }
                            if (created === 0) {
                                new Notice(`No new pages created — all ${skipped} member(s) already have pages.`);
                            } else {
                                new Notice(`Created ${created} person page(s). Open the Team tab in Friday view to see them.`);
                            }
                        } catch (e) {
                            new Notice(`Generation failed: ${e instanceof Error ? e.message : 'unknown error'}`);
                        } finally {
                            btn.setDisabled(false);
                            btn.setButtonText('Generate');
                        }
                    })
            );
    }

    /** Render the editable team member list. Rebuilds the whole block on any change
     *  because Obsidian Settings don't trivially support in-place row edits. Cheap
     *  given typical team sizes (5–15 people). */
    private renderTeamMembersList(containerEl: HTMLElement): void {
        const listWrap = containerEl.createDiv({ cls: 'friday-team-members-list' });
        const rerender = () => {
            listWrap.empty();
            this.renderTeamMembersRows(listWrap);
        };
        this.renderTeamMembersRows(listWrap);

        new Setting(containerEl)
            .addButton(btn =>
                btn
                    .setButtonText('+ Add team member')
                    .setCta()
                    .onClick(async () => {
                        this.plugin.settings.teamMembers.push({
                            fullName: '',
                            nickname: '',
                            email: '',
                            active: true,
                        });
                        await this.plugin.saveSettings(false);
                        rerender();
                    })
            );
    }

    private renderTeamMembersRows(listEl: HTMLElement): void {
        const members = this.plugin.settings.teamMembers;
        if (members.length === 0) {
            listEl.createDiv({
                cls: 'friday-empty',
                text: 'No team members configured yet. Click "+ Add team member" to start.',
            });
            return;
        }

        for (let i = 0; i < members.length; i++) {
            const row = listEl.createDiv({ cls: 'friday-team-member-row' });

            // Row 1: full name + nickname + email (all in one row for density)
            const inputsRow = row.createDiv({ cls: 'friday-team-member-inputs' });

            const nameInput = inputsRow.createEl('input', {
                cls: 'friday-team-member-input',
                type: 'text',
                attr: { placeholder: 'Full name', value: members[i].fullName },
            });
            nameInput.addEventListener('change', async () => {
                this.plugin.settings.teamMembers[i].fullName = nameInput.value.trim();
                await this.plugin.saveSettings(false);
            });

            const nickInput = inputsRow.createEl('input', {
                cls: 'friday-team-member-input friday-team-member-input-nick',
                type: 'text',
                attr: { placeholder: 'Nickname', value: members[i].nickname },
            });
            nickInput.addEventListener('change', async () => {
                this.plugin.settings.teamMembers[i].nickname = nickInput.value.trim();
                await this.plugin.saveSettings(false);
            });

            const emailInput = inputsRow.createEl('input', {
                cls: 'friday-team-member-input friday-team-member-input-email',
                type: 'email',
                attr: { placeholder: 'email@domain.com', value: members[i].email },
            });
            emailInput.addEventListener('change', async () => {
                const raw = emailInput.value.trim();
                // Permissive validation: warn if missing @ but save anyway so typos
                // don't nuke the row. The team service filters invalid emails at fetch time.
                if (raw && !raw.includes('@')) {
                    new Notice('Email looks malformed — expected "name@domain.com".');
                }
                this.plugin.settings.teamMembers[i].email = raw;
                await this.plugin.saveSettings(false);
            });

            // Row 2: active toggle + remove button
            const controlsRow = row.createDiv({ cls: 'friday-team-member-controls' });

            const activeLabel = controlsRow.createEl('label', { cls: 'friday-team-member-active' });
            const activeCheck = activeLabel.createEl('input', {
                type: 'checkbox',
                attr: members[i].active ? { checked: 'true' } : {},
            });
            activeCheck.checked = members[i].active;
            activeLabel.createSpan({ text: ' Active' });
            activeCheck.addEventListener('change', async () => {
                this.plugin.settings.teamMembers[i].active = activeCheck.checked;
                await this.plugin.saveSettings(false);
            });

            // Capacity: target concurrent items + availability %. Blank = use default / 100%.
            const capInput = controlsRow.createEl('input', {
                cls: 'friday-team-member-input friday-team-member-input-cap',
                type: 'number',
                attr: {
                    placeholder: 'Target',
                    min: '0',
                    title: 'Target concurrent items (capacity). Blank = use default.',
                    value: members[i].targetConcurrentItems != null ? String(members[i].targetConcurrentItems) : '',
                },
            });
            capInput.addEventListener('change', async () => {
                const n = parseInt(capInput.value, 10);
                this.plugin.settings.teamMembers[i].targetConcurrentItems = (!isNaN(n) && n > 0) ? n : undefined;
                await this.plugin.saveSettings(false);
            });

            const availInput = controlsRow.createEl('input', {
                cls: 'friday-team-member-input friday-team-member-input-avail',
                type: 'number',
                attr: {
                    placeholder: 'Avail %',
                    min: '0',
                    max: '100',
                    title: 'Availability % (part-time / OOO). Blank = 100%.',
                    value: members[i].availabilityPercent != null ? String(members[i].availabilityPercent) : '',
                },
            });
            availInput.addEventListener('change', async () => {
                const n = parseInt(availInput.value, 10);
                this.plugin.settings.teamMembers[i].availabilityPercent = (!isNaN(n) && n >= 0 && n <= 100) ? n : undefined;
                await this.plugin.saveSettings(false);
            });

            const removeBtn = controlsRow.createEl('button', {
                cls: 'friday-team-member-remove',
                text: 'Remove',
            });
            removeBtn.addEventListener('click', async () => {
                this.plugin.settings.teamMembers.splice(i, 1);
                await this.plugin.saveSettings(false);
                // Full re-render to keep indices correct
                listEl.empty();
                this.renderTeamMembersRows(listEl);
            });
        }
    }

    /** Build folder tree from vault and render it */
    private renderFolderTree(containerEl: HTMLElement): void {
        this.treeContainer = containerEl.createDiv({ cls: 'friday-folder-tree' });
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
                cls: 'friday-empty',
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
        const row = container.createDiv({ cls: 'friday-folder-row' });
        row.style.paddingLeft = `${depth * 20}px`;

        // Collapse/expand chevron (only if has children)
        const chevron = row.createSpan({ cls: 'friday-folder-chevron' });
        const isCollapsed = this.collapsedFolders.has(node.path);
        if (node.children.length > 0) {
            chevron.textContent = isCollapsed ? '▶' : '▼';
            chevron.addClass('friday-clickable');
        } else {
            chevron.textContent = ' ';
        }

        // State indicator button
        const stateBtn = row.createEl('button', { cls: 'friday-folder-state-btn' });
        const updateStateBtn = () => {
            const explicitState = this.plugin.settings.folderStates[node.path];
            const effective = getEffectiveState(node.path + '/dummy.md', this.plugin.settings.folderStates);

            if (explicitState === 'exclude') {
                stateBtn.textContent = '✗';
                stateBtn.setAttribute('aria-label', 'Excluded');
                row.addClass('friday-folder-excluded');
                row.removeClass('friday-folder-inherit');
            } else if (explicitState === 'inherit') {
                stateBtn.textContent = '~';
                stateBtn.setAttribute('aria-label', `Inherit (${effective})`);
                row.removeClass('friday-folder-excluded');
                row.addClass('friday-folder-inherit');
                if (effective === 'exclude') {
                    row.addClass('friday-folder-excluded');
                }
            } else {
                // include (explicit or default)
                stateBtn.textContent = '✓';
                stateBtn.setAttribute('aria-label', 'Included');
                row.removeClass('friday-folder-excluded');
                row.removeClass('friday-folder-inherit');
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
        row.createSpan({ cls: 'friday-folder-name', text: node.name });

        // Children container
        if (node.children.length > 0) {
            const childContainer = container.createDiv({ cls: 'friday-folder-children' });
            if (isCollapsed) {
                childContainer.addClass('friday-collapsed');
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
                childContainer.toggleClass('friday-collapsed', nowCollapsed);
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
