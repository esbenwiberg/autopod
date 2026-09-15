"""Detached, one-start supervisor for deterministic managed validation commands."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
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


def prepare_git_metadata(source, target_git, expected_commit):
    supervisor_uid = os.getuid()
    supervisor_gid = os.getgid()
    if not isinstance(expected_commit, str) or not re.fullmatch(r'[a-f0-9]{40}', expected_commit):
        raise RuntimeError('source-git-metadata-untrusted')
    source_git = source / '.git'
    source_git_item = os.lstat(source_git)
    if not stat.S_ISDIR(source_git_item.st_mode):
        raise RuntimeError('source-git-metadata-untrusted')
    for directory, dirs, files in os.walk(source_git, topdown=True, followlinks=False):
        for name in dirs:
            item = os.lstat(Path(directory) / name)
            if not stat.S_ISDIR(item.st_mode):
                raise RuntimeError('source-git-metadata-untrusted')
        for name in files:
            item = os.lstat(Path(directory) / name)
            if not stat.S_ISREG(item.st_mode) or item.st_nlink != 1:
                raise RuntimeError('source-git-metadata-untrusted')
    if (source_git / 'objects/info/alternates').exists():
        raise RuntimeError('source-git-metadata-untrusted')
    head = source_git / 'HEAD'
    index = source_git / 'index'
    objects = source_git / 'objects'
    if (
        not head.is_file()
        or head.read_text().strip() != expected_commit
        or not index.is_file()
        or not objects.is_dir()
    ):
        raise RuntimeError('source-git-metadata-untrusted')

    target_git.mkdir(mode=0o755)
    (target_git / 'refs/heads').mkdir(parents=True)
    (target_git / 'refs/tags').mkdir(parents=True)
    shutil.copyfile(head, target_git / 'HEAD')
    shutil.copyfile(index, target_git / 'index')
    shutil.copytree(objects, target_git / 'objects', copy_function=shutil.copyfile)
    shallow = source_git / 'shallow'
    if shallow.exists():
        shutil.copyfile(shallow, target_git / 'shallow')
    (target_git / 'config').write_text(
        '[core]\n'
        '\trepositoryformatversion = 0\n'
        '\tfilemode = true\n'
        '\tbare = false\n'
        '\tlogallrefupdates = false\n'
        '\thooksPath = /dev/null\n'
        '\tfsmonitor = false\n'
        '[credential]\n'
        '\thelper =\n'
        '[protocol "ext"]\n'
        '\tallow = never\n'
        '[http]\n'
        '\tfollowRedirects = false\n',
    )
    for directory, dirs, files in os.walk(target_git, topdown=False, followlinks=False):
        for name in files:
            os.chown(Path(directory) / name, supervisor_uid, supervisor_gid)
            os.chmod(Path(directory) / name, 0o444)
        for name in dirs:
            os.chown(Path(directory) / name, supervisor_uid, supervisor_gid)
            os.chmod(Path(directory) / name, 0o555)
    os.chown(target_git, supervisor_uid, supervisor_gid)
    os.chmod(target_git, 0o555)


def prepare_workspace(source, workspace, git_metadata, dependency_cache, worker_uid, worker_gid,
                      expected_commit):
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
    prepare_git_metadata(source, git_metadata, expected_commit)
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
    git_metadata = root / 'git'
    try:
        expected = tree_manifest(source)
        prepare_workspace(source, workspace, git_metadata, spec.get('dependencyCache'),
                          spec['workerUid'], spec['workerGid'], spec['newCommit'])
        os.chmod(root, 0o711)
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
                env={
                    'PATH': '/usr/local/bin:/usr/bin:/bin',
                    'HOME': '/tmp',
                    'TMPDIR': '/tmp',
                    'GIT_CONFIG_NOSYSTEM': '1',
                    'GIT_CONFIG_GLOBAL': '/dev/null',
                    'GIT_CONFIG_COUNT': '1',
                    'GIT_CONFIG_KEY_0': 'safe.directory',
                    'GIT_CONFIG_VALUE_0': str(workspace),
                    'GIT_DIR': str(git_metadata),
                    'GIT_TERMINAL_PROMPT': '0',
                    'GIT_NO_REPLACE_OBJECTS': '1',
                    'GIT_OPTIONAL_LOCKS': '0',
                    'GIT_WORK_TREE': str(workspace),
                },
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
