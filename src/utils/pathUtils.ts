import { FolderState } from '../types';

/**
 * Resolve the effective state for a file path by walking up the folder hierarchy.
 * Checks each parent folder from most specific to root. 
 * 'inherit' entries are skipped. First explicit 'include'/'exclude' wins.
 * Default (no explicit state found): 'include'.
 */
export function getEffectiveState(
	filePath: string,
	folderStates: Record<string, FolderState>
): FolderState {
	const normalizedPath = filePath.replace(/\\/g, '/');
	const segments = normalizedPath.split('/');

	// Walk from deepest folder to root
	// For "a/b/c/file.md" check: "a/b/c", "a/b", "a"
	for (let i = segments.length - 1; i >= 1; i--) {
		const folderPath = segments.slice(0, i).join('/');
		const state = folderStates[folderPath];
		if (state && state !== 'inherit') {
			return state;
		}
	}

	// Also check root-level state (empty string key)
	const rootState = folderStates[''];
	if (rootState && rootState !== 'inherit') {
		return rootState;
	}

	return 'include';
}

/**
 * Check if a file path should be included based on folder state settings.
 */
export function shouldIncludeFile(
	filePath: string,
	folderStates: Record<string, FolderState>
): boolean {
	return getEffectiveState(filePath, folderStates) === 'include';
}
