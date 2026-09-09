"""Source-only payload runner. No hosted execution is authorized by this file.

main pins the service, active inode and historical snapshot. Testable helpers
never derive authorization from the local test parameters. No active DB open.
"""
import base64
import hashlib
import json
import os
import re
import selectors
import shutil
import signal
import stat
import subprocess
import tempfile
import time
import zlib
from pathlib import Path

ACTIVE = Path('/data/autopod/autopod.db')
ACTIVE_ID = (2049, 13107203)
SNAPSHOT = Path('/data/autopod/backups/1788930281287.db')
SNAPSHOT_BYTES = 877150208
SNAPSHOT_HASH = '3624d3be6ef845f4dded1b84be7bbe38891ca9d3b469c43db166e4dcdd473c68'
SERVICE_CWD = Path('/opt/autopod/releases/c0e5a5b4/packages/daemon')
CANDIDATE = '4e73cd8ce88e44cdb5c2d8d0a89447b819fa5a39'
MIGRATIONS_HASH = '0413c2b3502ce14cf74d164ac6fc474b91143101fd8599d4fea27c91ebb733bf'
ARTIFACTS = {'candidate-migrations.mjs', 'verify-upgrade-copy.mjs', 'verify-upgrade-copy-cli.mjs'}


def require(condition, code):
    if not condition:
        raise ValueError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source:
        value = hashlib.sha256()
        while block := source.read(1024 * 1024):
            value.update(block)
        return value.hexdigest()


def unpack_payload(encoded, expected_hash):
    """Only inert, explicitly named bytes. No archive links or extraction APIs."""
    require(len(encoded) <= 2 * 1024**2, 'transport_limit')
    compressed = base64.b64decode(encoded, validate=True)
    require(digest(compressed) == expected_hash, 'transport_hash')
    inflater = zlib.decompressobj()
    raw = inflater.decompress(compressed, 4 * 1024**2 + 1)
    require(len(raw) <= 4 * 1024**2 and inflater.eof and not inflater.unused_data,
            'expanded_limit')
    entries = json.loads(raw)
    require(isinstance(entries, dict) and len(entries) <= 260, 'entry_limit')
    require(ARTIFACTS | {'manifest.json'} <= entries.keys(), 'missing_artifact')
    files = {}
    for name, value in entries.items():
        require(name in ARTIFACTS | {'manifest.json'} or
                re.fullmatch(r'migrations/[0-9]+_[A-Za-z0-9_-]+\.sql', name), 'entry_name')
        files[name] = base64.b64decode(value, validate=True)
        require(len(files[name]) <= 1024**2, 'file_limit')
    manifest = json.loads(files['manifest.json'])
    require(manifest['applicationCandidate'] == CANDIDATE, 'candidate_identity')
    require(manifest['nativeDependencyBundled'] is False, 'native_dependency')
    require({row['file'] for row in manifest['artifacts']} == ARTIFACTS, 'artifact_inventory')
    for row in manifest['artifacts']:
        require(digest(files[row['file']]) == row['sha256'], 'artifact_hash')
    migrations = sorted((name.split('/')[1], digest(value)) for name, value in files.items()
                        if name.startswith('migrations/'))
    require(migrations and digest(json.dumps(migrations, separators=(',', ':')).encode()) ==
            manifest['migrationSha256'] == MIGRATIONS_HASH, 'migration_hash')
    return files


def bounded_process(argv, cwd, seconds, output_limit=16384):
    """Own a new process group; reap the verifier before returning/cleanup."""
    process = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               start_new_session=True,
                               env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    output = bytearray()
    deadline = time.monotonic() + seconds
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                require(time.monotonic() < deadline, 'process_timeout')
                for key, _ in selector.select(min(0.1, max(0, deadline - time.monotonic()))):
                    block = os.read(key.fd, 4096)
                    if not block:
                        selector.unregister(key.fileobj)
                    else:
                        output.extend(block)
                        require(len(output) <= output_limit, 'process_output_limit')
            code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        return code, bytes(output)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
        process.stdout.close()


def private_run(files, parent, modules, node, snapshot, snapshot_hash, timeout=300):
    """Create and remove only this invocation's private source/scratch directory."""
    directory = Path(tempfile.mkdtemp(prefix='autopod-upgrade-verify-', dir=parent))
    os.chmod(directory, 0o700)
    result = {'status': 'incomplete', 'activeDatabaseOpened': False}
    try:
        (directory / 'migrations').mkdir(mode=0o700)
        for name, content in files.items():
            # Defense in depth: no test/integration caller may escape the directory.
            require(name in ARTIFACTS | {'manifest.json'} or
                    re.fullmatch(r'migrations/[0-9]+_[A-Za-z0-9_-]+\.sql', name), 'entry_name')
            with (directory / name).open('xb') as target:
                os.chmod(target.name, 0o600)
                target.write(content)
        (directory / 'node_modules').symlink_to(modules, target_is_directory=True)
        argv = [str(node), '--max-old-space-size=256', str(directory / 'verify-upgrade-copy-cli.mjs'),
                '--snapshot', str(snapshot), '--snapshot-sha256', snapshot_hash,
                '--migrations', str(directory / 'migrations'), '--migrations-sha256', MIGRATIONS_HASH,
                '--scratch', str(directory)]
        code, output = bounded_process(argv, directory, timeout)
        raw = json.loads(output)
        # Export an allowlist, never the child's arbitrary error/value strings.
        required = ('retainedOriginalColumnsAndRows', 'integrityOk', 'foreignKeysOk',
                    'taskBackfillOk', 'rollbackWriteProbeOk', 'inputHashUnchanged',
                    'isolatedDirectoryRemoved')
        require(code == 0 and raw.get('status') == 'isolated_upgrade_verified', 'child_verdict')
        require(raw.get('activeDatabaseOpened') is False and
                raw.get('beforeVersion') == 152 and raw.get('afterVersion') == 183 and
                raw.get('snapshotSha256') == snapshot_hash and
                raw.get('migrationSha256') == MIGRATIONS_HASH and
                all(raw.get(key) is True for key in required), 'child_evidence')
        result.update(status='isolated_upgrade_verified', beforeVersion=152, afterVersion=183,
                      snapshotSha256=snapshot_hash, migrationSha256=MIGRATIONS_HASH,
                      **{key: True for key in required})
    except Exception:
        pass
    finally:
        # rmtree removes the dependency symlink itself, never its target.
        try:
            shutil.rmtree(directory)
        except OSError:
            result.update(status='incomplete', cleanupPendingPath=str(directory))
        result['privateDirectoryRemoved'] = not directory.exists()
        if not result['privateDirectoryRemoved']:
            result['status'] = 'incomplete'
    return result


def service_identity():
    code, output = bounded_process(['systemctl', 'show', 'autopod-daemon', '-p', 'MainPID', '--value'],
                                   '/', 10, 128)
    require(code == 0 and output.strip().isdigit(), 'service_pid')
    pid = int(output)
    require(pid > 1, 'service_inactive')
    require(Path(f'/proc/{pid}/cwd').resolve() == SERVICE_CWD, 'service_cwd_changed')
    active = ACTIVE.lstat()
    require(stat.S_ISREG(active.st_mode) and (active.st_dev, active.st_ino) == ACTIVE_ID,
            'active_identity')
    matched = False
    with os.scandir(f'/proc/{pid}/fd') as descriptors:
        for index, entry in enumerate(descriptors):
            require(index < 2048, 'descriptor_limit')
            try:
                opened = os.stat(entry.path)
                matched |= (opened.st_dev, opened.st_ino) == ACTIVE_ID
            except FileNotFoundError:
                continue
    require(matched, 'active_descriptor')
    node = Path(f'/proc/{pid}/exe').resolve(strict=True)
    return pid, node


def main(encoded, expected_hash):
    result = {'status': 'incomplete', 'phase': 'preflight', 'activeDatabaseOpened': False}
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError()))
    signal.alarm(420)
    try:
        files = unpack_payload(encoded, expected_hash)
        pid, node = service_identity()
        before = SNAPSHOT.lstat()
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
                before.st_size == SNAPSHOT_BYTES and SNAPSHOT.resolve() == SNAPSHOT,
                'snapshot_identity')
        require(not Path(str(SNAPSHOT) + '-wal').exists() and
                not Path(str(SNAPSHOT) + '-journal').exists(), 'snapshot_sidecar')
        require(file_hash(SNAPSHOT) == SNAPSHOT_HASH, 'snapshot_hash')
        space = os.statvfs(ACTIVE.parent)
        require(space.f_bavail * space.f_frsize > 3 * SNAPSHOT_BYTES + 256 * 1024**2,
                'headroom')
        # No daemon import. Probe the existing service's dependency in memory.
        probe = """const fs=require('fs'),crypto=require('crypto');
const D=require('better-sqlite3');const db=new D(':memory:');
const version=db.prepare('select sqlite_version() AS v').get().v;db.close();
console.log(JSON.stringify({node:process.version,sqlite:version,
 module:fs.realpathSync(require.resolve('better-sqlite3')),
 version:require('better-sqlite3/package.json').version}));"""
        code, output = bounded_process([str(node), '--max-old-space-size=256', '-e', probe],
                                       SERVICE_CWD, 15, 2048)
        metadata = json.loads(output)
        require(code == 0 and metadata.get('node') == 'v22.23.1', 'node_or_abi_changed')
        require(all(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', metadata.get(k, ''))
                    for k in ('sqlite', 'version')), 'dependency_version')
        module = Path(metadata['module']).resolve(strict=True)
        require(module.is_relative_to(SERVICE_CWD.parents[1] / 'node_modules') or
                module.is_relative_to(SERVICE_CWD / 'node_modules'), 'module_location')
        require(service_identity() == (pid, node), 'service_changed')
        result = private_run(files, ACTIVE.parent, SERVICE_CWD / 'node_modules', node,
                             SNAPSHOT, SNAPSHOT_HASH)
        result.update(applicationCandidate=CANDIDATE, payloadSha256=expected_hash,
                      nodeVersion='v22.23.1', sqliteVersion=metadata['sqlite'],
                      moduleVersion=metadata['version'], moduleEntrySha256=file_hash(module))
        result['serviceAndActiveIdentityStable'] = service_identity() == (pid, node)
        after = SNAPSHOT.lstat()
        result['snapshotIdentityStable'] = (before.st_dev, before.st_ino, before.st_size,
                                            before.st_mtime_ns) == (after.st_dev, after.st_ino,
                                                                   after.st_size, after.st_mtime_ns)
        if not result['serviceAndActiveIdentityStable'] or not result['snapshotIdentityStable']:
            result['status'] = 'incomplete'
    except Exception:
        result['status'] = 'incomplete'
    finally:
        signal.alarm(0)
    print(json.dumps(result, separators=(',', ':')))
    return result
