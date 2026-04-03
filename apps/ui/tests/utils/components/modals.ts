import { Page, Locator } from '@playwright/test';
import { waitForElement, waitForElementHidden } from '../core/waiting';

/**
 * Check if the agent output modal is visible
 */
export async function isAgentOutputModalVisible(page: Page): Promise<boolean> {
  const modal = page.locator('[data-testid="agent-output-modal"]');
  return await modal.isVisible();
}

/**
 * Wait for the agent output modal to be visible
 */
export async function waitForAgentOutputModal(
  page: Page,
  options?: { timeout?: number }
): Promise<Locator> {
  return await waitForElement(page, 'agent-output-modal', options);
}

/**
 * Wait for the agent output modal to be hidden
 */
export async function waitForAgentOutputModalHidden(
  page: Page,
  options?: { timeout?: number }
): Promise<void> {
  await waitForElementHidden(page, 'agent-output-modal', options);
}

/**
 * Get the modal title/description text to verify which feature's output is being shown
 */
export async function getAgentOutputModalDescription(page: Page): Promise<string | null> {
  const modal = page.locator('[data-testid="agent-output-modal"]');
  const description = modal.locator('[id="radix-\\:r.+\\:-description"]').first();
  return await description.textContent().catch(() => null);
}

/**
 * Check the dialog description content in the agent output modal
 */
export async function getOutputModalDescription(page: Page): Promise<string | null> {
  const modalDescription = page.locator(
    '[data-testid="agent-output-modal"] [data-slot="dialog-description"]'
  );
  return await modalDescription.textContent().catch(() => null);
}

/**
 * Get the agent output modal description element
 */
export async function getAgentOutputModalDescriptionElement(page: Page): Promise<Locator> {
  return page.locator('[data-testid="agent-output-description"]');
}

/**
 * Check if the agent output modal description is scrollable
 */
export async function isAgentOutputDescriptionScrollable(page: Page): Promise<boolean> {
  const description = page.locator('[data-testid="agent-output-description"]');
  const scrollInfo = await description.evaluate((el) => {
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      isScrollable: el.scrollHeight > el.clientHeight,
    };
  });
  return scrollInfo.isScrollable;
}

/**
 * Get scroll dimensions of the agent output modal description
 */
export async function getAgentOutputDescriptionScrollDimensions(page: Page): Promise<{
  scrollHeight: number;
  clientHeight: number;
  maxHeight: string;
  overflowY: string;
}> {
  const description = page.locator('[data-testid="agent-output-description"]');
  return await description.evaluate((el) => {
    const style = window.getComputedStyle(el);
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      maxHeight: style.maxHeight,
      overflowY: style.overflowY,
    };
  });
}
