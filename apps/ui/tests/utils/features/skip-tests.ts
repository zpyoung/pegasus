import { Page, Locator } from '@playwright/test';

/**
 * Get the skip tests checkbox element in the add feature dialog
 */
export async function getSkipTestsCheckbox(page: Page): Promise<Locator> {
  return page.locator('[data-testid="skip-tests-checkbox"]');
}

/**
 * Toggle the skip tests checkbox in the add feature dialog
 */
export async function toggleSkipTestsCheckbox(page: Page): Promise<void> {
  const checkbox = page.locator('[data-testid="skip-tests-checkbox"]');
  await checkbox.click();
}

/**
 * Check if the skip tests checkbox is checked in the add feature dialog
 */
export async function isSkipTestsChecked(page: Page): Promise<boolean> {
  const checkbox = page.locator('[data-testid="skip-tests-checkbox"]');
  const state = await checkbox.getAttribute('data-state');
  return state === 'checked';
}

/**
 * Get the edit skip tests checkbox element in the edit feature dialog
 */
export async function getEditSkipTestsCheckbox(page: Page): Promise<Locator> {
  return page.locator('[data-testid="edit-skip-tests-checkbox"]');
}

/**
 * Toggle the skip tests checkbox in the edit feature dialog
 */
export async function toggleEditSkipTestsCheckbox(page: Page): Promise<void> {
  const checkbox = page.locator('[data-testid="edit-skip-tests-checkbox"]');
  await checkbox.click();
}

/**
 * Check if the skip tests checkbox is checked in the edit feature dialog
 */
export async function isEditSkipTestsChecked(page: Page): Promise<boolean> {
  const checkbox = page.locator('[data-testid="edit-skip-tests-checkbox"]');
  const state = await checkbox.getAttribute('data-state');
  return state === 'checked';
}

/**
 * Check if the skip tests badge is visible on a kanban card
 */
export async function isSkipTestsBadgeVisible(page: Page, featureId: string): Promise<boolean> {
  const badge = page.locator(`[data-testid="skip-tests-badge-${featureId}"]`);
  return await badge.isVisible().catch(() => false);
}

/**
 * Get the skip tests badge element for a kanban card
 */
export async function getSkipTestsBadge(page: Page, featureId: string): Promise<Locator> {
  return page.locator(`[data-testid="skip-tests-badge-${featureId}"]`);
}

/**
 * Click the manual verify button for a skipTests feature
 */
export async function clickManualVerify(page: Page, featureId: string): Promise<void> {
  const button = page.locator(`[data-testid="manual-verify-${featureId}"]`);
  await button.click();
}

/**
 * Check if the manual verify button is visible for a feature
 */
export async function isManualVerifyButtonVisible(page: Page, featureId: string): Promise<boolean> {
  const button = page.locator(`[data-testid="manual-verify-${featureId}"]`);
  return await button.isVisible().catch(() => false);
}

/**
 * Click the move back button for a verified skipTests feature
 */
export async function clickMoveBack(page: Page, featureId: string): Promise<void> {
  const button = page.locator(`[data-testid="move-back-${featureId}"]`);
  await button.click();
}

/**
 * Check if the move back button is visible for a feature
 */
export async function isMoveBackButtonVisible(page: Page, featureId: string): Promise<boolean> {
  const button = page.locator(`[data-testid="move-back-${featureId}"]`);
  return await button.isVisible().catch(() => false);
}
