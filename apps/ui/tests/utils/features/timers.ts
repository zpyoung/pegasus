import { Page, Locator } from '@playwright/test';

/**
 * Get the count up timer element for a specific feature card
 */
export async function getTimerForFeature(page: Page, featureId: string): Promise<Locator> {
  const card = page.locator(`[data-testid="kanban-card-${featureId}"]`);
  return card.locator('[data-testid="count-up-timer"]');
}

/**
 * Get the timer display text for a specific feature card
 */
export async function getTimerDisplayForFeature(
  page: Page,
  featureId: string
): Promise<string | null> {
  const card = page.locator(`[data-testid="kanban-card-${featureId}"]`);
  const timerDisplay = card.locator('[data-testid="timer-display"]');
  return await timerDisplay.textContent();
}

/**
 * Check if a timer is visible for a specific feature
 */
export async function isTimerVisibleForFeature(page: Page, featureId: string): Promise<boolean> {
  const card = page.locator(`[data-testid="kanban-card-${featureId}"]`);
  const timer = card.locator('[data-testid="count-up-timer"]');
  return await timer.isVisible().catch(() => false);
}
