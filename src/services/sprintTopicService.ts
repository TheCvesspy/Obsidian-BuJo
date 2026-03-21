import { Vault, TFile, TFolder } from 'obsidian';
import { SprintTopic, TopicStatus, Priority, PluginSettings } from '../types';
import { parseTopicFile, parseFrontmatter, serializeFrontmatter } from '../parser/topicParser';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;

export class SprintTopicService {
	constructor(
		private vault: Vault,
		private getSettings: () => PluginSettings,
	) {}

	/** Get the topics folder path from settings */
	getTopicsFolderPath(): string {
		return this.getSettings().sprintTopicsPath;
	}

	/** Generate a file path for a topic, sanitizing the title for use as a filename */
	getTopicFilePath(title: string): string {
		const sanitized = title
			.replace(/[\\/:*?"<>|#^[\]]/g, '')
			.replace(/\s+/g, ' ')
			.trim();
		return `${this.getTopicsFolderPath()}/${sanitized}.md`;
	}

	/** Create a new topic file with frontmatter and template sections */
	async createTopic(
		title: string,
		jira: string | null,
		priority: Priority,
		linkedPages: string[],
		sprintId: string,
	): Promise<SprintTopic> {
		const filePath = this.getTopicFilePath(title);

		// Ensure folder exists
		const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));
		if (folderPath && !(this.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) {
			await this.ensureFolderExists(folderPath);
		}

		const frontmatter = serializeFrontmatter({
			status: 'open',
			jira: jira || '',
			priority: priority === Priority.None ? 'none' : priority,
			blocked: false,
			sprint: sprintId,
			sortOrder: 999,
		});

		const linkedSection = linkedPages.length > 0
			? linkedPages.map(p => `- [[${p}]]`).join('\n')
			: '';

		const content = `${frontmatter}\n# ${title}\n\n## Linked Pages\n${linkedSection}\n\n## Tasks\n\n## Notes\n`;

		await this.vault.create(filePath, content);
		return parseTopicFile(content, filePath);
	}

	/** Update specific frontmatter fields in a topic file, preserving body content */
	async updateTopicFrontmatter(
		filePath: string,
		updates: Partial<Record<string, string | number | boolean | null>>,
	): Promise<void> {
		const file = this.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return;

		const content = await this.vault.read(file);
		const fm = parseFrontmatter(content);

		// Apply updates
		for (const [key, value] of Object.entries(updates)) {
			if (value === null || value === undefined) {
				fm[key] = '';
			} else {
				fm[key] = String(value);
			}
		}

		// Rebuild frontmatter
		const fmLines = ['---'];
		for (const [key, value] of Object.entries(fm)) {
			fmLines.push(`${key}: ${value}`);
		}
		fmLines.push('---');
		const newFm = fmLines.join('\n');

		// Replace frontmatter in content
		const body = content.replace(FRONTMATTER_REGEX, '').trimStart();
		const newContent = newFm + '\n' + body;
		await this.vault.modify(file, newContent);
	}

	/** Set the status of a topic (open, in-progress, done) */
	async setTopicStatus(filePath: string, status: TopicStatus): Promise<void> {
		await this.updateTopicFrontmatter(filePath, { status });
	}

	/** Set the blocked flag on a topic */
	async setTopicBlocked(filePath: string, blocked: boolean): Promise<void> {
		await this.updateTopicFrontmatter(filePath, { blocked });
	}

	/** Update the sort order of a topic within its column */
	async updateSortOrder(filePath: string, sortOrder: number): Promise<void> {
		await this.updateTopicFrontmatter(filePath, { sortOrder });
	}

	/** Carry a topic forward to a new sprint */
	async carryForwardTopic(filePath: string, newSprintId: string): Promise<void> {
		await this.updateTopicFrontmatter(filePath, { sprint: newSprintId });
	}

	/** Archive a topic (mark done, clear sprint) */
	async archiveTopic(filePath: string): Promise<void> {
		await this.updateTopicFrontmatter(filePath, { status: 'done', sprint: '' });
	}

	/** Cancel a topic (mark done, clear sprint) */
	async cancelTopic(filePath: string): Promise<void> {
		await this.updateTopicFrontmatter(filePath, { status: 'done', sprint: '' });
	}

	/** Get all topics from the topics folder */
	async getAllTopics(): Promise<SprintTopic[]> {
		const folderPath = this.getTopicsFolderPath();
		const folder = this.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) return [];

		const topics: SprintTopic[] = [];
		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === 'md') {
				const content = await this.vault.read(child);
				topics.push(parseTopicFile(content, child.path));
			}
		}
		return topics;
	}

	/** Get topics assigned to a specific sprint */
	async getTopicsForSprint(sprintId: string): Promise<SprintTopic[]> {
		const all = await this.getAllTopics();
		return all.filter(t => t.sprintId === sprintId);
	}

	/** Recursively create folder hierarchy */
	private async ensureFolderExists(folderPath: string): Promise<void> {
		const parts = folderPath.split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(this.vault.getAbstractFileByPath(current) instanceof TFolder)) {
				try {
					await this.vault.createFolder(current);
				} catch {
					// Folder might already exist
				}
			}
		}
	}
}
