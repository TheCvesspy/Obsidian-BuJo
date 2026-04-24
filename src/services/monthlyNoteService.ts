import { Vault, TFile, TFolder } from 'obsidian';
import { PluginSettings } from '../types';
import { getMonthId, formatMonthDisplay } from '../utils/monthUtils';

export class MonthlyNoteService {
	constructor(private vault: Vault, private getSettings: () => PluginSettings) {}

	/** Get the file path for a monthly note */
	getMonthlyNotePath(date: Date): string {
		const settings = this.getSettings();
		return `${settings.monthlyNotePath}/${getMonthId(date)}.md`;
	}

	/** Get or create a monthly note file. Creates folders if needed. */
	async getOrCreateMonthlyNote(date: Date): Promise<TFile> {
		const path = this.getMonthlyNotePath(date);
		const existing = this.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			return existing;
		}

		// Ensure parent folders exist
		const folderPath = path.substring(0, path.lastIndexOf('/'));
		if (folderPath && !(this.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) {
			try {
				await this.vault.createFolder(folderPath);
			} catch {
				// Folder might already exist
			}
		}

		const displayDate = formatMonthDisplay(date);
		const template = `# Monthly Log — ${displayDate}\n\n## Tasks\n\n## Reflections\n`;

		const file = await this.vault.create(path, template);
		return file;
	}

	/** Read the reflections content from a monthly note */
	async readReflections(date: Date): Promise<string> {
		const path = this.getMonthlyNotePath(date);
		const file = this.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return '';

		const content = await this.vault.read(file);
		const headingStr = '## Reflections';
		const headingIndex = content.indexOf(headingStr);
		if (headingIndex === -1) return '';

		// Find start of content after heading
		let start = content.indexOf('\n', headingIndex);
		if (start === -1) return '';
		start += 1;

		// Find next heading or EOF
		const nextHeading = content.indexOf('\n## ', start);
		const end = nextHeading !== -1 ? nextHeading : content.length;

		return content.slice(start, end).trim();
	}

	/** Write reflections content to a monthly note under ## Reflections */
	async writeReflections(date: Date, text: string): Promise<void> {
		const file = await this.getOrCreateMonthlyNote(date);
		await this.vault.process(file, content => {
			const headingStr = '## Reflections';
			const headingIndex = content.indexOf(headingStr);

			if (headingIndex === -1) {
				// Append reflections section
				return content.trimEnd() + '\n\n## Reflections\n\n' + text + '\n';
			}

			// Find the range to replace
			let start = content.indexOf('\n', headingIndex);
			if (start === -1) start = content.length;
			else start += 1;

			const nextHeading = content.indexOf('\n## ', start);
			const end = nextHeading !== -1 ? nextHeading : content.length;

			return content.slice(0, start) + '\n' + text + '\n' + content.slice(end);
		});
	}
}
