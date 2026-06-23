import { App, FuzzySuggestModal, FuzzyMatch } from 'obsidian';
import { SprintTopic, TopicStatus, PluginSettings } from '../types';

const STATUS_LABEL: Record<TopicStatus, string> = {
	backlog: 'Backlog',
	open: 'To Do',
	'in-progress': 'In Progress',
	done: 'Done',
};

/** Fuzzy "go to topic" switcher. Matches on title and JIRA keys; opens the topic file. */
export class TopicSwitcherModal extends FuzzySuggestModal<SprintTopic> {
	constructor(
		app: App,
		private topics: SprintTopic[],
		private onChoose: (topic: SprintTopic) => void,
		private settings?: PluginSettings,
	) {
		super(app);
		this.setPlaceholder('Go to topic…');
		this.setInstructions([
			{ command: '↑↓', purpose: 'navigate' },
			{ command: '⏎', purpose: 'open topic' },
			{ command: 'esc', purpose: 'cancel' },
		]);
	}

	getItems(): SprintTopic[] {
		return this.topics;
	}

	getItemText(t: SprintTopic): string {
		// Append JIRA keys so typing a key also surfaces the topic.
		return t.jira.length > 0 ? `${t.title} ${t.jira.join(' ')}` : t.title;
	}

	renderSuggestion(match: FuzzyMatch<SprintTopic>, el: HTMLElement): void {
		const t = match.item;
		el.createDiv({ cls: 'friday-switcher-title', text: t.title });

		const bits: string[] = [STATUS_LABEL[t.status]];
		if (t.blocked) bits.push('BLOCKED');
		if (t.assignee) bits.push(this.assigneeLabel(t.assignee));
		if (t.jira.length > 0) bits.push(t.jira.join(', '));
		el.createDiv({ cls: 'friday-switcher-hint', text: bits.join(' · ') });
	}

	private assigneeLabel(email: string): string {
		const m = (this.settings?.teamMembers ?? []).find(x => x.email === email);
		return m ? (m.nickname || m.fullName || email) : email;
	}

	onChooseItem(t: SprintTopic): void {
		this.onChoose(t);
	}
}
