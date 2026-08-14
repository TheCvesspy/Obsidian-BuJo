import { App, Vault, TFile, TFolder } from 'obsidian';
import { SprintTopic, TopicStatus, Priority, PluginSettings, TopicImpact, TopicEffort } from '../types';
import { parseTopicFile, parseFrontmatterForRewrite, serializeFrontmatter, serializeRefs, foldedScalar, orderTopicFrontmatterEntries } from '../parser/topicParser';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;

export class SprintTopicService {
	constructor(
		private vault: Vault,
		private getSettings: () => PluginSettings,
		/** Needed for fileManager.renameFile (updates wiki-links vault-wide on rename).
		 *  Optional so headless callers can construct the service without an App. */
		private app?: App,
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
		startDate: string | null = null,
		notesBody: string | null = null,
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
		// Keys are listed in TOPIC_FRONTMATTER_ORDER so new topics are written canonically.
		const frontmatter = serializeFrontmatter({
			status: 'backlog',
			priority: priority === Priority.None ? 'none' : priority,
			jira: jira || null,
			assignee,
			waitingOn,
			lastNudged,
			startDate,
			dueDate,
			impact,
			effort,
			blocked: false,
			sortOrder: 999,
			statusSince: today,
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
		//   startDate: YYYY-MM-DD                    (planned roadmap start — estimated; bar end = dueDate)
		//   statusSince / startedAt / doneAt: YYYY-MM-DD (Kanban flow timestamps)
		//   jira: <ticket>
		const notesSection = notesBody && notesBody.trim() ? `${notesBody.trim()}\n` : '';
		const content = `${frontmatter}\n# ${title}\n\n## Linked Pages\n${linkedSection}\n\n## Tasks\n\n## Notes\n${notesSection}`;

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
			const { fields: fm, passthrough } = parseFrontmatterForRewrite(content);
			this.applyFrontmatterUpdates(fm, updates);
			return this.rebuildWithFrontmatter(content, fm, passthrough);
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
	 *  multi-line fields like `refs:` round-trip correctly.
	 *  `passthrough` blocks (frontmatter entries the plugin doesn't manage — tags,
	 *  aliases, YAML lists, user keys) are re-emitted verbatim after the managed keys. */
	private rebuildWithFrontmatter(content: string, fm: Record<string, string>, passthrough: string[] = []): string {
		const fmLines = ['---'];
		// Emit in the canonical key order so edits normalize a topic's frontmatter layout.
		for (const [key, value] of orderTopicFrontmatterEntries(Object.entries(fm))) {
			if (value.includes('\n')) {
				fmLines.push(`${key}: |`);
				for (const bodyLine of value.split('\n')) {
					fmLines.push(`  ${bodyLine}`);
				}
			} else {
				fmLines.push(`${key}: ${value}`);
			}
		}
		for (const block of passthrough) {
			fmLines.push(block);
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
			const { fields: fm, passthrough } = parseFrontmatterForRewrite(content);
			const updates: Partial<Record<string, string | number | boolean | null>> = {
				status,
				statusSince: today,
			};
			if (status === 'in-progress' && !fm['startedAt']) updates.startedAt = today;
			if (status === 'done') updates.doneAt = today;
			else if (fm['doneAt']) updates.doneAt = null;
			this.applyFrontmatterUpdates(fm, updates);
			return this.rebuildWithFrontmatter(content, fm, passthrough);
		});
	}

	/** Set the blocked flag on a topic */
	async setTopicBlocked(filePath: string, blocked: boolean): Promise<void> {
		await this.updateTopicFrontmatter(filePath, { blocked });
	}

	/** Replace the wiki-link bullets in a topic's `## Linked Pages` section with `pages`.
	 *  Non-bullet lines in the section (user notes) are kept, after the new bullets.
	 *  If the section is missing it is appended at the end of the file. */
	async updateLinkedPagesSection(filePath: string, pages: string[]): Promise<void> {
		const file = this.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return;

		await this.vault.process(file, content => {
			const bullets = pages.map(p => `- [[${p}]]`);
			const lines = content.split('\n');
			const start = lines.findIndex(l => /^##\s+Linked Pages\s*$/i.test(l));
			if (start === -1) {
				if (bullets.length === 0) return content;
				return content.trimEnd() + '\n\n## Linked Pages\n' + bullets.join('\n') + '\n';
			}
			let end = start + 1;
			while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
			const kept = lines.slice(start + 1, end).filter(l => {
				const t = l.trim();
				return t.length > 0 && !/^-\s*\[\[[^\]]+\]\]\s*$/.test(t);
			});
			const section = [lines[start], ...bullets, ...kept];
			if (end < lines.length) section.push('');
			return [...lines.slice(0, start), ...section, ...lines.slice(end)].join('\n');
		});
	}

	/** Prepend one or more task/continuation lines to the top of a topic's `## Tasks`
	 *  section (before any existing tasks, after the heading), so the newest task
	 *  surfaces first and the topic parser counts it in taskTotal/taskDone. The section
	 *  is created at end-of-file if missing. Returns false when the topic file cannot
	 *  be found. */
	async appendTasksToTopic(filePath: string, lines: string[]): Promise<boolean> {
		if (lines.length === 0) return false;
		const file = this.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return false;

		await this.vault.process(file, content => {
			const contentLines = content.split('\n');
			const start = contentLines.findIndex(l => /^##\s+Tasks\s*$/i.test(l));
			if (start === -1) {
				return content.trimEnd() + '\n\n## Tasks\n\n' + lines.join('\n') + '\n';
			}
			// Insert at the top of the section: just after the heading, preserving one
			// conventional blank line between the heading and the task list if present.
			let insertAt = start + 1;
			if (insertAt < contentLines.length && contentLines[insertAt].trim() === '') insertAt++;
			// Keep a blank line before a following `##` heading (e.g. when the section
			// was previously empty) so sections stay visually separated.
			const tail = contentLines.slice(insertAt);
			const needsGap = tail.length > 0 && /^##\s+/.test(tail[0]);
			return [
				...contentLines.slice(0, insertAt),
				...lines,
				...(needsGap ? [''] : []),
				...tail,
			].join('\n');
		});
		return true;
	}

	/** Rename a topic: rewrites the body H1 and renames the file. Uses
	 *  fileManager.renameFile when available so wiki-links across the vault update.
	 *  Returns the new file path (unchanged when the sanitized name is identical).
	 *  Throws when the title sanitizes to nothing or the target already exists. */
	async renameTopic(filePath: string, newTitle: string): Promise<string> {
		const file = this.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) throw new Error('Topic file not found.');

		const newPath = this.getTopicFilePath(newTitle);
		const newBasename = newPath.split('/').pop()!.replace(/\.md$/, '');
		if (!newBasename) throw new Error('Title contains no characters usable in a filename.');
		if (newPath !== filePath && this.vault.getAbstractFileByPath(newPath)) {
			throw new Error(`A topic named "${newBasename}" already exists.`);
		}

		// Rewrite the first body H1 (skipping frontmatter, where a `# comment` could lurk)
		await this.vault.process(file, content => {
			const m = content.match(FRONTMATTER_REGEX);
			const bodyStart = m ? m[0].length : 0;
			const body = content.slice(bodyStart);
			if (!/^#\s+.*$/m.test(body)) return content; // no H1 — filename rename is enough
			return content.slice(0, bodyStart) + body.replace(/^#\s+.*$/m, `# ${newTitle}`);
		});

		if (newPath === filePath) return filePath;
		if (this.app) {
			await this.app.fileManager.renameFile(file, newPath);
		} else {
			await this.vault.rename(file, newPath);
		}
		return newPath;
	}

	/** After a topic file was renamed (via the edit modal or manually in the file
	 *  explorer), rewrite `blockedBy` entries in every other topic that referenced
	 *  the old path — dependency edges must not silently break. */
	async handleTopicRename(oldPath: string, newPath: string): Promise<void> {
		const folder = this.vault.getAbstractFileByPath(this.getTopicsFolderPath());
		if (!(folder instanceof TFolder)) return;

		for (const child of folder.children) {
			if (!(child instanceof TFile) || child.extension !== 'md') continue;
			// Cheap pre-check so untouched topics aren't rewritten at all
			const snapshot = await this.vault.cachedRead(child);
			if (!snapshot.includes(oldPath)) continue;

			await this.vault.process(child, content => {
				const { fields: fm, passthrough } = parseFrontmatterForRewrite(content);
				const deps = (fm['blockedBy'] || '').split('\n').map(s => s.trim()).filter(Boolean);
				if (!deps.includes(oldPath)) return content;
				const next = deps.map(p => (p === oldPath ? newPath : p));
				this.applyFrontmatterUpdates(fm, { blockedBy: next.join('\n') });
				return this.rebuildWithFrontmatter(content, fm, passthrough);
			});
		}
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
			const { fields: fm, passthrough } = parseFrontmatterForRewrite(content);
			const existing = (fm['blockedBy'] || '').split('\n').map(s => s.trim()).filter(Boolean);
			if (!existing.includes(blockerPath)) existing.push(blockerPath);
			this.applyFrontmatterUpdates(fm, { blockedBy: existing.length > 0 ? existing.join('\n') : null });
			return this.rebuildWithFrontmatter(content, fm, passthrough);
		});
		return { ok: true };
	}

	/** Remove `blockerPath` from a topic's blockedBy list. Atomic. */
	async removeDependency(filePath: string, blockerPath: string): Promise<void> {
		const file = this.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return;
		await this.vault.process(file, content => {
			const { fields: fm, passthrough } = parseFrontmatterForRewrite(content);
			const next = (fm['blockedBy'] || '')
				.split('\n').map(s => s.trim()).filter(Boolean)
				.filter(p => p !== blockerPath);
			this.applyFrontmatterUpdates(fm, { blockedBy: next.length > 0 ? next.join('\n') : null });
			return this.rebuildWithFrontmatter(content, fm, passthrough);
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

	/** Set the planned roadmap start date on a topic (null clears the field) */
	async setTopicStartDate(filePath: string, startDate: string | null): Promise<void> {
		await this.updateTopicFrontmatter(filePath, { startDate });
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
				const { fields: fm, passthrough } = parseFrontmatterForRewrite(content);
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
				return this.rebuildWithFrontmatter(content, fm, passthrough);
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
