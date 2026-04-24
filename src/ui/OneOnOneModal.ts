import { App, FuzzySuggestModal } from 'obsidian';
import { TeamMemberPage } from '../types';

/** Fuzzy picker for "Start a 1:1 with…". Surfaces only visible (non-departed) members;
 *  sorted with overdue-cadence members first so the most likely pick is at the top. */
export class OneOnOneModal extends FuzzySuggestModal<TeamMemberPage> {
	constructor(
		app: App,
		private members: TeamMemberPage[],
		private onSelect: (member: TeamMemberPage) => void,
	) {
		super(app);
		this.setPlaceholder('Pick a teammate for 1:1…');
		this.setInstructions([
			{ command: '↑↓', purpose: 'navigate' },
			{ command: '⏎', purpose: 'start 1:1' },
			{ command: 'esc', purpose: 'cancel' },
		]);
	}

	getItems(): TeamMemberPage[] {
		return this.members;
	}

	getItemText(member: TeamMemberPage): string {
		// Include role so fuzzy search matches either the name or the role.
		return member.role ? `${member.name} — ${member.role}` : member.name;
	}

	onChooseItem(member: TeamMemberPage): void {
		this.onSelect(member);
	}
}
