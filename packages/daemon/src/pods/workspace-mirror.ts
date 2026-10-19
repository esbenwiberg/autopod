import { shellQuote } from '../util/shell-quote.js';

export const WORKSPACE_RUNTIME_CACHE_EXCLUDES = ['node_modules', '.serena', '.roslyn-codelens'];
export const WORKSPACE_SYNC_EXCLUDES = ['.git', ...WORKSPACE_RUNTIME_CACHE_EXCLUDES];
export function workspaceMirrorPruneExpression(excludes: string[]): string {
  const predicates = excludes.map((name) => `-name ${shellQuote(name)}`).join(' -o ');
  return `\\( ${predicates} \\) -prune -o`;
}

export function workspaceMirrorPreservePredicates(excludes: string[]): string[] {
  return excludes.flatMap((name) => [`! -path '*/${name}'`, `! -path '*/${name}/*'`]);
}

export function buildWorkspaceMirrorCopyScript(
  sourceDir: string,
  targetDirArg: string,
  excludes: string[],
): string {
  const copyOne = [
    'target=$1',
    'shift',
    'for rel do',
    '  dest="$target/${rel#./}"',
    '  if [ -d "$rel" ] && [ ! -L "$rel" ]; then',
    '    mkdir -p "$dest"',
    '  else',
    '    mkdir -p "$(dirname "$dest")"',
    '    cp -a "$rel" "$dest"',
    '  fi',
    'done',
  ].join('\n');

  return [
    `cd ${shellQuote(sourceDir)}`,
    `find . -mindepth 1 ${workspaceMirrorPruneExpression(excludes)} -exec sh -c ${shellQuote(
      copyOne,
    )} sh ${targetDirArg} {} +`,
  ].join(' && ');
}
