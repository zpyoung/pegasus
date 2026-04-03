import { Page, Locator } from '@playwright/test';
import { clickElement } from '../core/interactions';

/**
 * Get the log viewer header element (contains type counts and expand/collapse buttons)
 */
export async function getLogViewerHeader(page: Page): Promise<Locator> {
  return page.locator('[data-testid="log-viewer-header"]');
}

/**
 * Check if the log viewer header is visible
 */
export async function isLogViewerHeaderVisible(page: Page): Promise<boolean> {
  const header = page.locator('[data-testid="log-viewer-header"]');
  return await header.isVisible().catch(() => false);
}

/**
 * Get the log entries container element
 */
export async function getLogEntriesContainer(page: Page): Promise<Locator> {
  return page.locator('[data-testid="log-entries-container"]');
}

/**
 * Get a log entry by its type
 */
export async function getLogEntryByType(page: Page, type: string): Promise<Locator> {
  return page.locator(`[data-testid="log-entry-${type}"]`).first();
}

/**
 * Get all log entries of a specific type
 */
export async function getAllLogEntriesByType(page: Page, type: string): Promise<Locator> {
  return page.locator(`[data-testid="log-entry-${type}"]`);
}

/**
 * Count log entries of a specific type
 */
export async function countLogEntriesByType(page: Page, type: string): Promise<number> {
  const entries = page.locator(`[data-testid="log-entry-${type}"]`);
  return await entries.count();
}

/**
 * Get the log type count badge by type
 */
export async function getLogTypeCountBadge(page: Page, type: string): Promise<Locator> {
  return page.locator(`[data-testid="log-type-count-${type}"]`);
}

/**
 * Check if a log type count badge is visible
 */
export async function isLogTypeCountBadgeVisible(page: Page, type: string): Promise<boolean> {
  const badge = page.locator(`[data-testid="log-type-count-${type}"]`);
  return await badge.isVisible().catch(() => false);
}

/**
 * Click the expand all button in the log viewer
 */
export async function clickLogExpandAll(page: Page): Promise<void> {
  await clickElement(page, 'log-expand-all');
}

/**
 * Click the collapse all button in the log viewer
 */
export async function clickLogCollapseAll(page: Page): Promise<void> {
  await clickElement(page, 'log-collapse-all');
}

/**
 * Get a log entry badge element
 */
export async function getLogEntryBadge(page: Page): Promise<Locator> {
  return page.locator('[data-testid="log-entry-badge"]').first();
}

/**
 * Check if any log entry badge is visible
 */
export async function isLogEntryBadgeVisible(page: Page): Promise<boolean> {
  const badge = page.locator('[data-testid="log-entry-badge"]').first();
  return await badge.isVisible().catch(() => false);
}

/**
 * Get the view mode toggle button (parsed/raw)
 */
export async function getViewModeButton(page: Page, mode: 'parsed' | 'raw'): Promise<Locator> {
  return page.locator(`[data-testid="view-mode-${mode}"]`);
}

/**
 * Click a view mode toggle button
 */
export async function clickViewModeButton(page: Page, mode: 'parsed' | 'raw'): Promise<void> {
  await clickElement(page, `view-mode-${mode}`);
}

/**
 * Check if a view mode button is active (selected)
 */
export async function isViewModeActive(page: Page, mode: 'parsed' | 'raw'): Promise<boolean> {
  const button = page.locator(`[data-testid="view-mode-${mode}"]`);
  const classes = await button.getAttribute('class');
  return classes?.includes('text-purple-300') ?? false;
}
