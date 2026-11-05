import { createHash } from 'node:crypto';
import { INPUTS_CONTAINER_DIR, type InputBundleRef, inputBundleRefSchema } from '@autopod/shared';

/** Trusted pre-agent check: no supplied HTML/script is executed. Arguments never enter a shell. */
export function inputBundleVerificationCommand(
  ref: InputBundleRef,
  root = INPUTS_CONTAINER_DIR,
): string[] {
  const manifestHash = createHash('sha256')
    .update(JSON.stringify(inputBundleRefSchema.parse(ref)))
    .digest('hex');
  return [
    'python3',
    '-c',
    `import hashlib,json,os,pathlib,sys
root=pathlib.Path(sys.argv[1])
if str(root.resolve()) != str(root) or not root.is_dir(): raise RuntimeError('unsafe input root')
manifest=root/'manifest.json'
if manifest.is_symlink(): raise RuntimeError('unsafe input manifest')
raw=manifest.read_bytes()
if hashlib.sha256(raw).hexdigest() != sys.argv[2]: raise RuntimeError('input manifest mismatch')
entries=json.loads(raw)['files']
expected={'manifest.json'} | {'files/'+entry['path'] for entry in entries}
allowed_dirs={str(parent) for name in expected for parent in pathlib.PurePosixPath(name).parents if str(parent) != '.'}
for directory, dirs, files in os.walk(root):
 for name in dirs+files:
  item=pathlib.Path(directory)/name
  relative=item.relative_to(root).as_posix()
  if item.is_symlink() or relative not in (allowed_dirs if item.is_dir() else expected): raise RuntimeError('unexpected input copy entry')
for entry in entries:
 file=root/'files'/entry['path']
 if str(file.resolve()) != str(file) or not file.is_file(): raise RuntimeError('unsafe input file')
 data=file.read_bytes()
 if len(data) != entry['byteLength'] or hashlib.sha256(data).hexdigest() != entry['sha256']: raise RuntimeError('input bytes mismatch')
`,
    root,
    manifestHash,
  ];
}
