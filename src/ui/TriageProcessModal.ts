import { App, Modal, Notice, setIcon } from 'obsidian';
import { TaskItem, Priority, SprintTopic } from '../types';
import { DueDateModal } from './DueDateModal';
import { TopicPickerModal } from './TopicPickerModal';

/** Low-level triage operations, injected by FridayView. All date-format conversion
 *  and Notice policy live with the caller — the modal stays a dumb card walker. */
export interface TriageOps {
	complete(task: TaskItem): Promise<void>;
	drop(task: TaskItem): Promise<void>;
	someday(task: TaskItem): Promise<void>;
	/** `pluginDate` as produced by DueDateModal (already in the plugin's input format). */
	setDue(task: TaskItem, pluginDate: string): Promise<void>;
	snoozeForDays(task: TaskItem, days: number): Promise<void>;
	snoozeUntil(task: TaskItem, pluginDate: string): Promise<void>;
	/** Returns false when the move failed (topic missing / task not located). */
	moveToTopic(task: TaskItem, topic: SprintTopic): Promise<boolean>;
	getTopics(): Promise<SprintTopic[]>;
}

const SNOOZE_PRESETS: [string, number][] = [
	['Tomorrow', 1],
	['3 days', 3],
	['Next week', 7],
	['2 weeks', 14],
	['Month', 30],
];

type CountKey = 'done' | 'dated' | 'snoozed' | 'someday' | 'topic' | 'dropped' | 'skipped';

/**
 * Focused inbox processing (v3 triage): walks the triage queue one card at a time.
 * Every card is one decision — date it, snooze it, send it to a Topic, defer it,
 * finish it, or drop it. Keyboard-first: c/d/s/t/m/x, arrows to skip/back, Esc closes.
 * Works off a snapshot of the queue; file writes land immediately per action, and the
 * board behind the modal refreshes through the normal store events.
 */
export class TriageProcessModal extends Modal {
	private index = 0;
	private snoozeOpen = false;
	private counts: Record<CountKey, number> = {
		done: 0, dated: 0, snoozed: 0, someday: 0, topic: 0, dropped: 0, skipped: 0,
	};

	constructor(
		app: App,
		private items: TaskItem[],
		private ops: TriageOps,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('friday-triage-process-modal');
		this.registerKeys();
		this.renderCard();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private get current(): TaskItem | undefined {
		return this.items[this.index];
	}

	// ─── keyboard ────────────────────────────────────────────────────────────

	private registerKeys(): void {
		const bind = (key: string, fn: () => void) =>
			this.scope.register([], key, (evt) => { evt.preventDefault(); fn(); return false; });

		bind('c', () => this.doComplete());
		bind('d', () => this.doDue());
		bind('s', () => this.toggleSnooze());
		bind('t', () => void this.doTopic());
		bind('m', () => this.doSomeday());
		bind('x', () => this.doDrop());
		bind('ArrowRight', () => this.skip());
		bind(' ', () => this.skip());
		bind('ArrowLeft', () => this.back());
		// Snooze presets are number keys, live only while the strip is open.
		SNOOZE_PRESETS.forEach(([, days], i) =>
			bind(String(i + 1), () => { if (this.snoozeOpen) this.snoozeDays(days); }));
		bind('p', () => { if (this.snoozeOpen) this.doSnoozePick(); });
	}

	// ─── actions ─────────────────────────────────────────────────────────────

	private applied(key: CountKey): void {
		this.counts[key]++;
		this.index++;
		this.renderCard();
	}

	private doComplete(): void {
		const t = this.current;
		if (!t) return;
		void this.ops.complete(t).then(() => this.applied('done'));
	}

	private doDrop(): void {
		const t = this.current;
		if (!t) return;
		void this.ops.drop(t).then(() => this.applied('dropped'));
	}

	private doSomeday(): void {
		const t = this.current;
		if (!t) return;
		void this.ops.someday(t).then(() => this.applied('someday'));
	}

	private doDue(): void {
		const t = this.current;
		if (!t) return;
		new DueDateModal(this.app, '', (pluginDate) => {
			if (!pluginDate) return; // cancelled / cleared — stay on this card
			void this.ops.setDue(t, pluginDate).then(() => this.applied('dated'));
		}).open();
	}

	private toggleSnooze(): void {
		if (!this.current) return;
		this.snoozeOpen = !this.snoozeOpen;
		this.renderCard(true);
	}

	private snoozeDays(days: number): void {
		const t = this.current;
		if (!t) return;
		void this.ops.snoozeForDays(t, days).then(() => this.applied('snoozed'));
	}

	private doSnoozePick(): void {
		const t = this.current;
		if (!t) return;
		new DueDateModal(this.app, '', (pluginDate) => {
			if (!pluginDate) return;
			void this.ops.snoozeUntil(t, pluginDate).then(() => this.applied('snoozed'));
		}).open();
	}

	private async doTopic(): Promise<void> {
		const t = this.current;
		if (!t) return;
		const topics = await this.ops.getTopics();
		if (topics.length === 0) {
			new Notice('No topics yet — create one in the Topics view first.');
			return;
		}
		new TopicPickerModal(this.app, topics, (topic) => {
			void this.ops.moveToTopic(t, topic).then(ok => { if (ok) this.applied('topic'); });
		}).open();
	}

	private skip(): void {
		if (!this.current) return;
		this.counts.skipped++;
		this.index++;
		this.renderCard();
	}

	private back(): void {
		if (this.index === 0) return;
		this.index--;
		if (this.counts.skipped > 0) this.counts.skipped--;
		this.renderCard();
	}

	// ─── rendering ───────────────────────────────────────────────────────────

	private renderCard(keepSnoozeState = false): void {
		if (!keepSnoozeState) this.snoozeOpen = false;
		const { contentEl } = this;
		contentEl.empty();

		const t = this.current;
		if (!t) { this.renderDone(); return; }

		// Header: title + position + thin progress bar
		const header = contentEl.createDiv({ cls: 'friday-triage-proc-header' });
		header.createSpan({ text: '📥 Triage' });
		header.createSpan({
			cls: 'friday-triage-proc-counter',
			text: `${this.index + 1} / ${this.items.length}`,
		});
		const barWrap = contentEl.createDiv({ cls: 'friday-triage-proc-bar' });
		const bar = barWrap.createDiv({ cls: 'friday-triage-proc-bar-fill' });
		bar.style.width = `${Math.round((this.index / this.items.length) * 100)}%`;

		// The card: one decision at a time
		const card = contentEl.createDiv({ cls: 'friday-triage-proc-card' });
		card.createDiv({ cls: 'friday-triage-proc-text', text: t.text });

		const meta = card.createDiv({ cls: 'friday-triage-proc-meta' });
		const sourceName = t.sourcePath.split('/').pop()?.replace(/\.md$/, '') ?? t.sourcePath;
		meta.createSpan({ text: `📄 ${sourceName}` });
		if (t.priority !== Priority.None) {
			meta.createSpan({ text: ` · ⬤ ${t.priority}` });
		}
		if (t.description) {
			card.createDiv({ cls: 'friday-triage-proc-desc', text: t.description });
		}

		// Primary decision grid — Lucide icons (theme-colorable) rather than emoji.
		const actions = contentEl.createDiv({ cls: 'friday-triage-proc-actions' });
		const action = (icon: string, label: string, key: string, fn: () => void, danger = false) => {
			const btn = actions.createEl('button', { cls: 'friday-triage-proc-action' });
			if (danger) btn.addClass('friday-triage-proc-action-danger');
			const iconEl = btn.createSpan({ cls: 'friday-triage-proc-action-icon' });
			setIcon(iconEl, icon);
			btn.createSpan({ text: label });
			btn.createEl('kbd', { text: key });
			btn.addEventListener('click', (e) => { (e.currentTarget as HTMLElement).blur(); fn(); });
		};
		action('calendar', 'Due date…', 'd', () => this.doDue());
		action('alarm-clock', 'Snooze', 's', () => this.toggleSnooze());
		action('pin', 'To topic…', 't', () => void this.doTopic());
		action('moon', 'Someday', 'm', () => this.doSomeday());
		action('check', 'Done', 'c', () => this.doComplete());
		action('x', 'Drop', 'x', () => this.doDrop(), true);

		// Snooze preset strip (toggled by ⏰ / s)
		if (this.snoozeOpen) {
			const strip = contentEl.createDiv({ cls: 'friday-triage-proc-snooze' });
			SNOOZE_PRESETS.forEach(([label, days], i) => {
				const btn = strip.createEl('button', { cls: 'friday-triage-proc-preset' });
				btn.createSpan({ text: label });
				btn.createEl('kbd', { text: String(i + 1) });
				btn.addEventListener('click', () => this.snoozeDays(days));
			});
			const pick = strip.createEl('button', { cls: 'friday-triage-proc-preset' });
			pick.createSpan({ text: 'Pick…' });
			pick.createEl('kbd', { text: 'p' });
			pick.addEventListener('click', () => this.doSnoozePick());
		}

		// Footer: navigation
		const footer = contentEl.createDiv({ cls: 'friday-triage-proc-footer' });
		const backBtn = footer.createEl('button', { text: '← Back', cls: 'friday-triage-proc-nav' });
		backBtn.disabled = this.index === 0;
		backBtn.addEventListener('click', () => this.back());
		const skipBtn = footer.createEl('button', { text: 'Skip →', cls: 'friday-triage-proc-nav' });
		skipBtn.addEventListener('click', () => this.skip());
		footer.createSpan({ cls: 'friday-triage-proc-hint', text: 'Esc to close' });
	}

	private renderDone(): void {
		const { contentEl } = this;
		contentEl.empty();
		const done = contentEl.createDiv({ cls: 'friday-triage-proc-done' });
		done.createDiv({ cls: 'friday-triage-proc-done-emoji', text: '🎉' });
		done.createDiv({ cls: 'friday-triage-proc-done-title', text: 'Inbox processed' });

		const parts: string[] = [];
		const label: Record<CountKey, string> = {
			done: 'completed', dated: 'dated', snoozed: 'snoozed', someday: 'to Someday',
			topic: 'to topics', dropped: 'dropped', skipped: 'skipped',
		};
		for (const key of Object.keys(this.counts) as CountKey[]) {
			if (this.counts[key] > 0) parts.push(`${this.counts[key]} ${label[key]}`);
		}
		done.createDiv({
			cls: 'friday-triage-proc-done-summary',
			text: parts.length ? parts.join(' · ') : 'Nothing to do.',
		});

		const closeBtn = done.createEl('button', { text: 'Close', cls: 'friday-add-btn' });
		closeBtn.addEventListener('click', () => this.close());
	}
}
