/** Atomic config installation using the effective user, not the requested user.
 * File upload and exec may have different identities in a sandbox. Copying into
 * a new file in the config directory avoids changing ownership of the upload.
 * Neither a failed capability check nor unreadable input permits agent launch.
 */
export function runtimeConfigInstallCommand(source: string, target: string): string[] {
  return [
    'sh',
    '-c',
    [
      'set -eu',
      'source_path=$1; target_path=$2; config_dir=${target_path%/*}',
      '[ -d "$config_dir" ] && [ ! -L "$config_dir" ] && [ -w "$config_dir" ]',
      '[ -f "$source_path" ] && [ ! -L "$source_path" ] && [ -r "$source_path" ]',
      'effective_uid=$(id -u)',
      'temp_path=$(mktemp "$config_dir/.autopod-config.XXXXXX")',
      'trap \'rm -f "$temp_path"\' EXIT HUP INT TERM',
      'cat "$source_path" > "$temp_path"',
      'chmod 0644 "$temp_path"',
      // Root-started streaming sessions drop to autopod. A non-root image user
      // retains its identity. Preserve the established sandbox read policy.
      'if [ "$effective_uid" = 0 ]; then chown autopod:autopod "$temp_path"; fi',
      '[ -r "$temp_path" ] && [ ! -L "$target_path" ]',
      'mv -f "$temp_path" "$target_path"',
      'test -r "$target_path"',
    ].join('\n'),
    'autopod-config-install',
    source,
    target,
  ];
}
