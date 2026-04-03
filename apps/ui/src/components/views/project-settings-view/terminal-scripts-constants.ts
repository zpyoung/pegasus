/**
 * Shared terminal script constants used by both the settings section
 * (terminal-scripts-section.tsx) and the terminal header dropdown
 * (terminal-scripts-dropdown.tsx).
 *
 * Centralising the default scripts here ensures both components show
 * the same fallback list and removes the duplicated definition.
 */

export interface TerminalScript {
  id: string;
  name: string;
  command: string;
}

/** Default scripts shown when the user has not configured any custom scripts yet. */
export const DEFAULT_TERMINAL_SCRIPTS: TerminalScript[] = [
  { id: 'default-dev', name: 'Dev Server', command: 'pnpm dev' },
  { id: 'default-format', name: 'Format', command: 'pnpm format' },
  { id: 'default-test', name: 'Test', command: 'pnpm test' },
  { id: 'default-lint', name: 'Lint', command: 'pnpm lint' },
];
