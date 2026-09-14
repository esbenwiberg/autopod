"""Detached, one-start supervisor for deterministic managed validation commands."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import time


def atomic(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, sort_keys=True, separators=(',', ':'))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def tree_manifest(root):
    values = []
    for directory, dirs, files in os.walk(root, topdown=True, followlinks=False):
        dirs[:] = sorted(name for name in dirs if name not in ('.git', 'node_modules'))
        relative_directory = os.path.relpath(directory, root)
        for name in sorted(files):
            path = Path(directory) / name
            relative = name if relative_directory == '.' else relative_directory + '/' + name
            item = os.lstat(path)
            if stat.S_ISLNK(item.st_mode):
                values.append([relative, 'link', os.readlink(path)])
            elif stat.S_ISREG(item.st_mode):
                digest = hashlib.sha256()
                with path.open('rb') as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(chunk)
                values.append([relative, 'file', digest.hexdigest(), bool(item.st_mode & 0o111)])
            else:
                raise RuntimeError('unsupported-source-entry')
    return values


def prepare_workspace(source, workspace, dependency_cache, worker_uid, worker_gid):
    if workspace.exists():
        shutil.rmtree(workspace)
    shutil.copytree(
        source,
        workspace,
        symlinks=True,
        ignore=lambda _directory, names: {name for name in names if name in ('.git', 'node_modules')},
    )
    for directory, dirs, files in os.walk(workspace, topdown=True, followlinks=False):
        os.chown(directory, worker_uid, worker_gid)
        os.chmod(directory, 0o700)
        for name in dirs + files:
            path = os.path.join(directory, name)
            item = os.lstat(path)
            if stat.S_ISLNK(item.st_mode):
                os.lchown(path, worker_uid, worker_gid)
            else:
                os.chown(path, worker_uid, worker_gid)
                os.chmod(path, 0o700 if stat.S_ISDIR(item.st_mode) or item.st_mode & 0o111 else 0o600)
    if dependency_cache:
        target = Path(dependency_cache)
        item = target.stat()
        if not target.is_absolute() or not stat.S_ISDIR(item.st_mode) or item.st_uid != 0 or item.st_mode & 0o022:
            raise RuntimeError('dependency-cache-untrusted')
        link = workspace / 'node_modules'
        link.symlink_to(target, target_is_directory=True)
        os.lchown(link, worker_uid, worker_gid)


def terminate(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    except ProcessLookupError:
        process.wait()
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def supervise(root, clock=time.time, monotonic=time.monotonic):
    spec = json.loads((root / 'launch.json').read_text())
    lock = (root / 'launch.lock').open('a')
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    receipt = root / 'execution.json'
    if receipt.exists():
        return
    phases = [{'phase': phase['phase'], 'status': 'not-run', 'durationMs': 0} for phase in spec['phases']]
    state = {
        'specDigest': spec['specDigest'],
        'configurationDigest': spec['configurationDigest'],
        'candidateDigest': spec['candidateDigest'],
        'newCommit': spec['newCommit'],
        'state': 'claimed',
        'observedExit': False,
        'startedAt': int(clock()),
        'completedAt': 0,
        'phases': phases,
        'result': 'running',
        'reason': '',
    }
    atomic(receipt, state)
    source = Path(spec['source']).resolve()
    workspace = Path(spec['workspace']).resolve()
    try:
        expected = tree_manifest(source)
        prepare_workspace(source, workspace, spec.get('dependencyCache'), spec['workerUid'], spec['workerGid'])
    except (OSError, RuntimeError, ValueError) as error:
        preparation_reason = ('dependency-cache-untrusted'
                              if str(error) == 'dependency-cache-untrusted'
                              else 'workspace-preparation-failed')
        atomic(receipt, {**state, 'state': 'stopped', 'observedExit': True,
                         'completedAt': int(clock()), 'result': 'unavailable',
                         'reason': preparation_reason})
        return
    state['state'] = 'running'
    atomic(receipt, state)
    result = 'passed'
    reason = ''
    for index, phase in enumerate(spec['phases']):
        now = clock()
        if now >= spec['expiresAt']:
            result, reason = 'unavailable', 'expired'
            break
        if (root / 'revoked').exists():
            result, reason = 'unavailable', 'revoked'
            break
        phases[index] = {**phases[index], 'status': 'running'}
        atomic(receipt, state)
        started = monotonic()

        def isolate():
            os.setsid()
            if sys.platform == 'linux':
                import ctypes
                if ctypes.CDLL(None).prctl(38, 1, 0, 0, 0) != 0:
                    raise RuntimeError('no-new-privileges-unavailable')
            if os.getuid() == 0:
                os.setgroups([])
                os.setgid(spec['workerGid'])
                os.setuid(spec['workerUid'])

        try:
            process = subprocess.Popen(
                ['/bin/sh', '-c', phase['command']], cwd=phase['cwd'],
                env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp', 'TMPDIR': '/tmp'},
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                preexec_fn=isolate,
            )
        except (OSError, RuntimeError, subprocess.SubprocessError):
            phases[index] = {**phases[index], 'status': 'failed'}
            result, reason = 'unavailable', 'command-start-failed'
            atomic(receipt, state)
            break
        phase_reason = ''
        phase_deadline = min(spec['expiresAt'], now + phase['timeoutMs'] / 1000)
        while process.poll() is None:
            if clock() >= phase_deadline:
                phase_reason = 'expired' if clock() >= spec['expiresAt'] else 'phase-timeout'
            elif (root / 'revoked').exists():
                phase_reason = 'revoked'
            if phase_reason:
                terminate(process)
                break
            time.sleep(0.05)
        terminate(process)
        duration = max(0, int((monotonic() - started) * 1000))
        passed = process.returncode == 0 and not phase_reason
        phases[index] = {**phases[index], 'status': 'passed' if passed else 'failed', 'durationMs': duration}
        atomic(receipt, state)
        if not passed:
            result = 'unavailable' if phase_reason in ('expired', 'revoked') else 'failed'
            reason = phase_reason or 'command-failed'
            break
    if result == 'passed':
        try:
            actual = tree_manifest(workspace)
            actual_by_path = {entry[0]: entry for entry in actual}
            if any(actual_by_path.get(entry[0]) != entry for entry in expected):
                result, reason = 'failed', 'source-mutated'
        except (OSError, RuntimeError, ValueError):
            result, reason = 'failed', 'source-mutated'
    atomic(receipt, {**state, 'state': 'stopped', 'observedExit': True,
                     'completedAt': int(clock()), 'result': result, 'reason': reason})


if __name__ == '__main__':
    directory = Path(sys.argv[1]).resolve()
    if '--detach' in sys.argv:
        if os.fork():
            sys.exit(0)
        os.setsid()
        if os.fork():
            os._exit(0)
        with open(os.devnull, 'rb', 0) as source, open(os.devnull, 'ab', 0) as sink:
            os.dup2(source.fileno(), 0)
            os.dup2(sink.fileno(), 1)
            os.dup2(sink.fileno(), 2)
    supervise(directory)
