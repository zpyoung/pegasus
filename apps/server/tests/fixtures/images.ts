/**
 * Image fixtures for testing image handling
 */

// 1x1 transparent PNG base64 data
export const pngBase64Fixture =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const imageDataFixture = {
  base64: pngBase64Fixture,
  mimeType: "image/png",
  filename: "test.png",
  originalPath: "/path/to/test.png",
};
