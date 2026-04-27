import { GroupMode, FridayViewMode } from '../../types';
import { SEARCH_DEBOUNCE_MS } from '../../constants';

export interface ToolbarCallbacks {
	onGroupModeChange: (mode: GroupMode) => void;
	onSearchChange: (query: string) => void;
}

export class Toolbar {
	private el: HTMLElement;
	private searchValue: string = '';
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		container: HTMLElement,
		private currentGroupMode: GroupMode,
		private viewMode: FridayViewMode,
		private callbacks: ToolbarCallbacks
	) {
		this.el = container.createDiv({ cls: 'friday-toolbar' });
		this.render();
	}

	private render(): void {
		this.el.empty();

		// Search input — always shown
		const searchContainer = this.el.createDiv({ cls: 'friday-search' });
		const searchInput = searchContainer.createEl('input', {
			type: 'text',
			placeholder: 'Search tasks...',
			cls: 'friday-search-input'
		});
		searchInput.value = this.searchValue;
		searchInput.addEventListener('input', () => {
			this.searchValue = searchInput.value;
			if (this.debounceTimer) clearTimeout(this.debounceTimer);
			this.debounceTimer = setTimeout(() => {
				this.callbacks.onSearchChange(this.searchValue);
			}, SEARCH_DEBOUNCE_MS);
		});

		// Grouping — only for Sprint and Overdue views
		const showGrouping = this.viewMode === FridayViewMode.Sprint ||
			this.viewMode === FridayViewMode.Overdue ||
			this.viewMode === FridayViewMode.Overview;

		if (showGrouping) {
			const groupContainer = this.el.createDiv({ cls: 'friday-group-selector' });
			groupContainer.createSpan({ text: 'Group:', cls: 'friday-label' });

			const groupModes: { mode: GroupMode; label: string }[] = [
				{ mode: GroupMode.ByPage, label: 'Page' },
				{ mode: GroupMode.ByPriority, label: 'Priority' },
				{ mode: GroupMode.ByDueDate, label: 'Due Date' },
			];

			for (const { mode, label } of groupModes) {
				const btn = groupContainer.createEl('button', {
					text: label,
					cls: 'friday-group-btn'
				});
				if (mode === this.currentGroupMode) {
					btn.addClass('friday-active');
				}
				btn.addEventListener('click', () => {
					this.currentGroupMode = mode;
					this.callbacks.onGroupModeChange(mode);
					this.render();
				});
			}
		}
	}

	/** Update for a new view mode without full re-create */
	setViewMode(viewMode: FridayViewMode): void {
		this.viewMode = viewMode;
		this.render();
	}

	destroy(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
	}

	getElement(): HTMLElement {
		return this.el;
	}
}
