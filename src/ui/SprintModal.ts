import { App, Modal, Setting } from 'obsidian';
import { Sprint, PluginSettings } from '../types';
import { SprintService } from '../services/sprintService';
import { totalWorkDays } from '../utils/workDayUtils';

export class SprintModal extends Modal {
    private name: string = '';
    private startDate: string = '';
    private endDate: string = '';
    private durationEl: HTMLParagraphElement;
    private errorEl: HTMLElement;

    constructor(
        app: App,
        private sprintService: SprintService,
        private settings: PluginSettings,
        private onSave: (sprint: Sprint) => void,
        private editSprint?: Sprint
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        this.modalEl.addClass('friday-sprint-modal');

        if (this.editSprint) {
            this.name = this.editSprint.name;
            this.startDate = this.editSprint.startDate;
            this.endDate = this.editSprint.endDate;
        }

        contentEl.createEl('h2', {
            text: this.editSprint ? 'Edit Sprint' : 'Create Sprint'
        });

        new Setting(contentEl)
            .setName('Sprint Name')
            .addText(text => {
                text.setValue(this.name)
                    .onChange(value => { this.name = value; });
                text.inputEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') this.save();
                });
                setTimeout(() => text.inputEl.focus(), 50);
            });

        new Setting(contentEl)
            .setName('Start Date')
            .addText(text => {
                text.inputEl.type = 'date';
                text.inputEl.value = this.startDate;
                text.onChange(value => {
                    this.startDate = value;
                    this.updateDuration();
                });
            });

        new Setting(contentEl)
            .setName('End Date')
            .addText(text => {
                text.inputEl.type = 'date';
                text.inputEl.value = this.endDate;
                text.onChange(value => {
                    this.endDate = value;
                    this.updateDuration();
                });
            });

        this.durationEl = contentEl.createEl('p');
        this.updateDuration();

        this.errorEl = contentEl.createDiv({ cls: 'friday-modal-error' });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Save')
                .setCta()
                .onClick(() => this.save())
            );
    }

    private async save(): Promise<void> {
        this.errorEl.empty();

        if (!this.name.trim()) {
            this.errorEl.setText('Sprint name is required.');
            return;
        }
        if (!this.startDate || !this.endDate) {
            this.errorEl.setText('Both start and end dates are required.');
            return;
        }
        if (this.startDate > this.endDate) {
            this.errorEl.setText('End date must be after start date.');
            return;
        }

        let sprint: Sprint;
        if (this.editSprint) {
            await this.sprintService.updateSprint(this.editSprint.id, {
                name: this.name,
                startDate: this.startDate,
                endDate: this.endDate
            });
            sprint = { ...this.editSprint, name: this.name, startDate: this.startDate, endDate: this.endDate };
        } else {
            sprint = await this.sprintService.createSprint(
                this.name,
                this.startDate,
                this.endDate
            );
        }

        this.onSave(sprint);
        this.close();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private updateDuration(): void {
        const start = Date.parse(this.startDate);
        const end = Date.parse(this.endDate);
        if (!isNaN(start) && !isNaN(end)) {
            const calendarDays = Math.round((end - start) / (1000 * 60 * 60 * 24));
            if (this.settings.sprintWorkDaysOnly) {
                const workDays = totalWorkDays(new Date(start), new Date(end));
                this.durationEl.setText(`Duration: ${workDays} work day${workDays !== 1 ? 's' : ''} (${calendarDays} calendar)`);
            } else {
                this.durationEl.setText(`Duration: ${calendarDays} day${calendarDays !== 1 ? 's' : ''}`);
            }
        } else {
            this.durationEl.setText('');
        }
    }
}
