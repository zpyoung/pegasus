import { Page, Locator } from '@playwright/test';

/**
 * Get the concurrency slider container
 */
export async function getConcurrencySliderContainer(page: Page): Promise<Locator> {
  return page.locator('[data-testid="concurrency-slider-container"]');
}

/**
 * Get the concurrency slider
 */
export async function getConcurrencySlider(page: Page): Promise<Locator> {
  return page.locator('[data-testid="concurrency-slider"]');
}

/**
 * Get the displayed concurrency value
 */
export async function getConcurrencyValue(page: Page): Promise<string | null> {
  const valueElement = page.locator('[data-testid="concurrency-value"]');
  return await valueElement.textContent();
}

/**
 * Change the concurrency slider value by clicking on the slider track
 */
export async function setConcurrencyValue(
  page: Page,
  targetValue: number,
  min: number = 1,
  max: number = 10
): Promise<void> {
  const slider = page.locator('[data-testid="concurrency-slider"]');
  const sliderBounds = await slider.boundingBox();

  if (!sliderBounds) {
    throw new Error('Concurrency slider not found or not visible');
  }

  // Calculate position for target value
  const percentage = (targetValue - min) / (max - min);
  const targetX = sliderBounds.x + sliderBounds.width * percentage;
  const centerY = sliderBounds.y + sliderBounds.height / 2;

  // Click at the target position to set the value
  await page.mouse.click(targetX, centerY);
}
