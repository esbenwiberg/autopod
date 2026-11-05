/** Native images belong in the model transport, never the normalized activity/log text. */
export function toolResultSummary(value: unknown, referenceContent = false): string {
  if (referenceContent) return '[reference file content withheld from activity]';
  let changes = 0;
  let nodes = 0;
  const walk = (item: unknown, depth: number): unknown => {
    if (++nodes > 10_000 || depth > 20) {
      changes++;
      return '[omitted]';
    }
    if (typeof item === 'string') {
      const replaced = item.replace(
        /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+/gi,
        '[image bytes withheld]',
      );
      if (replaced !== item) {
        changes++;
        return replaced;
      }
      if (
        /"(?:type|mimeType|mime_type|media_type)"\s*:\s*"(?:image|input_image)/.test(item) ||
        (item.includes('"rendererProtocol"') && item.includes('"bundleDigest"'))
      ) {
        if (!/^\s*(?:\{|\[)/.test(item)) {
          changes++;
          return '[image-bearing tool output withheld]';
        }
        try {
          const before = changes;
          const parsed = walk(JSON.parse(item), depth + 1);
          return changes > before ? JSON.stringify(parsed) : item;
        } catch {
          changes++;
          return '[unparseable image-bearing tool output withheld]';
        }
      }
      return item;
    }
    if (!item || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map((entry) => walk(entry, depth + 1));
    const record = item as Record<string, unknown>;
    if (
      record.rendererProtocol === 1 &&
      typeof record.bundleDigest === 'string' &&
      'entrypoint' in record
    ) {
      changes++;
      return walk(
        Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'entrypoint')),
        depth + 1,
      );
    }
    const mime = record.mimeType ?? record.mime_type ?? record.media_type;
    if (
      (typeof record.type === 'string' &&
        ['image', 'input_image', 'image_url'].includes(record.type)) ||
      (typeof mime === 'string' &&
        mime.startsWith('image/') &&
        ('data' in record || 'blob' in record))
    ) {
      changes++;
      return {
        type: 'image',
        ...(typeof mime === 'string' && /^image\/[a-z0-9.+-]{1,32}$/i.test(mime)
          ? { mimeType: mime }
          : {}),
        bytesWithheld: true,
      };
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, walk(entry, depth + 1)]),
    );
  };
  const result = walk(value, 0);
  return typeof result === 'string' ? result : (JSON.stringify(result) ?? '');
}

export function isReferenceInput(input: Record<string, unknown>): boolean {
  return Object.values(input).some(
    (value) =>
      typeof value === 'string' &&
      (value.includes('/autopod/inputs/') || value === '/autopod/inputs'),
  );
}
export function toolInputSummary(
  tool: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!tool.endsWith('render_reference') && !isReferenceInput(input)) return input;
  return {
    ...(typeof input.call_id === 'string' ? { call_id: input.call_id } : {}),
    ...(typeof input.server === 'string' ? { server: input.server } : {}),
    reference: tool.endsWith('render_reference') ? 'admitted HTML reference' : 'admitted reference',
  };
}
