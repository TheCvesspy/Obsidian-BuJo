import { App, Modal, Notice, TFile } from 'obsidian';
import { SprintTopic, PluginSettings, TeamMember } from '../types';
import { DailyNoteService } from '../services/dailyNoteService';
import { TeamMemberService, OverdueOneOnOne } from '../services/teamMemberService';
import { SprintTopicService } from '../services/sprintTopicService';
import { deriveTopicBlock, deriveTopicRisk, TopicRisk } from '../services/topicStatus';
import { buildTopicIndex } from '../services/topicGraph';
import { isoToPluginDate } from '../utils/dateUtils';
import { buildTaskLine } from './InsertTaskModal';

/**
 * Morning Review (v3).
 *
 * A start-of-day *nudge* surface — deliberately NOT a task list. Due and overdue tasks
 * live in the Today view (they float by date now), so this modal no longer carries tasks
 * forward. What it surfaces instead is the stuff that has no other home and is easy to let
 * slip: team 1:1s whose cadence has elapsed, topics you're waiting on that have gone quiet,
 * and a quick-capture box for anything that comes to mind. Every row offers a single action.
 */
export class MorningReviewModal extends Modal {
    constructor(
        app: App,
        private dailyNotes: DailyNoteService,
        /** Optional — when omitted, the Overdue 1:1s section is hidden. */
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

        contentEl.createEl('h2', { text: 'Morning Review' });

        const overdueOneOnOnes = this.teamService?.getOverdueOneOnOnes() ?? [];
        if (overdueOneOnOnes.length > 0) {
            this.renderOverdueOneOnOnes(contentEl, overdueOneOnOnes);
        }

        const atRiskTopics = await this.getAtRiskTopics();
        if (atRiskTopics.length > 0) {
            this.renderAtRiskTopics(contentEl, atRiskTopics);
        }

        const staleWaitingTopics = await this.getStaleWaitingTopics();
        if (staleWaitingTopics.length > 0) {
            this.renderStaleWaitingTopics(contentEl, staleWaitingTopics);
        }

        const wokenTopics = await this.getWokenTopics();
        if (wokenTopics.length > 0) {
            this.renderWokenTopics(contentEl, wokenTopics);
        }

        if (overdueOneOnOnes.length === 0 && staleWaitingTopics.length === 0 && wokenTopics.length === 0 && atRiskTopics.length === 0) {
            contentEl.createEl('p', {
                text: 'Nothing needs a nudge. Your due & overdue work lives in the Today tab.',
                cls: 'friday-empty',
            });
        }

        // Quick capture — jot anything down before it slips.
        this.renderQuickAdd(contentEl);

        const buttonContainer = contentEl.createDiv({ cls: 'friday-migration-actions' });
        const closeBtn = buttonContainer.createEl('button', { text: 'Close' });
        closeBtn.addEventListener('click', () => this.close());
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private renderQuickAdd(container: HTMLElement): void {
        const section = container.createDiv({ cls: 'friday-review-quickadd' });
        section.createEl('h3', { text: 'Quick capture' });

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

    /** Topics at schedule risk (deriveTopicRisk): overdue, or due within the risk window
     *  while not started / behind on tasks / blocked. Sorted soonest-due first. Blocked
     *  state feeds from the manual flag + dependency graph (no JIRA cache in the modal). */
    private async getAtRiskTopics(): Promise<Array<{ topic: SprintTopic; risk: TopicRisk }>> {
        if (!this.topicService) return [];
        const all = await this.topicService.getAllTopics();
        const index = buildTopicIndex(all);
        const isBlocked = (t: SprintTopic): boolean =>
            deriveTopicBlock({ topic: t, blockersOf: (x) => index.blockersOf(x) }).state === 'blocked';
        return all
            .map(topic => ({ topic, risk: deriveTopicRisk(topic, isBlocked(topic)) }))
            .filter(x => x.risk.atRisk)
            .sort((a, b) => (a.topic.dueDate ?? '').localeCompare(b.topic.dueDate ?? ''));
    }

    /** Section: topics at schedule risk. Read-only rows (the fix lives on the board) with
     *  an Open action that jumps to the topic file. */
    private renderAtRiskTopics(container: HTMLElement, items: Array<{ topic: SprintTopic; risk: TopicRisk }>): void {
        const section = container.createDiv({ cls: 'friday-review-section friday-review-atrisk' });
        const header = section.createDiv({ cls: 'friday-review-section-header' });
        header.createSpan({ text: '⚠ At risk', cls: 'friday-review-section-title' });
        header.createSpan({ text: ` (${items.length})`, cls: 'friday-review-section-count' });

        const members: TeamMember[] = this.settings?.teamMembers ?? [];
        const byEmail = new Map(members.map(m => [m.email, m]));

        for (const { topic, risk } of items) {
            const row = section.createDiv({ cls: 'friday-migration-item friday-atrisk-row' });

            const infoEl = row.createDiv({ cls: 'friday-migration-item-info' });
            const textEl = infoEl.createDiv({ cls: 'friday-migration-item-text' });
            textEl.createSpan({ text: topic.title, cls: 'friday-waiting-topic' });
            if (topic.assignee) {
                const m = byEmail.get(topic.assignee);
                textEl.createSpan({
                    cls: 'friday-atrisk-owner',
                    text: ` — ${m ? (m.nickname || m.fullName || m.email) : topic.assignee}`,
                });
            }

            const metaEl = infoEl.createDiv({ cls: 'friday-migration-item-meta' });
            metaEl.createSpan({ text: risk.reasons.join(' · '), cls: 'friday-atrisk-reasons' });

            const actionsEl = row.createDiv({ cls: 'friday-migration-item-actions' });
            const openBtn = actionsEl.createEl('button', { text: 'Open', cls: 'friday-btn' });
            openBtn.addEventListener('click', async () => {
                const file = this.app.vault.getAbstractFileByPath(topic.filePath);
                if (!(file instanceof TFile)) {
                    new Notice(`Topic file not found: ${topic.filePath}`);
                    return;
                }
                const leaf = this.app.workspace.getLeaf(false);
                await leaf.openFile(file);
                this.app.workspace.revealLeaf(leaf);
                this.close();
            });
        }
    }

    /** Topics whose snooze has expired but wasn't cleared: `snoozedUntil` is set, the date
     *  is today or earlier, and the topic isn't done. They're already back in their board
     *  column — this surfaces the return so the wake is a decision, not an accident. The
     *  row disappears once the snooze is cleared or renewed. */
    private async getWokenTopics(): Promise<SprintTopic[]> {
        if (!this.topicService) return [];
        const now = new Date();
        const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const all = await this.topicService.getAllTopics();
        return all
            .filter(t => t.status !== 'done' && !!t.snoozedUntil && t.snoozedUntil <= todayIso)
            .sort((a, b) => (a.snoozedUntil ?? '').localeCompare(b.snoozedUntil ?? ''));
    }

    /** Section: topics that woke from snooze. Each row offers "Back on board" (clears the
     *  stale snoozedUntil) or "+1 week" (renews the snooze from today). */
    private renderWokenTopics(container: HTMLElement, topics: SprintTopic[]): void {
        const section = container.createDiv({ cls: 'friday-review-section friday-review-woken' });
        const header = section.createDiv({ cls: 'friday-review-section-header' });
        header.createSpan({ text: 'Woke from snooze', cls: 'friday-review-section-title' });
        header.createSpan({ text: ` (${topics.length})`, cls: 'friday-review-section-count' });

        for (const topic of topics) {
            const row = section.createDiv({ cls: 'friday-migration-item friday-woken-row' });

            const infoEl = row.createDiv({ cls: 'friday-migration-item-info' });
            const textEl = infoEl.createDiv({ cls: 'friday-migration-item-text' });
            textEl.createSpan({ text: topic.title, cls: 'friday-waiting-topic' });

            const metaEl = infoEl.createDiv({ cls: 'friday-migration-item-meta' });
            metaEl.createSpan({
                cls: 'friday-waiting-meta',
                text: `Snoozed until ${topic.snoozedUntil} — awake again`,
            });

            const actionsEl = row.createDiv({ cls: 'friday-migration-item-actions' });

            const wakeBtn = actionsEl.createEl('button', {
                text: 'Back on board',
                cls: 'friday-btn-forward',
            });
            const renewBtn = actionsEl.createEl('button', {
                text: '+1 week',
                cls: 'friday-btn',
            });
            const settle = (btn: HTMLButtonElement, label: string): void => {
                btn.setText(label);
                btn.addClass('is-active');
                wakeBtn.disabled = true;
                renewBtn.disabled = true;
            };
            wakeBtn.addEventListener('click', async () => {
                try {
                    await this.topicService!.setTopicSnooze(topic.filePath, null);
                    settle(wakeBtn, 'Awake ✓');
                } catch (e) {
                    new Notice(`Could not clear snooze: ${e instanceof Error ? e.message : 'unknown error'}`);
                }
            });
            renewBtn.addEventListener('click', async () => {
                try {
                    const d = new Date();
                    d.setHours(0, 0, 0, 0);
                    d.setDate(d.getDate() + 7);
                    const until = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                    await this.topicService!.setTopicSnooze(topic.filePath, until);
                    settle(renewBtn, `Until ${until} ✓`);
                } catch (e) {
                    new Notice(`Could not renew snooze: ${e instanceof Error ? e.message : 'unknown error'}`);
                }
            });
        }
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
}
