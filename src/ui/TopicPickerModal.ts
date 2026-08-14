import { App, FuzzySuggestModal, FuzzyMatch } from 'obsidian';
import { SprintTopic } from '../types';

/** Kanban-flow order: the topics you're most likely triaging into come first. */
const STATUS_ORDER: Record<string, number> = { 'in-progress': 0, open: 1, backlog: 2, done: 3 };
const STATUS_GLYPH: Record<string, string> = { 'in-progress': '🔵', open: '⚪', backlog: '⏳', done: '✅' };

/**
 * Fuzzy topic picker (v3 triage). Search by title; suggestions are ordered by
 * Kanban status (in-progress → open → backlog → done) so live work surfaces first.
 */
export class TopicPickerModal extends FuzzySuggestModal<SprintTopic> {
	constructor(
		app: App,
		private topics: SprintTopic[],
		private onChoose: (topic: SprintTopic) => void,
	) {
		super(app);
		this.setPlaceholder('Send task to topic…');
	}

	getItems(): SprintTopic[] {
		return [...this.topics].sort((a, b) =>
			(STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
			|| a.title.localeCompare(b.title),
		);
	}

	getItemText(topic: SprintTopic): string {
		return topic.title;
	}

	renderSuggestion(match: FuzzyMatch<SprintTopic>, el: HTMLElement): void {
		const topic = match.item;
		el.createSpan({ text: `${STATUS_GLYPH[topic.status] ?? '⚪'} ` });
		el.createSpan({ text: topic.title });
	}

	onChooseItem(topic: SprintTopic): void {
		this.onChoose(topic);
	}
}
