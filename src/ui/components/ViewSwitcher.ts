import { FridayViewMode } from '../../types';

export interface ViewSwitcherCallbacks {
	onViewChange: (mode: FridayViewMode) => void;
}

export class ViewSwitcher {
	private el: HTMLElement;

	constructor(
		container: HTMLElement,
		private currentMode: FridayViewMode,
		private callbacks: ViewSwitcherCallbacks
	) {
		this.el = container.createDiv({ cls: 'friday-view-switcher' });
		this.render();
	}

	private render(): void {
		this.el.empty();

		// v3 streamlined flow, six tabs:
		//   Today    ← due today + overdue, the daily driver
		//   Upcoming ← the near-term horizon (next N days) + waking-snoozed
		//   Triage   ← the loose-task inbox to empty
		//   Someday  ← dateless backlog for periodic review
		//   Calendar ← month grid overview
		//   Topics   ← the strategic layer (board / list / roadmap)
		// Retired tabs (Daily/Weekly/Monthly/Overdue/Overview/Inbox/Unscheduled/Analytics)
		// stay as enum values for settings back-compat but are no longer surfaced here;
		// Analytics is reachable via its command.
		const tabs: { mode: FridayViewMode; label: string }[] = [
			{ mode: FridayViewMode.Today, label: 'Today' },
			{ mode: FridayViewMode.Upcoming, label: 'Upcoming' },
			{ mode: FridayViewMode.Triage, label: '\u{1F4E5} Triage' },
			{ mode: FridayViewMode.Someday, label: 'Someday' },
			{ mode: FridayViewMode.Calendar, label: 'Calendar' },
			{ mode: FridayViewMode.Topics, label: 'Topics' },
		];

		for (const { mode, label } of tabs) {
			const tab = this.el.createEl('button', {
				cls: 'friday-view-tab'
			});
			tab.createSpan({ text: label });

			if (mode === this.currentMode) {
				tab.addClass('friday-view-tab-active');
			}

			tab.addEventListener('click', () => {
				this.currentMode = mode;
				this.callbacks.onViewChange(mode);
				this.render();
			});
		}
	}

	setMode(mode: FridayViewMode): void {
		this.currentMode = mode;
		this.render();
	}

	getElement(): HTMLElement {
		return this.el;
	}
}
