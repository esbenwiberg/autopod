/** Content identity plus duplicate occurrence, independent of unrelated list positions. */
export function withOccurrenceKeys<T>(
  items: readonly T[],
  identity: (item: T) => string,
): Array<{ item: T; key: string }> {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const content = identity(item);
    const occurrence = occurrences.get(content) ?? 0;
    occurrences.set(content, occurrence + 1);
    return { item, key: JSON.stringify([content, occurrence]) };
  });
}
