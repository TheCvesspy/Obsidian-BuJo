export const VIEW_TYPE_TASK_BUJO = 'task-bujo-view';

/** Regex to match a checkbox line: - [ ] text, - [x] text, - [>] text, etc. */
export const CHECKBOX_REGEX = /^(\s*)-\s*\[([ x><!-])\]\s+(.*)$/i;

/** Regex to match a markdown heading */
export const HEADING_REGEX = /^(#{1,6})\s+(.+)$/;

/** Regex to match priority tags */
export const PRIORITY_TAG_REGEX = /#priority\/(high|medium|low)/i;

/** Regex to match item category inline tags */
export const TYPE_TAG_REGEX = /#type\/(task|openpoint)/i;

/** Regex to match @due dates: @due DD-MM-YYYY, @due DD-MM, or @due <natural language> */
export const DUE_DATE_REGEX = /@due\s+([\w\d\s\/-]+?)(?=\s+[@#(]|$)/i;

/** Regex to match migration source annotation: (from [[filename]]) */
export const MIGRATED_FROM_REGEX = /\s*\(from\s+\[\[([^\]]+)\]\]\)\s*/;

/** Regex to match work type tags: #work/name or #w/CODE */
export const WORK_TYPE_REGEX = /#(?:work|w)\/(\S+)/i;

/** Regex to match purpose tags: #purpose/name or #p/CODE */
export const PURPOSE_REGEX = /#(?:purpose|p)\/(\S+)/i;

/** Regex to match effort tags: #effort/S, #effort/M, #effort/L */
export const EFFORT_REGEX = /#effort\/(S|M|L)/i;

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
