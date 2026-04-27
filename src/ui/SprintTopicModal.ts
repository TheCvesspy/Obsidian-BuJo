import { App, Modal, Setting, FuzzySuggestModal, TFile } from 'obsidian';
import { SprintTopic, Priority, TopicImpact, TopicEffort, PluginSettings, TeamMember } from '../types';
import { SprintTopicService } from '../services/sprintTopicService';
import { SprintService } from '../services/sprintService';
import { serializeRefs } from '../parser/topicParser';

/** Fuzzy file picker that returns the selected page name */
class PageSuggestModal extends FuzzySuggestModal<TFile> {
	private onChoose: (file: TFile) => void;

	constructor(app: App, onChoose: (file: TFile) => void) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder('Type to search vault pages...');
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(item: TFile): string {
		return item.path.replace(/\.md$/, '');
	}

	onChooseItem(item: TFile): void {
		this.onChoose(item);
	}
}

export class SprintTopicModal extends Modal {
	private title: string = '';
	private jira: string = '';
	private priority: Priority = Priority.None;
	private linkedPages: string[] = [];
	private impact: TopicImpact | null = null;
	private effort: TopicEffort | null = null;
	private dueDate: string = '';
	/** '' = Backlog (no sprint assigned). Otherwise a sprint id. */
	private chosenSprintId: string = '';
	/** Empty string = unassigned. Otherwise a team member email. */
	private assignee: string = '';
	/** Empty string = not waiting. 'other:<text>' means free-text fallback; any other
	 *  non-empty value is a team member email. Normalized to the stored string on save. */
	private waitingOnMode: 'none' | 'member' | 'other' = 'none';
	private waitingOnMember: string = '';
	private waitingOnFreeText: string = '';
	private lastNudged: string = '';
	private refs: Array<{ label: string; url: string }> = [];
	private chipsContainer: HTMLElement | null = null;
	private refsContainer: HTMLElement | null = null;

	constructor(
		app: App,
		private topicService: SprintTopicService,
		private sprintId: string,
		private onSave: (topic: SprintTopic) => void,
		private editTopic?: SprintTopic,
		private sprintService?: SprintService,
		/** Optional pre-fill for create mode (ignored when editing). Used by the
		 *  JIRA Dashboard "Create topic from issue" action to seed title/jira/priority. */
		private prefill?: { title?: string; jira?: string; priority?: Priority },
		/** Plugin settings — used to populate the Assignee dropdown from `teamMembers`. */
		private settings?: PluginSettings,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('friday-topic-modal');

		if (this.editTopic) {
			this.title = this.editTopic.title;
			// Multiple JIRA keys are rendered back as a comma-separated string in the input
			this.jira = this.editTopic.jira.join(', ');
			this.priority = this.editTopic.priority;
			this.linkedPages = [...this.editTopic.linkedPages];
			this.impact = this.editTopic.impact;
			this.effort = this.editTopic.effort;
			this.dueDate = this.editTopic.dueDate ?? '';
			this.chosenSprintId = this.editTopic.sprintId ?? '';
			this.assignee = this.editTopic.assignee ?? '';
			this.lastNudged = this.editTopic.lastNudged ?? '';
			this.refs = this.editTopic.refs.map(r => ({ ...r }));
			// Seed waitingOn state: match against active team members to decide mode
			if (this.editTopic.waitingOn) {
				const members = this.settings?.teamMembers ?? [];
				const match = members.find(m => m.email === this.editTopic!.waitingOn);
				if (match) {
					this.waitingOnMode = 'member';
					this.waitingOnMember = this.editTopic.waitingOn;
				} else {
					this.waitingOnMode = 'other';
					this.waitingOnFreeText = this.editTopic.waitingOn;
				}
			}
		} else {
			// For new topics, default to the sprintId passed by the caller (may be '' for backlog).
			this.chosenSprintId = this.sprintId;
			// Apply optional prefill (JIRA Dashboard "Create topic from issue" flow).
			if (this.prefill) {
				if (this.prefill.title) this.title = this.prefill.title;
				if (this.prefill.jira) this.jira = this.prefill.jira;
				if (this.prefill.priority) this.priority = this.prefill.priority;
			}
		}

		contentEl.createEl('h2', {
			text: this.editTopic ? 'Edit Topic' : 'New Sprint Topic',
		});

		new Setting(contentEl)
			.setName('Title')
			.addText(text => {
				text.setPlaceholder('Topic title')
					.setValue(this.title)
					.onChange(value => { this.title = value; });
				text.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') this.save();
				});
				setTimeout(() => text.inputEl.focus(), 50);
			});

		new Setting(contentEl)
			.setName('JIRA Ticket(s)')
			.setDesc('Optional. One or more JIRA keys, comma-separated (e.g. PROJ-1, PROJ-2).')
			.addText(text => text
				.setPlaceholder('PROJ-123, PROJ-124')
				.setValue(this.jira)
				.onChange(value => { this.jira = value; })
			);

		// Sprint picker — lets users create backlog topics from any entry point,
		// and reassign existing topics between sprints (or back to backlog).
		if (this.sprintService) {
			const sprints = this.sprintService.getSprints();
			const options: Record<string, string> = { '': '(Backlog)' };
			for (const s of sprints) {
				const suffix = s.status === 'active' ? ' · active'
					: s.status === 'completed' ? ' · completed'
					: '';
				options[s.id] = `${s.name}${suffix}`;
			}
			new Setting(contentEl)
				.setName('Sprint')
				.setDesc('Assign to a sprint, or leave in Backlog')
				.addDropdown(dropdown => dropdown
					.addOptions(options)
					.setValue(this.chosenSprintId)
					.onChange(value => { this.chosenSprintId = value; })
				);

			// Sprint history — read-only list of sprints this topic has been part of.
			// Only shown in edit mode; new topics have no history yet.
			if (this.editTopic && this.editTopic.sprintHistory.length > 0) {
				const historySetting = new Setting(contentEl)
					.setName('Sprint history')
					.setDesc('All sprints this topic has been assigned to (in order)');
				const listEl = historySetting.settingEl.createDiv({ cls: 'friday-topic-sprint-history' });
				for (const sprintId of this.editTopic.sprintHistory) {
					const sprint = sprints.find(s => s.id === sprintId);
					const label = sprint
						? `${sprint.name} (${sprint.startDate} → ${sprint.endDate})`
						: `${sprintId} · deleted`;
					const chip = listEl.createDiv({ cls: 'friday-topic-sprint-history-chip' });
					chip.setText(label);
					if (sprintId === this.editTopic.sprintId) {
						chip.addClass('friday-topic-sprint-history-current');
					}
				}
			}
		}

		new Setting(contentEl)
			.setName('Priority')
			.addDropdown(dropdown => dropdown
				.addOptions({
					[Priority.None]: 'None',
					[Priority.Low]: 'Low',
					[Priority.Medium]: 'Medium',
					[Priority.High]: 'High',
				})
				.setValue(this.priority)
				.onChange(value => { this.priority = value as Priority; })
			);

		// Assignee dropdown — sourced from settings.teamMembers ("logged team").
		// Only rendered when at least one team member is configured OR the topic already
		// has an assignee, so the feature stays invisible to users not using team tracking.
		const teamMembers: TeamMember[] = this.settings?.teamMembers ?? [];
		const activeMembers: TeamMember[] = teamMembers.filter(m => m.active);
		if (activeMembers.length > 0 || this.assignee) {
			const options: Record<string, string> = { '': '— Unassigned —' };
			for (const m of activeMembers) {
				options[m.email] = m.nickname || m.fullName || m.email;
			}
			// If the current assignee isn't in the active list (inactive or removed),
			// inject a synthetic option so editing doesn't silently clear the value.
			if (this.assignee && !(this.assignee in options)) {
				const stale = teamMembers.find(m => m.email === this.assignee);
				const label = stale
					? `${stale.nickname || stale.fullName || stale.email} · inactive`
					: `${this.assignee} · removed`;
				options[this.assignee] = label;
			}
			new Setting(contentEl)
				.setName('Assignee')
				.setDesc('Team member who owns this topic (from configured team)')
				.addDropdown(dropdown => dropdown
					.addOptions(options)
					.setValue(this.assignee)
					.onChange(value => { this.assignee = value; })
				);
		}

		new Setting(contentEl)
			.setName('Impact')
			.setDesc('Strategic impact — drives Impact/Effort and Eisenhower matrices')
			.addDropdown(dropdown => dropdown
				.addOptions({
					'': 'None',
					'critical': 'Critical',
					'high': 'High',
					'medium': 'Medium',
					'low': 'Low',
				})
				.setValue(this.impact ?? '')
				.onChange(value => { this.impact = (value || null) as TopicImpact | null; })
			);

		new Setting(contentEl)
			.setName('Effort')
			.setDesc('Size estimate — drives Impact/Effort matrix quadrant')
			.addDropdown(dropdown => dropdown
				.addOptions({
					'': 'None',
					'xs': 'XS',
					's': 'S',
					'm': 'M',
					'l': 'L',
					'xl': 'XL',
				})
				.setValue(this.effort ?? '')
				.onChange(value => { this.effort = (value || null) as TopicEffort | null; })
			);

		new Setting(contentEl)
			.setName('Due date')
			.setDesc('Optional — drives Eisenhower urgency')
			.addText(text => {
				text.inputEl.type = 'date';
				text.setValue(this.dueDate);
				text.onChange(value => { this.dueDate = value; });
			});

		this.renderWaitingOnSetting(contentEl, activeMembers, teamMembers);

		// Linked Pages with autocomplete
		const linkedSetting = new Setting(contentEl)
			.setName('Linked Pages')
			.addButton(btn => btn
				.setButtonText('+ Add Page')
				.onClick(() => {
					new PageSuggestModal(this.app, (file) => {
						const pageName = file.path.replace(/\.md$/, '');
						if (!this.linkedPages.includes(pageName)) {
							this.linkedPages.push(pageName);
							this.renderChips();
						}
					}).open();
				})
			);

		this.chipsContainer = linkedSetting.settingEl.createDiv({ cls: 'friday-page-chips' });
		this.renderChips();

		// External references — Confluence, Figma, SAP, etc.
		this.renderRefsSection(contentEl);

		// Error display
		const errorEl = contentEl.createDiv({ cls: 'friday-modal-error' });

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Save')
				.setCta()
				.onClick(async () => {
					errorEl.empty();
					if (!this.title.trim()) {
						errorEl.setText('Title is required.');
						return;
					}
					await this.save();
				})
			);
	}

	/** Render the Waiting-on + Last nudged settings as a dynamic block that re-renders
	 *  its inner controls when the mode changes. */
	private renderWaitingOnSetting(
		contentEl: HTMLElement,
		activeMembers: TeamMember[],
		teamMembers: TeamMember[],
	): void {
		const wrapper = contentEl.createDiv({ cls: 'friday-topic-waiting-wrapper' });
		const renderInner = () => {
			wrapper.empty();

			// Mode dropdown — None / a team member / Other (free text)
			const options: Record<string, string> = { none: '— Not waiting —' };
			for (const m of activeMembers) {
				options[`member:${m.email}`] = m.nickname || m.fullName || m.email;
			}
			// Preserve an inactive/removed member selection across re-renders
			if (this.waitingOnMode === 'member' && this.waitingOnMember
				&& !activeMembers.some(m => m.email === this.waitingOnMember)) {
				const stale = teamMembers.find(m => m.email === this.waitingOnMember);
				const label = stale
					? `${stale.nickname || stale.fullName || stale.email} · inactive`
					: `${this.waitingOnMember} · removed`;
				options[`member:${this.waitingOnMember}`] = label;
			}
			options['other'] = '— Other (type below) —';

			const currentValue =
				this.waitingOnMode === 'none' ? 'none'
				: this.waitingOnMode === 'member' ? `member:${this.waitingOnMember}`
				: 'other';

			new Setting(wrapper)
				.setName('Waiting on')
				.setDesc('Who is blocking this topic — team member or external party')
				.addDropdown(dropdown => dropdown
					.addOptions(options)
					.setValue(currentValue)
					.onChange(value => {
						if (value === 'none') {
							this.waitingOnMode = 'none';
							this.waitingOnMember = '';
							this.waitingOnFreeText = '';
						} else if (value === 'other') {
							this.waitingOnMode = 'other';
							this.waitingOnMember = '';
						} else if (value.startsWith('member:')) {
							this.waitingOnMode = 'member';
							this.waitingOnMember = value.slice('member:'.length);
							this.waitingOnFreeText = '';
						}
						renderInner();
					})
				);

			if (this.waitingOnMode === 'other') {
				new Setting(wrapper)
					.setName('Waiting on (text)')
					.setDesc('External party — e.g. "Legal", "Vendor X", "Customer"')
					.addText(text => text
						.setPlaceholder('e.g. Legal')
						.setValue(this.waitingOnFreeText)
						.onChange(value => { this.waitingOnFreeText = value; })
					);
			}

			if (this.waitingOnMode !== 'none') {
				new Setting(wrapper)
					.setName('Last nudged')
					.setDesc('When you last followed up. Leave blank if never nudged.')
					.addText(text => {
						text.inputEl.type = 'date';
						text.setValue(this.lastNudged);
						text.onChange(value => { this.lastNudged = value; });
					});
			}
		};
		renderInner();
	}

	private async save(): Promise<void> {
		if (!this.title.trim()) return;

		const dueDateTrimmed = this.dueDate.trim();
		const dueDateValue = dueDateTrimmed && /^\d{4}-\d{2}-\d{2}$/.test(dueDateTrimmed) ? dueDateTrimmed : null;

		// Normalize waitingOn state to the stored string
		const waitingOnValue =
			this.waitingOnMode === 'member' ? (this.waitingOnMember || null)
			: this.waitingOnMode === 'other' ? (this.waitingOnFreeText.trim() || null)
			: null;
		const lastNudgedTrimmed = this.lastNudged.trim();
		const lastNudgedValue = waitingOnValue && lastNudgedTrimmed && /^\d{4}-\d{2}-\d{2}$/.test(lastNudgedTrimmed)
			? lastNudgedTrimmed
			: null;

		if (this.editTopic) {
			// Non-sprint fields go through updateTopicFrontmatter directly
			const fmUpdates: Record<string, string | null> = {
				jira: this.jira || '',
				priority: this.priority === Priority.None ? 'none' : this.priority,
				impact: this.impact,
				effort: this.effort,
				dueDate: dueDateValue,
				assignee: this.assignee || null,
				waitingOn: waitingOnValue,
				lastNudged: lastNudgedValue,
				refs: this.refs.length > 0 ? serializeRefs(this.refs) : null,
			};
			await this.topicService.updateTopicFrontmatter(this.editTopic.filePath, fmUpdates);

			// Sprint changes must route through assignTopicToSprint so sprintHistory
			// is updated atomically (captures both the old and new sprint).
			let newHistory = this.editTopic.sprintHistory;
			const sprintChanged = this.sprintService
				&& this.chosenSprintId !== (this.editTopic.sprintId ?? '');
			if (sprintChanged) {
				await this.topicService.assignTopicToSprint(this.editTopic.filePath, this.chosenSprintId);
				// Mirror the service's merge logic for the in-memory SprintTopic returned to callers
				const seen = new Set(newHistory);
				const merged = [...newHistory];
				for (const s of [this.editTopic.sprintId ?? '', this.chosenSprintId]) {
					if (s && !seen.has(s)) { merged.push(s); seen.add(s); }
				}
				newHistory = merged;
			}

			// Parse the jira input into a deduplicated array of issue keys.
			// The input accepts comma-separated (or whitespace-separated) keys; the regex
			// matches the parser's behavior so this is round-trip-safe.
			const JIRA_KEY_RE = /[A-Z][A-Z0-9]+-\d+/g;
			const jiraKeys: string[] = [];
			const seenKeys = new Set<string>();
			let jm: RegExpExecArray | null;
			while ((jm = JIRA_KEY_RE.exec(this.jira)) !== null) {
				if (!seenKeys.has(jm[0])) {
					seenKeys.add(jm[0]);
					jiraKeys.push(jm[0]);
				}
			}

			const updated: SprintTopic = {
				...this.editTopic,
				jira: jiraKeys,
				priority: this.priority,
				linkedPages: this.linkedPages,
				impact: this.impact,
				effort: this.effort,
				dueDate: dueDateValue,
				sprintId: this.sprintService ? (this.chosenSprintId || null) : this.editTopic.sprintId,
				sprintHistory: newHistory,
				assignee: this.assignee || null,
				waitingOn: waitingOnValue,
				lastNudged: lastNudgedValue,
				refs: this.refs.map(r => ({ ...r })),
			};
			this.onSave(updated);
		} else {
			const topic = await this.topicService.createTopic(
				this.title.trim(),
				this.jira.trim() || null,
				this.priority,
				this.linkedPages,
				this.chosenSprintId,
				this.impact,
				this.effort,
				dueDateValue,
				this.assignee || null,
				waitingOnValue,
				lastNudgedValue,
				this.refs,
			);
			this.onSave(topic);
		}
		this.close();
	}

	private renderChips(): void {
		if (!this.chipsContainer) return;
		this.chipsContainer.empty();

		if (this.linkedPages.length === 0) {
			this.chipsContainer.createSpan({
				cls: 'friday-page-chips-empty',
				text: 'No pages linked yet',
			});
			return;
		}

		for (const page of this.linkedPages) {
			const chip = this.chipsContainer.createDiv({ cls: 'friday-page-chip' });
			chip.createSpan({ text: page });
			const removeBtn = chip.createSpan({ cls: 'friday-page-chip-remove', text: '\u00D7' });
			removeBtn.addEventListener('click', () => {
				this.linkedPages = this.linkedPages.filter(p => p !== page);
				this.renderChips();
			});
		}
	}

	/** References section: label+URL chip list + an add form. */
	private renderRefsSection(contentEl: HTMLElement): void {
		const setting = new Setting(contentEl)
			.setName('References')
			.setDesc('External links (Confluence, Figma, SAP, Miro, …). label · host');

		this.refsContainer = setting.settingEl.createDiv({ cls: 'friday-refs-chips' });

		// Inline add-form (label + url + add button)
		const addForm = setting.settingEl.createDiv({ cls: 'friday-refs-add-form' });
		const labelInput = addForm.createEl('input', { type: 'text', placeholder: 'Label (e.g. Confluence)' });
		labelInput.addClass('friday-refs-label-input');
		const urlInput = addForm.createEl('input', { type: 'url', placeholder: 'https://…' });
		urlInput.addClass('friday-refs-url-input');
		// Auto-fill label from URL hostname on blur when label is empty
		urlInput.addEventListener('blur', () => {
			if (!labelInput.value.trim() && urlInput.value.trim()) {
				try {
					const host = new URL(urlInput.value).hostname.replace(/^www\./, '');
					labelInput.value = host;
				} catch { /* invalid URL — ignore */ }
			}
		});
		const addBtn = addForm.createEl('button', { text: '+ Add' });
		addBtn.addClass('friday-refs-add-btn');
		const tryAdd = () => {
			const label = labelInput.value.trim();
			const url = urlInput.value.trim();
			if (!label || !url) return;
			if (!/^https?:\/\//.test(url)) return;
			this.refs.push({ label, url });
			labelInput.value = '';
			urlInput.value = '';
			this.renderRefsChips();
			labelInput.focus();
		};
		addBtn.addEventListener('click', (e) => { e.preventDefault(); tryAdd(); });
		urlInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); tryAdd(); }
		});

		this.renderRefsChips();
	}

	private renderRefsChips(): void {
		if (!this.refsContainer) return;
		this.refsContainer.empty();

		if (this.refs.length === 0) {
			this.refsContainer.createSpan({
				cls: 'friday-page-chips-empty',
				text: 'No references yet',
			});
			return;
		}

		for (const ref of this.refs) {
			const chip = this.refsContainer.createDiv({ cls: 'friday-refs-chip' });
			let host = '';
			try { host = new URL(ref.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
			const text = host ? `${ref.label} · ${host}` : ref.label;
			chip.createSpan({ text });
			chip.setAttribute('title', ref.url);
			const removeBtn = chip.createSpan({ cls: 'friday-page-chip-remove', text: '\u00D7' });
			removeBtn.addEventListener('click', () => {
				this.refs = this.refs.filter(r => r !== ref);
				this.renderRefsChips();
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
