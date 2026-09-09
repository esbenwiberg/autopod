"""Prepare a reviewable local Azure Run Command script; never invoke Azure."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import shlex
import sys
import zlib

here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('wrapper', here / 'hosted-upgrade-wrapper.py')
wrapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wrapper)
package, output = map(Path, sys.argv[1:])
if not package.is_absolute() or not output.is_absolute():
    raise ValueError('Absolute package and new output paths required')
entries = {}
for name in sorted(wrapper.ARTIFACTS | {'manifest.json'}):
    file = package / name
    if file.is_symlink():
        raise ValueError('Source artifact symlink refused')
    entries[name] = base64.b64encode(file.read_bytes()).decode()
for file in sorted((package / 'migrations').iterdir()):
    if file.is_symlink() or not file.is_file() or file.suffix != '.sql':
        raise ValueError('Migration inventory refused')
    entries['migrations/' + file.name] = base64.b64encode(file.read_bytes()).decode()
compressed = zlib.compress(json.dumps(entries, separators=(',', ':')).encode(), 9)
encoded = base64.b64encode(compressed).decode()
sha = hashlib.sha256(compressed).hexdigest()
wrapper.unpack_payload(encoded, sha)
source = (here / 'hosted-upgrade-wrapper.py').read_text()
script = "#!/bin/sh\n# Prepared only. Explicit hosted-copy execution approval required.\nset -eu\npython3 - <<'AUTOPOD_PRIVATE_UPGRADE_PY'\n" + source + '\nmain(' + repr(encoded) + ', ' + repr(sha) + ")\nAUTOPOD_PRIVATE_UPGRADE_PY\n"
output.mkdir(mode=0o700)
(output / 'hosted-upgrade.sh').write_text(script)
vm = '/subscriptions/06bb959b-9458-41a6-bdf5-77cc12feaab9/resourceGroups/ewi-sandboxes/providers/Microsoft.Compute/virtualMachines/autopod-daemon'
invoke = '''#!/bin/sh
# DO NOT RUN without approval of this exact source/upload/isolated-upgrade packet.
set -eu
resource_id=''' + shlex.quote(vm) + '''
observed_vm_id=$(az vm show --ids "$resource_id" --query vmId --output tsv --only-show-errors)
[ "$observed_vm_id" = '3addc9bc-4812-4892-98d6-c40d5ab893c0' ] || exit 1
az vm run-command invoke --ids "$resource_id" --command-id RunShellScript --scripts @''' + shlex.quote(str(output / 'hosted-upgrade.sh')) + ''' --only-show-errors --output json
'''
(output / 'invoke-after-approval.sh').write_text(invoke)
manifest = {'applicationCandidate': wrapper.CANDIDATE, 'payloadSha256': sha,
            'compressedSourceBytes': len(compressed), 'transportScriptBytes': len(script.encode()),
            'scriptSha256': hashlib.sha256(script.encode()).hexdigest(),
            'wrapperSha256': hashlib.sha256(source.encode()).hexdigest(),
            'invokeSha256': hashlib.sha256(invoke.encode()).hexdigest(),
            'artifactCount': len(entries), 'snapshot': str(wrapper.SNAPSHOT),
            'snapshotSha256': wrapper.SNAPSHOT_HASH, 'snapshotBytes': wrapper.SNAPSHOT_BYTES, 'snapshotVersion': wrapper.SNAPSHOT_VERSION,
            'minimumAvailableScratchBytesExclusive': 3 * wrapper.SNAPSHOT_BYTES + 256 * 1024**2,
            'childTimeoutSeconds': 300, 'outerTimeoutSeconds': 420,
            'maximumNodeHeapMiB': 256, 'maximumChildOutputBytes': 16384,
            'vmResourceId': vm, 'vmId': '3addc9bc-4812-4892-98d6-c40d5ab893c0',
            'nodeVersionRequired': 'v22.23.1', 'serviceCwdRequired': str(wrapper.SERVICE_CWD),
            'nativeDependencyBundled': False, 'hostedExecuted': False,
            'authority': 'Review artifact only; explicit upload and isolated-copy execution approval required'}
(output / 'transport-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
for file in output.iterdir():
    file.chmod(0o600)
print(json.dumps(manifest, indent=2))
