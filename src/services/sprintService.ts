import { Sprint, PluginData } from '../types';
import { addWorkDays } from '../utils/workDayUtils';

export class SprintService {
    constructor(
        private getData: () => PluginData,
        private saveData: () => Promise<void>
    ) {}

    getSprints(): Sprint[] {
        return this.getData().sprints;
    }

    getActiveSprint(): Sprint | null {
        return this.getData().sprints.find(s => s.status === 'active') ?? null;
    }

    getCompletedSprints(): Sprint[] {
        return this.getData().sprints
            .filter(s => s.status === 'completed')
            .sort((a, b) => b.endDate.localeCompare(a.endDate));
    }

    async createSprint(name: string, startDate?: string, endDate?: string): Promise<Sprint> {
        const data = this.getData();
        const start = startDate ?? this.formatDate(this.addDays(new Date(), 1));
        const end = endDate ?? (
            data.settings.sprintWorkDaysOnly
                ? this.formatDate(addWorkDays(this.parseDate(start), data.settings.defaultSprintLength))
                : this.formatDate(this.addDays(this.parseDate(start), data.settings.defaultSprintLength))
        );

        const today = this.formatDate(new Date());
        const status: Sprint['status'] = start <= today ? 'active' : 'planned';

        const sprint: Sprint = {
            id: `sprint-${Date.now()}`,
            name,
            startDate: start,
            endDate: end,
            status,
        };

        data.sprints.push(sprint);
        await this.saveData();
        return sprint;
    }

    async completeSprint(sprintId: string): Promise<Sprint | null> {
        const data = this.getData();
        const sprint = data.sprints.find(s => s.id === sprintId);
        if (!sprint) {
            throw new Error(`Sprint not found: ${sprintId}`);
        }

        sprint.status = 'completed';

        let newSprint: Sprint | null = null;
        if (data.settings.autoStartNextSprint) {
            const nextStart = this.formatDate(this.addDays(this.parseDate(sprint.endDate), 1));
            const nextEnd = data.settings.sprintWorkDaysOnly
                ? this.formatDate(addWorkDays(this.parseDate(nextStart), data.settings.defaultSprintLength))
                : this.formatDate(this.addDays(this.parseDate(nextStart), data.settings.defaultSprintLength));
            newSprint = {
                id: `sprint-${Date.now()}`,
                name: `Sprint`,
                startDate: nextStart,
                endDate: nextEnd,
                status: nextStart <= this.formatDate(new Date()) ? 'active' : 'planned',
            };
            data.sprints.push(newSprint);
        }

        await this.saveData();
        return newSprint;
    }

    async updateSprint(sprintId: string, updates: Partial<Pick<Sprint, 'name' | 'startDate' | 'endDate'>>): Promise<void> {
        const sprint = this.getData().sprints.find(s => s.id === sprintId);
        if (!sprint) {
            throw new Error(`Sprint not found: ${sprintId}`);
        }

        Object.assign(sprint, updates);
        await this.saveData();
    }

    async deleteSprint(sprintId: string): Promise<void> {
        const data = this.getData();
        const index = data.sprints.findIndex(s => s.id === sprintId);
        if (index === -1) {
            throw new Error(`Sprint not found: ${sprintId}`);
        }

        data.sprints.splice(index, 1);
        await this.saveData();
    }

    isDateInSprint(date: Date, sprint: Sprint): boolean {
        const d = this.formatDate(date);
        return d >= sprint.startDate && d <= sprint.endDate;
    }

    private formatDate(date: Date): string {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    private parseDate(dateStr: string): Date {
        const [y, m, d] = dateStr.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    private addDays(date: Date, days: number): Date {
        const result = new Date(date);
        result.setDate(result.getDate() + days);
        return result;
    }
}
