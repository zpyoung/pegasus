import { Page, Locator } from '@playwright/test';

/**
 * Get the follow-up button for a waiting_approval feature
 */
export async function getFollowUpButton(page: Page, featureId: string): Promise<Locator> {
  return page.locator(`[data-testid="follow-up-${featureId}"]`);
}

/**
 * Click the follow-up button for a waiting_approval feature
 */
export async function clickFollowUpButton(page: Page, featureId: string): Promise<void> {
  const button = page.locator(`[data-testid="follow-up-${featureId}"]`);
  await button.click();
}

/**
 * Check if the follow-up button is visible for a feature
 */
export async function isFollowUpButtonVisible(page: Page, featureId: string): Promise<boolean> {
  const button = page.locator(`[data-testid="follow-up-${featureId}"]`);
  return await button.isVisible().catch(() => false);
}

/**
 * Get the commit button for a waiting_approval feature
 */
export async function getCommitButton(page: Page, featureId: string): Promise<Locator> {
  return page.locator(`[data-testid="commit-${featureId}"]`);
}

/**
 * Click the commit button for a waiting_approval feature
 */
export async function clickCommitButton(page: Page, featureId: string): Promise<void> {
  const button = page.locator(`[data-testid="commit-${featureId}"]`);
  await button.click();
}

/**
 * Check if the commit button is visible for a feature
 */
export async function isCommitButtonVisible(page: Page, featureId: string): Promise<boolean> {
  const button = page.locator(`[data-testid="commit-${featureId}"]`);
  return await button.isVisible().catch(() => false);
}

/**
 * Get the waiting_approval kanban column
 */
export async function getWaitingApprovalColumn(page: Page): Promise<Locator> {
  return page.locator('[data-testid="kanban-column-waiting_approval"]');
}

/**
 * Check if the waiting_approval column is visible
 */
export async function isWaitingApprovalColumnVisible(page: Page): Promise<boolean> {
  const column = page.locator('[data-testid="kanban-column-waiting_approval"]');
  return await column.isVisible().catch(() => false);
}
