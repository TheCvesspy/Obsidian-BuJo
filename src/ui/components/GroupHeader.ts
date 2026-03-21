export class GroupHeader {
	private el: HTMLElement;
	private contentEl: HTMLElement;
	private collapsed: boolean;

	constructor(
		container: HTMLElement,
		private label: string,
		private count: number,
		private collapsible: boolean = true,
		private collapsedGroups?: Set<string>
	) {
		this.collapsed = collapsedGroups?.has(label) ?? false;
		this.el = container.createDiv({ cls: 'task-bujo-group-header' });
		this.contentEl = container.createDiv({ cls: 'task-bujo-group-content' });
		this.render();
	}

	private render(): void {
		const headerRow = this.el.createDiv({ cls: 'task-bujo-group-header-row' });

		if (this.collapsible) {
			const chevron = headerRow.createSpan({ cls: 'task-bujo-chevron' });
			chevron.textContent = this.collapsed ? '▶' : '▼';
			this.el.addEventListener('click', () => this.toggle());
			this.el.addClass('task-bujo-clickable');
		}

		headerRow.createSpan({
			cls: 'task-bujo-group-label',
			text: this.label
		});

		headerRow.createSpan({
			cls: 'task-bujo-group-count',
			text: `(${this.count})`
		});

		if (this.collapsed) {
			this.contentEl.addClass('task-bujo-collapsed');
		}
	}

	toggle(): void {
		this.collapsed = !this.collapsed;
		this.contentEl.toggleClass('task-bujo-collapsed', this.collapsed);
		const chevron = this.el.querySelector('.task-bujo-chevron');
		if (chevron) {
			chevron.textContent = this.collapsed ? '▶' : '▼';
		}
		// Persist state externally
		if (this.collapsedGroups) {
			if (this.collapsed) {
				this.collapsedGroups.add(this.label);
			} else {
				this.collapsedGroups.delete(this.label);
			}
		}
	}

	/** Get the content container to add task rows into */
	getContentEl(): HTMLElement {
		return this.contentEl;
	}

	getElement(): HTMLElement {
		return this.el;
	}
}
