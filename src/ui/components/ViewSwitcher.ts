import { BuJoViewMode } from '../../types';

export interface ViewSwitcherCallbacks {
	onViewChange: (mode: BuJoViewMode) => void;
}

export class ViewSwitcher {
	private el: HTMLElement;

	constructor(
		container: HTMLElement,
		private currentMode: BuJoViewMode,
		private callbacks: ViewSwitcherCallbacks
	) {
		this.el = container.createDiv({ cls: 'task-bujo-view-switcher' });
		this.render();
	}

	private render(): void {
		this.el.empty();

		const tabs: { mode: BuJoViewMode; label: string }[] = [
			{ mode: BuJoViewMode.Daily, label: 'Daily' },
			{ mode: BuJoViewMode.Weekly, label: 'Weekly' },
			{ mode: BuJoViewMode.Monthly, label: 'Monthly' },
			{ mode: BuJoViewMode.Calendar, label: 'Calendar' },
			{ mode: BuJoViewMode.Sprint, label: 'Sprint' },
			{ mode: BuJoViewMode.Overdue, label: 'Overdue' },
			{ mode: BuJoViewMode.Overview, label: 'Overview' },
			{ mode: BuJoViewMode.Eisenhower, label: 'Eisenhower' },
			{ mode: BuJoViewMode.ImpactEffort, label: 'Impact/Effort' },
			{ mode: BuJoViewMode.Analytics, label: 'Analytics' },
		];

		for (const { mode, label } of tabs) {
			const tab = this.el.createEl('button', {
				cls: 'task-bujo-view-tab'
			});
			tab.createSpan({ text: label });

			if (mode === this.currentMode) {
				tab.addClass('task-bujo-view-tab-active');
			}

			tab.addEventListener('click', () => {
				this.currentMode = mode;
				this.callbacks.onViewChange(mode);
				this.render();
			});
		}
	}

	setMode(mode: BuJoViewMode): void {
		this.currentMode = mode;
		this.render();
	}

	getElement(): HTMLElement {
		return this.el;
	}
}
