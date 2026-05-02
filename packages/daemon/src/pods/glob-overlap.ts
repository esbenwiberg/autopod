/**
 * Glob-prefix overlap detection for pod preflight conflict checks.
 *
 * Two pods conflict if any of pod A's `touches` globs and any of pod B's
 * `touches` globs *could* match the same file. Computing exact glob-vs-glob
 * intersection is hard; we use a deliberately conservative directory-prefix
 * approximation that catches the common patterns without pulling in a glob
 * matcher:
 *
 *   `packages/daemon/src/pods/**`  vs  `packages/daemon/src/pods/foo.ts`
 *   → both have prefix `packages/daemon/src/pods/`, one contains the other → overlap
 *
 *   `packages/daemon/src/api/**`   vs  `packages/cli/**`
 *   → prefixes are disjoint → no overlap
 *
 * The check is symmetric: prefix(a) is a prefix of prefix(b), or vice versa.
 * This errs slightly toward false positives (e.g. `packages/daemon/foo.ts`
 * looks like it overlaps with `packages/daemon/bar/**`) which is acceptable
 * for a *warn-only* signal — the user can ignore noise but a missed conflict
 * silently produces a merge conflict later.
 */

/**
 * Strip the glob portion of a path. Cuts at the first `*`, `?`, `[`, or `{` —
 * the segment up to that point is the path that *must* match for the glob to
 * have any chance of matching. Trailing slashes are normalized so prefix
 * comparison treats `foo/` and `foo` the same.
 */
export function globPrefix(glob: string): string {
  const trimmed = glob.trim();
  if (!trimmed) return '';
  const cutIdx = (() => {
    for (let i = 0; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (c === '*' || c === '?' || c === '[' || c === '{') return i;
    }
    return trimmed.length;
  })();
  let prefix = trimmed.slice(0, cutIdx);
  // For mid-segment globs (`src/foo*.ts`) cut back to the last full segment so
  // we don't match against partial filenames.
  if (cutIdx < trimmed.length && !prefix.endsWith('/')) {
    const lastSlash = prefix.lastIndexOf('/');
    prefix = lastSlash >= 0 ? prefix.slice(0, lastSlash + 1) : '';
  }
  // Strip trailing slash so `foo/` and `foo` compare equal.
  if (prefix.endsWith('/')) prefix = prefix.slice(0, -1);
  return prefix;
}

/**
 * Two paths overlap if one is a path-segment prefix of the other (or they're
 * equal). `packages/daemon` overlaps `packages/daemon/src/x.ts`, but
 * `packages/daemon` does NOT overlap `packages/daemon-tools` — the prefix
 * must align on a `/` boundary.
 */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === '' || b === '') return true; // empty prefix = matches everything
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (!longer.startsWith(shorter)) return false;
  // Boundary check: next char in `longer` must be `/` so we don't match
  // partial segments like `daemon` ⊂ `daemon-tools`.
  return longer[shorter.length] === '/';
}

/**
 * Pairwise overlap between two glob lists. Returns the matching pairs
 * (caller can present them in the warning) — empty array means no conflict.
 */
export function findGlobOverlaps(
  ours: readonly string[],
  theirs: readonly string[],
): Array<{ ours: string; theirs: string }> {
  const oursPrefixes = ours.map((g) => ({ glob: g, prefix: globPrefix(g) }));
  const theirsPrefixes = theirs.map((g) => ({ glob: g, prefix: globPrefix(g) }));
  const matches: Array<{ ours: string; theirs: string }> = [];
  for (const o of oursPrefixes) {
    for (const t of theirsPrefixes) {
      if (pathsOverlap(o.prefix, t.prefix)) {
        matches.push({ ours: o.glob, theirs: t.glob });
      }
    }
  }
  return matches;
}
