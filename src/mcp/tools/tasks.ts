import { TaskItem, TaskStatus, ItemCategory, Priority, PluginSettings } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { TaskWriter } from '../../services/taskWriter';
import { DailyNoteService } from '../../services/dailyNoteService';
import { parseDueDate } from '../../parser/dateParser';
import { formatDateISO } from '../../utils/dateUtils';
import {
	McpTool,
	McpToolResult,
	jsonResult,
	errorResult,
	ToolError,
	requireString,
	optionalString,
	optionalEnum,
} from '../tool';

interface TasksDeps {
	store: TaskStore;
	writer: TaskWriter;
	dailyNoteService: DailyNoteService;
	getSettings: () => PluginSettings;
}

const FILTERS = ['today', 'overdue', 'unscheduled', 'week', 'all'] as const;
const STATUS_NAMES = ['open', 'done', 'cancelled', 'migrated', 'scheduled'] as const;
const PRIORITY_NAMES = ['high', 'medium', 'low', 'none'] as const;
const KIND_NAMES = ['task', 'inbox'] as const;

type FilterName = typeof FILTERS[number];
type StatusName = typeof STATUS_NAMES[number];

/** Build all task-related MCP tools. */
export function taskTools(deps: TasksDeps): McpTool[] {
	return [
		listTool(deps),
		searchTool(deps),
		setStatusTool(deps),
		setDueDateTool(deps),
		addToDailyTool(deps),
	];
}

// ─── tasks_list ────────────────────────────────────────────────────────────

function listTool(deps: TasksDeps): McpTool {
	return {
		name: 'tasks_list',
		description:
			'List tasks filtered by date bucket. Use filter="today" for tasks due today, ' +
			'"overdue" for open root tasks with due dates in the past, "unscheduled" for ' +
			'open tasks without a due date, "week" for the current calendar week, or "all" ' +
			'for every task in the vault. Optional `page` substring-matches the source file path. ' +
			'Optional `status` filters to a specific checkbox state. Returns task summaries with ' +
			'stable IDs you can pass to tasks_set_status / tasks_set_due_date — re-list if you ' +
			'pause for a long time between calls, since IDs are derived from file+line and can ' +
			'shift if the source is edited.',
		inputSchema: {
			type: 'object',
			properties: {
				filter: {
					type: 'string',
					enum: [...FILTERS],
					description: 'Date-bucket filter. Defaults to "all".',
				},
				page: {
					type: 'string',
					description: 'Case-insensitive substring filter on the source file path.',
				},
				status: {
					type: 'string',
					enum: [...STATUS_NAMES],
					description: 'Filter to a specific checkbox status.',
				},
				limit: {
					type: 'number',
					description: 'Cap the number of returned tasks. Default 100.',
				},
			},
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			try {
				const filter = (optionalEnum(args, 'filter', FILTERS) ?? 'all') as FilterName;
				const page = optionalString(args, 'page');
				const status = optionalEnum(args, 'status', STATUS_NAMES);
				const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 100;

				let tasks = filterByBucket(deps, filter);
				if (page) {
					const needle = page.toLowerCase();
					tasks = tasks.filter(t => t.sourcePath.toLowerCase().includes(needle));
				}
				if (status) {
					const target = statusFromName(status);
					tasks = tasks.filter(t => t.status === target);
				}

				const truncated = tasks.length > limit;
				const window = tasks.slice(0, limit);
				return jsonResult({
					filter,
					total: tasks.length,
					returned: window.length,
					truncated,
					tasks: window.map(toDto),
				});
			} catch (err) {
				if (err instanceof ToolError) return errorResult(err.message);
				throw err;
			}
		},
	};
}

// ─── tasks_search ──────────────────────────────────────────────────────────

function searchTool(deps: TasksDeps): McpTool {
	return {
		name: 'tasks_search',
		description:
			'Substring-search across all tasks in the vault. Matches against task text and source ' +
			'file path (case-insensitive). Returns the same task summaries as tasks_list.',
		inputSchema: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					description: 'Substring to look for. Required.',
				},
				limit: {
					type: 'number',
					description: 'Cap on results. Default 50.',
				},
			},
			required: ['query'],
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			try {
				const query = requireString(args, 'query').toLowerCase();
				const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 50;
				const all = deps.store.getTasks();
				const matches = all.filter(t =>
					t.text.toLowerCase().includes(query) ||
					t.sourcePath.toLowerCase().includes(query),
				);
				const truncated = matches.length > limit;
				return jsonResult({
					query,
					total: matches.length,
					returned: Math.min(limit, matches.length),
					truncated,
					tasks: matches.slice(0, limit).map(toDto),
				});
			} catch (err) {
				if (err instanceof ToolError) return errorResult(err.message);
				throw err;
			}
		},
	};
}

// ─── tasks_set_status ──────────────────────────────────────────────────────

function setStatusTool(deps: TasksDeps): McpTool {
	return {
		name: 'tasks_set_status',
		description:
			'Update the checkbox status of a task in its source file. Pass the `taskId` from ' +
			'tasks_list or tasks_search. Status values map to Markdown checkbox chars: ' +
			'open=[ ], done=[x], cancelled=[-], migrated=[>], scheduled=[<].',
		inputSchema: {
			type: 'object',
			properties: {
				taskId: { type: 'string', description: 'ID from tasks_list / tasks_search.' },
				status: { type: 'string', enum: [...STATUS_NAMES] },
			},
			required: ['taskId', 'status'],
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			try {
				const taskId = requireString(args, 'taskId');
				const statusName = requireString(args, 'status') as StatusName;
				if (!STATUS_NAMES.includes(statusName)) {
					return errorResult(`Invalid status "${statusName}". Must be one of: ${STATUS_NAMES.join(', ')}.`);
				}
				const task = deps.store.getTaskById(taskId);
				if (!task) {
					return errorResult(`No task found with ID "${taskId}". Re-run tasks_list to refresh IDs.`);
				}
				const newStatus = statusFromName(statusName);
				const updated = await deps.writer.setStatus(task, newStatus);
				if (!updated) {
					return errorResult(
						`Could not locate task in ${task.sourcePath}:${task.lineNumber}. The file may have ` +
						'been edited since the task was indexed. Re-run tasks_list and try again.',
					);
				}
				return jsonResult({
					ok: true,
					taskId,
					status: statusName,
					sourcePath: task.sourcePath,
					lineNumber: task.lineNumber,
				});
			} catch (err) {
				if (err instanceof ToolError) return errorResult(err.message);
				throw err;
			}
		},
	};
}

// ─── tasks_set_due_date ────────────────────────────────────────────────────

function setDueDateTool(deps: TasksDeps): McpTool {
	return {
		name: 'tasks_set_due_date',
		description:
			'Set or replace the @due tag on a task. `dueDate` accepts natural-language forms ' +
			'("today", "tomorrow", "next friday", "in 3 days", "end of week", "end of month") or ' +
			'numeric DD-MM / DD-MM-YYYY — the same formats accepted in the UI. The raw string is ' +
			'preserved in the file; pass it verbatim. To remove a due date, edit the file by hand ' +
			'(the writer does not currently support clearing).',
		inputSchema: {
			type: 'object',
			properties: {
				taskId: { type: 'string', description: 'ID from tasks_list / tasks_search.' },
				dueDate: {
					type: 'string',
					description:
						'Natural-language date or DD-MM / DD-MM-YYYY. Validated against the same ' +
						'parser the UI uses.',
				},
			},
			required: ['taskId', 'dueDate'],
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			try {
				const taskId = requireString(args, 'taskId');
				const dueDateRaw = requireString(args, 'dueDate').trim();

				const parsed = parseDueDate(dueDateRaw);
				if (!parsed) {
					return errorResult(
						`Could not parse "${dueDateRaw}" as a date. Try "today", "tomorrow", ` +
						'"next friday", "in 3 days", "end of week", "DD-MM", or "DD-MM-YYYY".',
					);
				}

				const task = deps.store.getTaskById(taskId);
				if (!task) {
					return errorResult(`No task found with ID "${taskId}". Re-run tasks_list to refresh IDs.`);
				}
				const updated = await deps.writer.updateDueDate(task, dueDateRaw);
				if (!updated) {
					return errorResult(
						`Could not locate task in ${task.sourcePath}:${task.lineNumber}. The file may have ` +
						'been edited since the task was indexed. Re-run tasks_list and try again.',
					);
				}
				return jsonResult({
					ok: true,
					taskId,
					dueDateRaw,
					resolvedDate: formatDateISO(parsed),
					sourcePath: task.sourcePath,
				});
			} catch (err) {
				if (err instanceof ToolError) return errorResult(err.message);
				throw err;
			}
		},
	};
}

// ─── tasks_add_to_daily ────────────────────────────────────────────────────

function addToDailyTool(deps: TasksDeps): McpTool {
	return {
		name: 'tasks_add_to_daily',
		description:
			'Append a new task (or inbox item) to a daily note. Creates the daily note if it ' +
			'does not exist yet. `date` accepts "today" / "tomorrow" / "yesterday" or ISO ' +
			'YYYY-MM-DD (default: today). `kind` chooses the section: "task" writes under ' +
			'## Tasks, "inbox" writes under ## Inbox (default: task). Optional `priority`, ' +
			'`due`, and `source` annotate the task using the plugin\'s tag conventions.',
		inputSchema: {
			type: 'object',
			properties: {
				text: { type: 'string', description: 'Task text. Required.' },
				date: {
					type: 'string',
					description: '"today" (default) / "tomorrow" / "yesterday" / ISO YYYY-MM-DD.',
				},
				kind: { type: 'string', enum: [...KIND_NAMES], description: 'Section to write under. Default "task".' },
				priority: { type: 'string', enum: [...PRIORITY_NAMES] },
				due: { type: 'string', description: 'Natural-language date or DD-MM / DD-MM-YYYY.' },
				source: {
					type: 'string',
					description:
						'Optional wiki-link name to record as the task\'s origin (rendered as ' +
						'"(from [[name]])").',
				},
			},
			required: ['text'],
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			try {
				const text = requireString(args, 'text').trim();
				const dateInput = optionalString(args, 'date') ?? 'today';
				const date = resolveSimpleDate(dateInput);
				if (!date) {
					return errorResult(
						`Could not parse date "${dateInput}". Use "today", "tomorrow", "yesterday", ` +
						'or ISO YYYY-MM-DD.',
					);
				}

				const kind = (optionalEnum(args, 'kind', KIND_NAMES) ?? 'task') as 'task' | 'inbox';
				const priority = optionalEnum(args, 'priority', PRIORITY_NAMES);
				const due = optionalString(args, 'due');
				const source = optionalString(args, 'source');

				if (due) {
					const parsed = parseDueDate(due);
					if (!parsed) {
						return errorResult(`Could not parse "due" value "${due}".`);
					}
				}

				let line = `- [ ] ${text}`;
				if (priority && priority !== 'none') line += ` #priority/${priority}`;
				if (due) line += ` @due ${due}`;
				if (source) line += ` (from [[${source}]])`;

				if (kind === 'inbox') {
					await deps.dailyNoteService.addRawInboxLine(line, date);
				} else {
					await deps.dailyNoteService.addRawTaskLine(line, date);
				}

				return jsonResult({
					ok: true,
					dailyNote: deps.dailyNoteService.getDailyNotePath(date),
					date: formatDateISO(date),
					kind,
					line,
				});
			} catch (err) {
				if (err instanceof ToolError) return errorResult(err.message);
				throw err;
			}
		},
	};
}

// ─── helpers ────────────────────────────────────────────────────────────────

function filterByBucket(deps: TasksDeps, filter: FilterName): TaskItem[] {
	const store = deps.store;
	switch (filter) {
		case 'today':
			return store.getTasksForDate(new Date());
		case 'overdue':
			return store.getOverdueTasks();
		case 'unscheduled':
			return store.getUnscheduledTasks();
		case 'week': {
			const settings = deps.getSettings();
			const startDay = settings.weekStartDay ?? 1;
			const start = startOfWeek(new Date(), startDay);
			const end = new Date(start);
			end.setDate(end.getDate() + 6);
			end.setHours(23, 59, 59, 999);
			return store.getTasksForDateRange(start, end);
		}
		case 'all':
		default:
			return store.getTasks();
	}
}

function startOfWeek(date: Date, weekStartDay: number): Date {
	const d = new Date(date);
	const day = d.getDay();
	const diff = (day - weekStartDay + 7) % 7;
	d.setDate(d.getDate() - diff);
	d.setHours(0, 0, 0, 0);
	return d;
}

function statusFromName(name: StatusName): TaskStatus {
	switch (name) {
		case 'open': return TaskStatus.Open;
		case 'done': return TaskStatus.Done;
		case 'cancelled': return TaskStatus.Cancelled;
		case 'migrated': return TaskStatus.Migrated;
		case 'scheduled': return TaskStatus.Scheduled;
	}
}

function statusToName(s: TaskStatus): StatusName {
	switch (s) {
		case TaskStatus.Open: return 'open';
		case TaskStatus.Done: return 'done';
		case TaskStatus.Cancelled: return 'cancelled';
		case TaskStatus.Migrated: return 'migrated';
		case TaskStatus.Scheduled: return 'scheduled';
	}
}

function categoryToName(c: ItemCategory): string {
	switch (c) {
		case ItemCategory.Task: return 'task';
		case ItemCategory.OpenPoint: return 'openpoint';
		case ItemCategory.Inbox: return 'inbox';
		case ItemCategory.Uncategorized: return 'uncategorized';
	}
}

function priorityToName(p: Priority): string {
	switch (p) {
		case Priority.High: return 'high';
		case Priority.Medium: return 'medium';
		case Priority.Low: return 'low';
		case Priority.None: return 'none';
	}
}

function toDto(t: TaskItem): Record<string, unknown> {
	return {
		id: t.id,
		text: t.text,
		status: statusToName(t.status),
		category: categoryToName(t.category),
		priority: priorityToName(t.priority),
		dueDate: t.dueDate ? formatDateISO(t.dueDate) : null,
		dueDateRaw: t.dueDateRaw,
		sourcePath: t.sourcePath,
		sourceName: basenameNoExt(t.sourcePath),
		lineNumber: t.lineNumber,
		headingContext: t.headingContext,
		subHeading: t.subHeading,
		workType: t.workType,
		purpose: t.purpose,
		indentLevel: t.indentLevel,
		parentId: t.parentId,
		isRoot: t.parentId === null,
		migratedFrom: t.migratedFrom,
		migratedTo: t.migratedTo,
	};
}

function basenameNoExt(path: string): string {
	const base = path.split('/').pop() ?? path;
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.substring(0, dot) : base;
}

/** Resolve a coarse date string for the daily-note tools. Accepts keywords and ISO. */
function resolveSimpleDate(input: string): Date | null {
	const normalized = input.trim().toLowerCase();
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	if (normalized === 'today') return today;
	if (normalized === 'tomorrow') {
		const d = new Date(today);
		d.setDate(d.getDate() + 1);
		return d;
	}
	if (normalized === 'yesterday') {
		const d = new Date(today);
		d.setDate(d.getDate() - 1);
		return d;
	}
	const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (isoMatch) {
		const year = parseInt(isoMatch[1], 10);
		const month = parseInt(isoMatch[2], 10);
		const day = parseInt(isoMatch[3], 10);
		const d = new Date(year, month - 1, day);
		if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
			return null;
		}
		return d;
	}
	return null;
}
