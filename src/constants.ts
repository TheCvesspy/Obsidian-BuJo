export const VIEW_TYPE_FRIDAY = 'friday-view';
export const VIEW_TYPE_JIRA_DASHBOARD = 'friday-jira-dashboard';
export const VIEW_TYPE_TEAM_DASHBOARD = 'friday-team-dashboard';

/** Regex to match a checkbox line: - [ ] text, - [x] text, - [>] text, etc. */
export const CHECKBOX_REGEX = /^(\s*)-\s*\[([ x><!-])\]\s+(.*)$/i;

/** Regex to match a markdown heading */
export const HEADING_REGEX = /^(#{1,6})\s+(.+)$/;

/** Regex to match priority tags */
export const PRIORITY_TAG_REGEX = /#priority\/(high|medium|low)/i;

/** Regex to match item category inline tags */
export const TYPE_TAG_REGEX = /#type\/(task|openpoint)/i;

/** Regex to match @due dates: @due YYYY-MM-DD, @due DD-MM-YYYY, @due DD-MM, or @due <natural language> */
export const DUE_DATE_REGEX = /@due\s+([\w\d\s\/-]+?)(?=\s+[@#(]|$)/i;

/** Regex to match the @done completion stamp (ISO, plugin-managed). Powers age-based
 *  inbox cleanup and keeps a lightweight record of when a task was closed. */
export const DONE_DATE_REGEX = /@done\s+(\d{4}-\d{2}-\d{2})/i;

/** Regex to match @snooze/defer dates: same grammar as @due. While today < snooze,
 *  the task is suppressed from Today & Overdue, then wakes automatically. */
export const SNOOZE_DATE_REGEX = /@snooze\s+([\w\d\s\/-]+?)(?=\s+[@#(]|$)/i;

/** Regex to match the `#someday` tag (dateless backlog). Word-boundary so `#somedayish`
 *  doesn't match; the trailing lookahead keeps sub-tags like `#someday/foo` from matching. */
export const SOMEDAY_TAG_REGEX = /#someday(?![\w\/-])/i;

/** Regex to match a trailing `[[Topic or Page]]` wiki-link at the very end of a task line.
 *  Only a link in tail position is treated as the task's Topic/page link (and stripped from
 *  display) — inline links mid-text are left untouched. */
export const TRAILING_WIKILINK_REGEX = /\s*\[\[([^\]]+)\]\]\s*$/;

/** Regex to match migration source annotation: (from [[filename]]) */
export const MIGRATED_FROM_REGEX = /\s*\(from\s+\[\[([^\]]+)\]\]\)\s*/;

/** Regex to match work type tags: #work/name or #w/CODE */
export const WORK_TYPE_REGEX = /#(?:work|w)\/(\S+)/i;

/** Regex to match purpose tags: #purpose/name or #p/CODE */
export const PURPOSE_REGEX = /#(?:purpose|p)\/(\S+)/i;

/** Debounce delay for vault file change events (ms) */
export const SCAN_DEBOUNCE_MS = 300;

/** Debounce delay for search input in toolbar (ms) */
export const SEARCH_DEBOUNCE_MS = 200;

/** Debounce delay for UI refresh coalescing (ms) */
export const REFRESH_DEBOUNCE_MS = 100;

/** Debounce delay for settings text input (ms) */
export const SETTINGS_DEBOUNCE_MS = 500;

/** Delay before clearing sync flag after writing to original (ms) */
export const SYNC_CLEAR_DELAY_MS = 500;

/** Number of files to read in parallel during full scan */
export const SCAN_BATCH_SIZE = 50;
