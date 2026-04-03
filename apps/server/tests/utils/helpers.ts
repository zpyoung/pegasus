/**
 * Test helper functions
 */

/**
 * Collect all values from an async generator
 */
export async function collectAsyncGenerator<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of gen) {
    results.push(item);
  }
  return results;
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean,
  timeout = 1000,
  interval = 10
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error('Timeout waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * Create a temporary directory for tests
 */
export function createTempDir(): string {
  return `/tmp/test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
