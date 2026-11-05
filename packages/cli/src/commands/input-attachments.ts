import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  type InputBundleRef,
  type InputFile,
  inputManifestSchema,
  inputMediaType,
  MAX_INPUT_BUNDLE_BYTES,
  MAX_INPUT_FILE_BYTES,
  MAX_INPUT_FILES,
} from '@autopod/shared';
import type { AutopodClient } from '../api/client.js';

export interface AttachmentFlags {
  attach?: string[];
  attachDir?: string[];
}
export interface CollectedInput {
  file: InputFile;
  bytes: Buffer;
}
const skipDirectories = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor']);
export function collectInputs(flags: AttachmentFlags): CollectedInput[] {
  const result: CollectedInput[] = [];
  let total = 0;
  let entries = 0;
  function add(full: string, name: string, root: string) {
    const actual = realpathSync(full);
    const rel = relative(root, actual);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../'))
      throw new Error('Attachment escapes the selected directory');
    const mediaType = inputMediaType(name);
    if (!mediaType) throw new Error(`Unsupported reference attachment: ${name}`);
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.size > MAX_INPUT_FILE_BYTES ||
        total + stat.size > MAX_INPUT_BUNDLE_BYTES ||
        result.length >= MAX_INPUT_FILES
      )
        throw new Error('Attachment limits: 50 regular files, 10 MiB each, 25 MiB total');
      const buffer = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const count = readSync(fd, buffer, offset, buffer.length - offset, null);
        if (count === 0) break;
        offset += count;
      }
      if (offset !== stat.size)
        throw new Error('Attachment changed while being read; retry selection');
      bytes = buffer.subarray(0, offset);
    } finally {
      closeSync(fd);
    }
    total += bytes.length;
    result.push({
      file: {
        path: name,
        mediaType,
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      bytes,
    });
  }
  for (const selected of flags.attach ?? []) {
    const full = resolve(selected);
    if (!lstatSync(full).isFile())
      throw new Error(
        'Use --attach for regular files, --attach-dir for folders; symlinks are not allowed',
      );
    add(full, basename(full), realpathSync(resolve(full, '..')));
  }
  for (const selected of flags.attachDir ?? []) {
    const full = resolve(selected);
    if (!lstatSync(full).isDirectory())
      throw new Error('Attachment folders must be directories, not symlinks');
    const root = realpathSync(full);
    function walk(directory: string): void {
      for (const entry of readdirSync(directory).sort()) {
        if (++entries > 2000) throw new Error('Attachment folder exceeds 2000 entries');
        if (entry.startsWith('.') || skipDirectories.has(entry)) continue;
        const file = join(directory, entry);
        const stat = lstatSync(file);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
          throw new Error('Symlinks and special files are not allowed in attachments');
        if (stat.isDirectory()) walk(file);
        else add(file, `${basename(root)}/${relative(root, file).split('\\').join('/')}`, root);
      }
    }
    walk(root);
  }
  result.sort((a, b) => (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0));
  if (result.length) inputManifestSchema.parse({ files: result.map((item) => item.file) });
  if (!result.length && (flags.attach?.length ?? 0) + (flags.attachDir?.length ?? 0))
    throw new Error('No supported reference files selected');
  return result;
}
export async function uploadInputs(
  client: Pick<AutopodClient, 'createInputBundle' | 'uploadInputFile' | 'sealInputBundle'>,
  inputs: CollectedInput[],
): Promise<InputBundleRef> {
  const files = inputs.map((input) => input.file);
  const hash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  // Stable for exact upload retries; the daemon scopes keys to the authenticated owner.
  const requestKey = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const bundle = await client.createInputBundle({ requestKey, files });
  if (bundle.status !== 'sealed') {
    for (const [index, file] of bundle.files.entries()) {
      const input = inputs.find((candidate) => candidate.file.path === file.path);
      if (!input || input.file.sha256 !== file.sha256) throw new Error('Upload manifest changed');
      await client.uploadInputFile(bundle.id, index, input.bytes);
    }
  }
  const { status, ...ref } = await client.sealInputBundle(bundle.id);
  if (status !== 'sealed') throw new Error('Reference upload was not sealed');
  return ref;
}
