import { Page, Locator } from "@playwright/test";

/**
 * Get the settings view scrollable content area
 */
export async function getSettingsContentArea(page: Page): Promise<Locator> {
  return page.locator('[data-testid="settings-view"] .overflow-y-auto');
}
