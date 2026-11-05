/** Shared by fix admission and dispatch; callers supply creation-ordered owners.
 * Keep this selector dependency-free: the dispatch ledger is below the workspace
 * composition contracts in the repository/declaration dependency graph.
 */
export function selectSinglePrOwner<T extends { prUrl?: string | null }>(
  parent: T,
  owners: readonly T[],
): T | undefined {
  return (parent.prUrl ? owners.find((p) => p.prUrl === parent.prUrl) : undefined) ?? owners[0];
}
