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

		// Tab order is a deliberate flow:
		//   Daily ← today's work, the morning-review landing tab
		//   Topics ← strategic units, promoted to the front per user request
		//   Weekly / Monthly / Calendar ← time-scoped views, ascending granularity
		//   Unscheduled ← un-dated backlog (its own tab — used to be a section inside Daily)
		//   Inbox / Overdue / Overview / Analytics ← triage + retrospective
		const tabs: { mode: FridayViewMode; label: string }[] = [
			{ mode: FridayViewMode.Daily, label: 'Daily' },
			{ mode: FridayViewMode.Topics, label: 'Topics' },
			{ mode: FridayViewMode.Weekly, label: 'Weekly' },
			{ mode: FridayViewMode.Monthly, label: 'Monthly' },
			{ mode: FridayViewMode.Calendar, label: 'Calendar' },
			{ mode: FridayViewMode.Unscheduled, label: 'Unscheduled' },
			{ mode: FridayViewMode.Inbox, label: '\u{1F4E5} Inbox' },
			{ mode: FridayViewMode.Overdue, label: 'Overdue' },
			{ mode: FridayViewMode.Overview, label: 'Overview' },
			{ mode: FridayViewMode.Analytics, label: 'Analytics' },
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
