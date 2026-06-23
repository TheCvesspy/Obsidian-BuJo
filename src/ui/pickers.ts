import { App, FuzzySuggestModal, FuzzyMatch } from 'obsidian';

export interface PickOption<T> {
	/** Primary label — what fuzzy search matches against. */
	text: string;
	/** The value returned when this option is chosen. */
	value: T;
	/** Optional muted hint shown to the right of the label. */
	hint?: string;
}

/** A generic fuzzy picker over a list of {text, value, hint} options. */
class GenericPickerModal<T> extends FuzzySuggestModal<PickOption<T>> {
	private chosen = false;

	constructor(
		app: App,
		private options: PickOption<T>[],
		private resolveChoice: (value: T | null) => void,
		opts?: { placeholder?: string },
	) {
		super(app);
		this.setPlaceholder(opts?.placeholder ?? 'Pick one…');
		this.setInstructions([
			{ command: '↑↓', purpose: 'navigate' },
			{ command: '⏎', purpose: 'select' },
			{ command: 'esc', purpose: 'cancel' },
		]);
	}

	getItems(): PickOption<T>[] {
		return this.options;
	}

	getItemText(item: PickOption<T>): string {
		return item.text;
	}

	renderSuggestion(match: FuzzyMatch<PickOption<T>>, el: HTMLElement): void {
		const opt = match.item;
		el.createSpan({ text: opt.text });
		if (opt.hint) {
			el.createSpan({ cls: 'friday-picker-hint', text: opt.hint });
		}
	}

	onChooseItem(item: PickOption<T>): void {
		this.chosen = true;
		this.resolveChoice(item.value);
	}

	onClose(): void {
		// Dismissed without a choice (Esc / click-away) → resolve null so chained
		// pickers abort cleanly. A real selection has already resolved in onChooseItem.
		if (!this.chosen) this.resolveChoice(null);
	}
}

/**
 * Show a fuzzy picker over `options` and resolve to the chosen value, or `null` if the
 * user dismissed it. Promise-based so commands can chain pickers linearly:
 *
 *   const topic = await pickFromList(app, topicOpts);
 *   if (!topic) return;            // dismissed
 *   const status = await pickFromList(app, statusOpts);
 *   if (status === null) return;   // dismissed (note: '' may be a valid value)
 */
export function pickFromList<T>(
	app: App,
	options: PickOption<T>[],
	opts?: { placeholder?: string },
): Promise<T | null> {
	return new Promise(resolve => {
		new GenericPickerModal<T>(app, options, resolve, opts).open();
	});
}
