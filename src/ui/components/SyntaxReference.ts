import { App, Modal, MarkdownView } from 'obsidian';

export class SyntaxReferenceModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	/** Try to get the active markdown editor (if any) */
	private getActiveEditor() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return view?.editor ?? null;
	}

	/** Insert text at cursor position in the active editor */
	private insertAtCursor(text: string): void {
		const editor = this.getActiveEditor();
		if (!editor) return;

		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);

		// If cursor is on a non-empty line, append with a space
		if (line.length > 0 && cursor.ch === line.length) {
			editor.replaceRange(' ' + text, cursor);
		} else if (line.length > 0) {
			editor.replaceRange(text, cursor);
		} else {
			editor.replaceRange(text, cursor);
		}

		// Move cursor to end of inserted text
		const newCh = cursor.ch + (line.length > 0 && cursor.ch === line.length ? text.length + 1 : text.length);
		editor.setCursor({ line: cursor.line, ch: newCh });
		editor.focus();
		this.close();
	}

	/** Create a clickable syntax row — inserts on click if editor is available */
	private createSyntaxRow(table: HTMLTableElement, syntax: string, desc: string): void {
		const row = table.createEl('tr', { cls: 'friday-syntax-row-clickable' });
		row.createEl('td', { cls: 'friday-syntax-code' })
			.createEl('code', { text: syntax });
		row.createEl('td', { cls: 'friday-syntax-desc', text: desc });

		row.addEventListener('click', () => this.insertAtCursor(syntax));
		row.setAttribute('title', 'Click to insert at cursor');
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('friday-syntax-modal');
		contentEl.createEl('h2', { text: 'Syntax Reference' });

		const hasEditor = this.getActiveEditor() !== null;
		if (hasEditor) {
			contentEl.createEl('p', {
				text: 'Click any row to insert at cursor position.',
				cls: 'friday-syntax-hint',
			});
		}

		const entries: [string, string][] = [
			['- [ ] Task text', 'Open task'],
			['- [x] Task text', 'Completed task'],
			['- [>] Task text', 'Migrated (carried forward)'],
			['- [<] Task text', 'Scheduled to future date'],
			['- [-] Task text', 'Cancelled / dropped'],
			['', ''],
			['#priority/high', 'High priority'],
			['#priority/medium', 'Medium priority'],
			['#priority/low', 'Low priority'],
			['', ''],
			['@due 20-03-2026', 'Due date (DD-MM-YYYY)'],
			['@due 20-03', 'Due date (DD-MM, nearest future)'],
			['@due today', 'Due today'],
			['@due tomorrow', 'Due tomorrow'],
			['@due next friday', 'Due next Friday'],
			['@due in 3 days', 'Due in 3 days'],
			['@due next week', 'Due next Monday'],
			['@due end of month', 'Due end of month'],
			['', ''],
			['#type/task', 'Force classify as Task'],
			['#type/openpoint', 'Force classify as Open Point'],
			['#type/inbox', 'Force classify as Inbox'],
			['', ''],
			['#work/name or #w/CODE', 'Work type tag'],
			['#purpose/name or #p/CODE', 'Purpose tag'],
			['', ''],
			['(from [[PageName]])', 'Migration source link'],
			['', ''],
			['## Tasks', 'Heading → items are Tasks'],
			['## Open Points', 'Heading → items are Open Points'],
			['## Inbox', 'Heading → items are quick-capture Inbox'],
		];

		const table = contentEl.createEl('table', { cls: 'friday-syntax-table' });
		for (const [syntax, desc] of entries) {
			if (!syntax && !desc) {
				const row = table.createEl('tr', { cls: 'friday-syntax-separator' });
				row.createEl('td', { attr: { colspan: '2' } });
				continue;
			}
			if (hasEditor) {
				this.createSyntaxRow(table, syntax, desc);
			} else {
				const row = table.createEl('tr');
				row.createEl('td', { cls: 'friday-syntax-code' })
					.createEl('code', { text: syntax });
				row.createEl('td', { cls: 'friday-syntax-desc', text: desc });
			}
		}

		// Work type and purpose defaults
		contentEl.createEl('h3', { text: 'Default Work Types' });
		const wtTable = contentEl.createEl('table', { cls: 'friday-syntax-table' });
		const workTypes = [
			['Deep Work', 'DW'], ['Review', 'RV'], ['Coordination', 'CO'],
			['Admin', 'AD'], ['Learning', 'LN'], ['Leadership', 'LD'],
		];
		for (const [name, code] of workTypes) {
			if (hasEditor) {
				this.createSyntaxRow(wtTable, `#w/${code}`, name);
			} else {
				const row = wtTable.createEl('tr');
				row.createEl('td', { cls: 'friday-syntax-code' })
					.createEl('code', { text: `#w/${code}` });
				row.createEl('td', { cls: 'friday-syntax-desc', text: name });
			}
		}

		contentEl.createEl('h3', { text: 'Default Purposes' });
		const pTable = contentEl.createEl('table', { cls: 'friday-syntax-table' });
		const purposes = [
			['Delivery', 'D'], ['Capability', 'CA'], ['Strategy', 'ST'], ['Support', 'SU'],
		];
		for (const [name, code] of purposes) {
			if (hasEditor) {
				this.createSyntaxRow(pTable, `#p/${code}`, name);
			} else {
				const row = pTable.createEl('tr');
				row.createEl('td', { cls: 'friday-syntax-code' })
					.createEl('code', { text: `#p/${code}` });
				row.createEl('td', { cls: 'friday-syntax-desc', text: name });
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
