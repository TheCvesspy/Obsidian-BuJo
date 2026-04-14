import { Vault, TFile, TFolder } from 'obsidian';
import { SprintTopic, TopicStatus, Priority, PluginSettings, TopicImpact, TopicEffort } from '../types';
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

	/** Create a new topic file with frontmatter and template sections.
	 *  `jira` may be a single key or a comma-separated list of keys — stored verbatim
	 *  in the `jira:` frontmatter field; the parser extracts individual keys on read. */
	async createTopic(
		title: string,
		jira: string | null,
		priority: Priority,
		linkedPages: string[],
		sprintId: string,
		impact: TopicImpact | null = null,
		effort: TopicEffort | null = null,
		dueDate: string | null = null,
	): Promise<SprintTopic> {
		const filePath = this.getTopicFilePath(title);

		// Ensure folder exists
		const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));
		if (folderPath && !(this.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) {
			await this.ensureFolderExists(folderPath);
		}

		// Null-valued keys are omitted by serializeFrontmatter — keeps YAML clean.
		// sprintHistory mirrors the initial sprint assignment (empty if backlog).
		const frontmatter = serializeFrontmatter({
			status: 'open',
			jira: jira || null,
			priority: priority === Priority.None ? 'none' : priority,
			blocked: false,
			sprint: sprintId || null,
			sortOrder: 999,
			impact,
			effort,
			dueDate,
			sprintHistory: sprintId || null,
		});

		const linkedSection = linkedPages.length > 0
			? linkedPages.map(p => `- [[${p}]]`).join('\n')
			: '';

		// Frontmatter fields recognized by the plugin:
		//   status: open | in-progress | done
		//   priority: none | low | medium | high
		//   blocked: true | false
		//   sprint: <sprint-id> (empty for backlog)
		//   sortOrder: <number> (Kanban column ordering)
		//   impact: critical | high | medium | low  (Impact/Effort + Eisenhower matrix)
		//   effort: xs | s | m | l | xl             (Impact/Effort matrix)
		//   dueDate: YYYY-MM-DD                     (Eisenhower urgency)
		//   jira: <ticket>
		//   sprintHistory: <id1>,<id2>,...          (cumulative — every sprint this topic was in)
		const content = `${frontmatter}\n# ${title}\n\n## Linked Pages\n${linkedSection}\n\n## Tasks\n\n## Notes\n`;

		await this.vault.create(filePath, content);
		return parseTopicFile(content, filePath);
	}

	/** Update specific frontmatter fields in a topic file, preserving body content.
	 *  Passing `null` for a value removes the key from the frontmatter entirely. */
	async updateTopicFrontmatter(
		filePath: string,
		updates: Partial<Record<string, string | number | boolean | null>>,
	): Promise<void> {
		const file = this.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return;

		const content = await this.vault.read(file);
		const fm = parseFrontmatter(content);

		// Apply updates: null deletes the key, anything else stringifies.
		for (const [key, value] of Object.entries(updates)) {
			if (value === null || value === undefined) {
				delete fm[key];
			} else {
				fm[key] = String(value);
			}
		}

		// Rebuild frontmatter (empty-string values are retained — legacy callers rely on that)
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

	/** Set the strategic impact on a topic (null clears the field) */
	async setTopicImpact(filePath: string, impact: TopicImpact | null): Promise<void> {
		await this.updateTopicFrontmatter(filePath, { impact });
	}

	/** Set the effort estimate on a topic (null clears the field) */
	async setTopicEffort(filePath: string, effort: TopicEffort | null): Promise<void> {
		await this.updateTopicFrontmatter(filePath, { effort });
	}

	/** Set the due date on a topic (null clears the field) */
	async setTopicDueDate(filePath: string, dueDate: string | null): Promise<void> {
		await this.updateTopicFrontmatter(filePath, { dueDate });
	}

	/** Update the sort order of a topic within its column */
	async updateSortOrder(filePath: string, sortOrder: number): Promise<void> {
		await this.updateTopicFrontmatter(filePath, { sortOrder });
	}

	/** Carry a topic forward to a new sprint (sprint-close flow). Adds to history. */
	async carryForwardTopic(filePath: string, newSprintId: string): Promise<void> {
		await this.assignTopicToSprint(filePath, newSprintId);
	}

	/** Move a topic to the backlog (clear sprint assignment). Status and history preserved. */
	async moveTopicToBacklog(filePath: string): Promise<void> {
		await this.assignTopicToSprint(filePath, '');
	}

	/** Assign a topic to a specific sprint (or pass '' to move to backlog).
	 *  Appends the previous sprint (if any) AND the new sprint to sprintHistory —
	 *  the old one may be missing on legacy topics that were assigned before history
	 *  tracking existed, so we defensively capture it here. History is cumulative:
	 *  moving to backlog does NOT remove anything. */
	async assignTopicToSprint(filePath: string, sprintId: string): Promise<void> {
		const file = this.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return;

		const content = await this.vault.read(file);
		const fm = parseFrontmatter(content);
		const oldSprint = (fm['sprint'] || '').trim();
		const existing = (fm['sprintHistory'] || '')
			.split(',')
			.map(s => s.trim())
			.filter(Boolean);

		const merged: string[] = [...existing];
		const seen = new Set(existing);
		for (const s of [oldSprint, sprintId]) {
			if (s && !seen.has(s)) {
				merged.push(s);
				seen.add(s);
			}
		}

		await this.updateTopicFrontmatter(filePath, {
			sprint: sprintId,
			sprintHistory: merged.length > 0 ? merged.join(',') : null,
		});
	}

	/** Archive a topic (mark done, clear sprint). History is preserved — go through
	 *  assignTopicToSprint so the departing sprint is captured into sprintHistory. */
	async archiveTopic(filePath: string): Promise<void> {
		await this.assignTopicToSprint(filePath, '');
		await this.updateTopicFrontmatter(filePath, { status: 'done' });
	}

	/** Cancel a topic (mark done, clear sprint). Same history semantics as archiveTopic. */
	async cancelTopic(filePath: string): Promise<void> {
		await this.assignTopicToSprint(filePath, '');
		await this.updateTopicFrontmatter(filePath, { status: 'done' });
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
