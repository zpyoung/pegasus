import { Locator } from '@playwright/test';

/**
 * Check if an element is scrollable (has scrollable content)
 */
export async function isElementScrollable(locator: Locator): Promise<boolean> {
  const scrollInfo = await locator.evaluate((el) => {
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      isScrollable: el.scrollHeight > el.clientHeight,
    };
  });
  return scrollInfo.isScrollable;
}

/**
 * Scroll an element to the bottom
 */
export async function scrollToBottom(locator: Locator): Promise<void> {
  await locator.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
}

/**
 * Get the scroll position of an element
 */
export async function getScrollPosition(
  locator: Locator
): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> {
  return await locator.evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
}

/**
 * Check if an element is visible within a scrollable container
 */
export async function isElementVisibleInScrollContainer(
  element: Locator,
  container: Locator
): Promise<boolean> {
  const elementBox = await element.boundingBox();
  const containerBox = await container.boundingBox();

  if (!elementBox || !containerBox) {
    return false;
  }

  // Check if element is within the visible area of the container
  return (
    elementBox.y >= containerBox.y &&
    elementBox.y + elementBox.height <= containerBox.y + containerBox.height
  );
}
