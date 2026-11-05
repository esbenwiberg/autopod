import type { ReviewerImage } from '../inputs/reviewer-images.js';

export function referenceImage(overrides: Partial<ReviewerImage> = {}): ReviewerImage {
  return {
    label: 'wireframe.png',
    role: 'reference',
    mediaType: 'image/png',
    bytes: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxN8AAAAASUVORK5CYII=',
      'base64',
    ),
    ...overrides,
  };
}
