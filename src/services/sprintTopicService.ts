import { Vault, TFile, TFolder } from 'obsidian';
import { SprintTopic, TopicStatus, Priority, PluginSettings, TopicImpact, TopicEffort } from '../types';
import { parseTopicFile, parseFrontmatter, serializeFrontmatter, serializeRefs, foldedScalar } from '../parser/topicParser';

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
		impact: TopicImpact | null = null,
		effort: TopicEffort | null = null,
		dueDate: string | null = null,
		assignee: string | null = null,
		waitingOn: string | null = null,
		lastNudged: string | null = null,
		refs: Array<{ label: string; url: string }> = [],
	): Promise<SprintTopic> {
		const filePath = this.getTopicFilePath(title);

		// Ensure folder exists
		const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));
		if (folderPath && !(this.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) {
			await this.ensureFolderExists(folderPath);
		}

		// Null-valued keys are omitted by serializeFrontmatter — keeps YAML clean.
		// New topics start in the Backlog column; statusSince stamps the flow clock.
		const today = new Date().toISOString().slice(0, 10);
		const frontmatter = serializeFrontmatter({
			status: 'backlog',
			jira: jira || null,
			priority: priority === Priority.None ? 'none' : priority,
			blocked: false,
			sortOrder: 999,
			impact,
			effort,
			dueDate,
			statusSince: today,
			assignee,
			waitingOn,
			lastNudged,
			refs: refs.length > 0 ? foldedScalar(serializeRefs(refs)) : null,
		});

		const linkedSection = linkedPages.length > 0
			? linkedPages.map(p => `- [[${p}]]`).join('\n')
			: '';

		// Frontmatter fields recognized by the plugin:
		//   status: backlog | open | in-progress | done
		//   priority: none | low | medium | high
		//   blocked: true | false
		//   sortOrder: <number> (Kanban column ordering)
		//   impact: critical | high | medium | low  (Impact/Effort + Eisenhower matrix)
		//   effort: xs | s | m | l | xl             (Impact/Effort matrix)
		//   dueDate: YYYY-MM-DD                     (Eisenhower urgency)
		//   statusSince / startedAt / doneAt: YYYY-MM-DD (Kanban flow timestamps)
		//   jira: <ticket>
		const content = `${frontmatter}\n# ${title}\n\n## Linked Pages\n${linkedSection}\n\n## Tasks\n\n## Notes\n`;

		await this.vault.create(filePath, content);
		return parseTopicFile(content, filePath);
	}

	/** Mark a topic as nudged today. Sets `lastNudged` to the current ISO date.
	 *  Used by the morning migration modal "Just nudged" button. */
	async markNudged(filePath: string): Promise<void> {
		const today = new Date().toISOString().slice(0, 10);
		await this.updateTopicFrontmatter(filePath, { lastNudged: today });
	}

	/** Update specific frontmatter fields in a topic file, preserving body content.
	 *  Passing `null` for a value removes the key from the frontmatter entirely. */
	async updateTopicFrontmatter(
		filePath: string,
		updates: Partial<Record<string, string | number | boolean | null>>,
	): Promise<void> {
		const file = this.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return;

		await this.vault.process(file, content => {
			const fm = parseFrontmatter(content);
			this.applyFrontmatterUpdates(fm, updates);
			return this.rebuildWithFrontmatter(content, fm);
		});
	}

	/** Apply updates to a parsed frontmatter object.
	 *  `null`/`undefined` deletes the key; everything else stringifies. */
	private applyFrontmatterUpdates(
		fm: Record<string, string>,
		updates: Partial<Record<string, string | number | boolean | null>>,
	): void {
		for (const [key, value] of Object.entries(updates)) {
			if (value === null || value === undefined) {
				delete fm[key];
			} else {
				fm[key] = String(value);
			}
		}
	}

	/** Serialize a frontmatter object and splice it back into the original content.
	 *  Empty-string values are retained — legacy callers rely on that.
	 *  Values containing newlines are emitted as a YAML folded scalar (`key: |`) so
	 *  multi-line fields like `refs:` round-trip correctly. */
	private rebuildWithFrontmatter(content: string, fm: Record<string, string>): string {
		const fmLines = ['---'];
		for (const [key, value] of Object.entries(fm)) {
			if (value.includes('\n')) {
				fmLines.push(`${key}: |`);
				for (const bodyLine of value.split('\n')) {
					fmLines.push(`  ${bodyLine}`);
				}
			} else {
				fmLines.push(`${key}: ${value}`);
			}
		}
		fmLines.push('---');
		const newFm = fmLines.join('\n');
		const body = content.replace(FRONTMATTER_REGEX, '').trimStart();
		return newFm + '\n' + body;
	}

	/** Set the status (Kanban column) of a topic, stamping flow timestamps atomically:
	 *  - statusSince = today on every move (aging-WIP clock)
	 *  - startedAt = today the first time it enters in-progress (never overwritten)
	 *  - doneAt = today on entering done; cleared if the topic is reopened out of done */
	async setTopicStatus(filePath: string, status: TopicStatus): Promise<void> {
		const file = this.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return;
		const today = new Date().toISOString().slice(0, 10);
		await this.vault.process(file, content => {
			const fm = parseFrontmatter(content);
			const updates: Partial<Record<string, string | number | boolean | null>> = {
				status,
				statusSince: today,
			};
			if (status === 'in-progress' && !fm['startedAt']) updates.startedAt = today;
			if (status === 'done') updates.doneAt = today;
			else if (fm['doneAt']) updates.doneAt = null;
			this.applyFrontmatterUpdates(fm, updates);
			return this.rebuildWithFrontmatter(content, fm);
		});
	}

	/** Set the blocked flag on a topic */
	async setTopicBlocked(filePath: string, blocked: boolean): Promise<void> {
		await this.updateTopicFrontmatter(filePath, { blocked });
	}

	/** Add `blockerPath` to a topic's blockedBy list (this topic becomes blocked-by it).
	 *  Rejects self-links, unknown blockers, and cycles. Atomic via vault.process. */
	async addDependency(filePath: string, blockerPath: string): Promise<{ ok: boolean; reason?: string }> {
		if (filePath === blockerPath) return { ok: false, reason: 'A topic cannot block itself.' };
		const all = await this.getAllTopics();
		if (!all.some(t => t.filePath === blockerPath)) {
			return { ok: false, reason: 'Blocker topic not found.' };
		}
		if (this.wouldCycle(all, filePath, blockerPath)) {
			return { ok: false, reason: 'That would create a circular dependency.' };
		}
		const file = this.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return { ok: false, reason: 'Topic file not found.' };
		await this.vault.process(file, content => {
			const fm = parseFrontmatter(content);
			const existing = (fm['blockedBy'] || '').split('\n').map(s => s.trim()).filter(Boolean);
			if (!existing.includes(blockerPath)) existing.push(blockerPath);
			this.applyFrontmatterUpdates(fm, { blockedBy: existing.length > 0 ? existing.join('\n') : null });
			return this.rebuildWithFrontmatter(content, fm);
		});
		return { ok: true };
	}

	/** Remove `blockerPath` from a topic's blockedBy list. Atomic. */
	async removeDependency(filePath: string, blockerPath: string): Promise<void> {
		const file = this.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return;
		await this.vault.process(file, content => {
			const fm = parseFrontmatter(content);
			const next = (fm['blockedBy'] || '')
				.split('\n').map(s => s.trim()).filter(Boolean)
				.filter(p => p !== blockerPath);
			this.applyFrontmatterUpdates(fm, { blockedBy: next.length > 0 ? next.join('\n') : null });
			return this.rebuildWithFrontmatter(content, fm);
		});
	}

	/** True if making `filePath` blocked-by `blockerPath` would close a cycle — i.e. the
	 *  blocker is already (transitively) blocked by `filePath`. DFS over blockedBy edges. */
	private wouldCycle(all: SprintTopic[], filePath: string, blockerPath: string): boolean {
		const byPath = new Map(all.map(t => [t.filePath, t]));
		const seen = new Set<string>();
		const stack = [blockerPath];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			if (cur === filePath) return true;
			if (seen.has(cur)) continue;
			seen.add(cur);
			const t = byPath.get(cur);
			if (t) for (const dep of t.blockedBy) stack.push(dep);
		}
		return false;
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

	/** One-time migration from the sprint model to Kanban. For each topic file: if it has
	 *  no `sprint` and isn't already in-progress/done, move it to the Backlog column; then
	 *  strip the now-dead `sprint:` / `sprintHistory:` keys. Idempotent — files with nothing
	 *  to change are left untouched. Returns the number of files actually rewritten. */
	async migrateToKanban(): Promise<number> {
		const folder = this.vault.getAbstractFileByPath(this.getTopicsFolderPath());
		if (!(folder instanceof TFolder)) return 0;

		let changed = 0;
		for (const child of folder.children) {
			if (!(child instanceof TFile) || child.extension !== 'md') continue;
			let didChange = false;
			await this.vault.process(child, content => {
				const fm = parseFrontmatter(content);
				const hadSprintKeys = 'sprint' in fm || 'sprintHistory' in fm;
				const hasSprint = !!(fm['sprint'] && fm['sprint'].trim());
				const status = (fm['status'] || '').toLowerCase();

				const updates: Partial<Record<string, string | number | boolean | null>> = {
					sprint: null,
					sprintHistory: null,
				};
				if (!hasSprint && status !== 'done' && status !== 'in-progress') {
					updates.status = 'backlog';
				}

				const needsStatus = updates.status !== undefined;
				if (!hadSprintKeys && !needsStatus) return content; // nothing to do

				didChange = true;
				this.applyFrontmatterUpdates(fm, updates);
				return this.rebuildWithFrontmatter(content, fm);
			});
			if (didChange) changed++;
		}
		return changed;
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
