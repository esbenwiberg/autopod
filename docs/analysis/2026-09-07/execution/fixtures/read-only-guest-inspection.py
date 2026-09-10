"""Prepared metadata-only inspection; execute only after payload-specific approval.

Target: Azure VM autopod-daemon / ewi-sandboxes, via Azure Run Command.
No SSH, service changes, worker/provider calls, raw logs, rows, env or secrets.
Queries use the approved database only when the service PID has it open.
The output cap is 64 KiB; bounded/truncated evidence is explicitly incomplete.
"""
import datetime
import hashlib
import json
import os
import re
import selectors
import signal
import sqlite3
import subprocess
import time
from pathlib import Path

DATABASE = Path('/data/autopod/autopod.db')
BACKUPS = ('/data/autopod/backups', '/data/autopod/managed/backups',
           '/home/ewi/.autopod/backups')
SQLITE_ERROR_NAMES = frozenset(('SQLITE_ERROR', 'SQLITE_BUSY', 'SQLITE_LOCKED',
                                'SQLITE_CORRUPT', 'SQLITE_NOTADB', 'SQLITE_FULL',
                                'SQLITE_IOERR', 'SQLITE_CANTOPEN', 'SQLITE_CONSTRAINT',
                                'SQLITE_SCHEMA', 'SQLITE_INTERRUPT', 'SQLITE_READONLY'))
RELEASE_ROOTS = (Path('/opt/autopod/releases'), Path('/opt/autopod/managed/releases'))


def bounded_command(args, limit=8192, seconds=10):
    """Drain a bounded pipe, terminate only this task-owned command on its limit."""
    data = bytearray()
    reason = None
    with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as proc:
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + seconds
            while True:
                if time.monotonic() >= deadline:
                    reason = 'timeout'
                    break
                if not selector.select(min(.2, max(0, deadline - time.monotonic()))):
                    continue
                chunk = os.read(proc.stdout.fileno(), min(65536, limit + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > limit:
                    reason = 'byte_limit'
                    break
        if reason:
            proc.kill()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)
            reason = reason or 'exit_timeout'
        return bytes(data[:limit]), {'exit': proc.returncode, 'incomplete': reason,
                                    'bytesRead': len(data), 'byteLimit': limit}


def safe_error(entry):
    if not isinstance(entry, dict) or not isinstance(entry.get('err'), dict):
        return None
    err = entry['err']
    message, code, stack = (str(err.get(k, '')) for k in ('message', 'code', 'stack'))
    kind = code if code in SQLITE_ERROR_NAMES else None
    if not kind and ('JSON' in message or 'Unexpected token' in message or 'JSON.parse' in stack):
        kind = 'JSON_PARSE_ERROR'
    if not kind and ('No space left' in message or code == 'ENOSPC'):
        kind = 'ENOSPC'
    if not kind:
        return None
    # SQL identifiers can contain user data. Export only fixed error classes.
    detail = next((label for phrase, label in (
        ('no such column:', 'missing_column'), ('no such table:', 'missing_table'),
        ('database or disk is full', 'disk_full'), ('database is locked', 'locked'),
        ('database disk image is malformed', 'malformed_database')) if phrase in message), None)
    request = entry.get('req')
    url = request.get('url', '') if isinstance(request, dict) else ''
    endpoint = next((p for p in ('/pods/analytics/cost', '/pods')
                     if isinstance(url, str) and (url == p or url.startswith(p + '?'))), None)
    stamp = entry.get('time')
    return {'time': stamp if type(stamp) is int and 0 <= stamp < 10**16 else None,
            'kind': kind, 'detail': detail, 'endpoint': endpoint}


def directory_entries(root, limit=512):
    entries = []
    with os.scandir(root) as iterator:
        for entry in iterator:
            if len(entries) == limit:
                return entries, True
            entries.append(entry)
    return entries, False


def allowed_release(path):
    return any(path.is_relative_to(root) for root in RELEASE_ROOTS)


def inspect():
    out = {'payloadVersion': 2, 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    raw, result = bounded_command(['systemctl', 'show', 'autopod-daemon', '-p', 'MainPID', '--value'])
    if result['exit'] or result['incomplete'] or not re.fullmatch(rb'[1-9][0-9]{0,9}\s*', raw):
        return {**out, 'status': 'active_pid_unavailable'}
    pid = int(raw)
    raw, state = bounded_command(['systemctl', 'is-active', 'autopod-daemon'])
    state['active'] = raw.strip() == b'active'
    cwd = Path(os.readlink(f'/proc/{pid}/cwd')).resolve()
    out['service'] = {'pid': pid, 'state': state,
                      'cwd': str(cwd) if allowed_release(cwd) else None,
                      'cwdAllowed': allowed_release(cwd)}
    current = Path('/opt/autopod/current').resolve()
    out['currentRelease'] = str(current) if allowed_release(current) else None
    out['currentMatchesProcessCwd'] = current == cwd
    entries, truncated = directory_entries(Path(f'/proc/{pid}/fd'), 2048)
    matched = False
    descriptor_count = 0
    for entry in entries:
        try:
            target = os.readlink(entry.path)
            if target.endswith(('.db', '.db-wal', '.db-shm')):
                descriptor_count += 1
            if target == str(DATABASE):
                observed, expected = os.stat(entry.path), DATABASE.stat()
                matched = matched or (observed.st_dev, observed.st_ino) == (expected.st_dev, expected.st_ino)
        except OSError:
            continue
    out['databaseAdmission'] = {'approvedPath': str(DATABASE), 'openDescriptorMatch': matched,
                               'sqliteDescriptorCount': descriptor_count, 'fdInventoryTruncated': truncated}
    if matched:
        # Use live WAL semantics. Do not use immutable=1, which can hide current WAL data.
        deadline = time.monotonic() + 15
        db = sqlite3.connect(DATABASE.as_uri() + '?mode=ro', uri=True, timeout=1)
        try:
            db.execute('PRAGMA query_only=ON')
            db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
            stat = DATABASE.stat()
            out['database'] = {'path': str(DATABASE), 'device': stat.st_dev, 'inode': stat.st_ino,
                               'bytes': stat.st_size,
                               'schemaVersion': db.execute('SELECT MAX(version) FROM schema_version').fetchone()[0],
                               'appliedCount': db.execute('SELECT count(*) FROM schema_version').fetchone()[0],
                               'podCount': db.execute('SELECT count(*) FROM pods').fetchone()[0],
                               'quickCheckOk': db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'}
        except sqlite3.Error as error:
            out['databaseReadError'] = getattr(error, 'sqlite_errorname', 'SQLITE_ERROR')
        finally:
            db.close()
    out['migrationFiles'] = []
    if allowed_release(cwd):
        for relative in ('packages/daemon/src/db/migrations', 'packages/daemon/dist/db/migrations', 'dist/db/migrations'):
            directory = (cwd / relative).resolve()
            if not directory.is_relative_to(cwd) or not directory.is_dir():
                continue
            entries, truncated = directory_entries(directory, 256)
            out['migrationInventoryTruncated'] = truncated
            total = 0
            for entry in sorted(entries, key=lambda e: e.name):
                if not re.fullmatch(r'[0-9]{3}_[A-Za-z0-9_-]+\.sql', entry.name) or entry.is_symlink():
                    continue
                size = entry.stat().st_size
                total += size
                if size > 1024**2 or total > 8 * 1024**2:
                    out['migrationInventoryTruncated'] = True
                    break
                with open(entry.path, 'rb') as source:
                    content = source.read(1024**2 + 1)
                if len(content) != size:
                    out['migrationInventoryTruncated'] = True
                    break
                out['migrationFiles'].append({'name': entry.name, 'bytes': size,
                                               'sha256': hashlib.sha256(content).hexdigest()})
            break
    out['backupInventory'] = []
    for root in map(Path, BACKUPS):
        item = {'root': str(root), 'exists': root.is_dir()}
        if root.is_dir():
            entries, truncated = directory_entries(root)
            files = [(entry, entry.stat()) for entry in entries
                     if not entry.is_symlink() and entry.is_file()]
            item.update(truncated=truncated, latestFiles=[
                {'name': e.name[:256], 'bytes': s.st_size, 'mtimeEpoch': s.st_mtime}
                for e, s in sorted(files, key=lambda pair: pair[1].st_mtime, reverse=True)[:20]])
        out['backupInventory'].append(item)
    out['filesystems'] = []
    for root in ('/', '/data/autopod'):
        fs = os.statvfs(root)
        out['filesystems'].append({'path': root, 'capacityBytes': fs.f_blocks * fs.f_frsize,
                                   'availableBytes': fs.f_bavail * fs.f_frsize})
    logs, evidence = bounded_command(['journalctl', '-u', 'autopod-daemon', '--since', '24 hours ago',
                                     '-n', '10000', '--no-pager', '-o', 'cat'], 2 * 1024**2, 10)
    errors, unparsed, matches = [], 0, 0
    for line in logs.splitlines():
        try:
            error = safe_error(json.loads(line))
        except (ValueError, TypeError):
            unparsed += 1
            continue
        if error:
            matches += 1
            errors = (errors + [error])[-100:]
    out['logEvidence'] = {**evidence, 'unparsedLines': unparsed, 'matchingCount': matches,
                          'errors': errors, 'absenceDoesNotProveApiHealth': True}
    final_pid, pid_check = bounded_command(['systemctl', 'show', 'autopod-daemon', '-p', 'MainPID', '--value'])
    out['serviceIdentityStableAtEnd'] = not pid_check['incomplete'] and final_pid.strip() == str(pid).encode()
    if 'database' in out:
        final_stat = DATABASE.stat()
        out['databaseIdentityStableAtEnd'] = (final_stat.st_dev, final_stat.st_ino) == (out['database']['device'], out['database']['inode'])
    return out


def main():
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError()))
    signal.alarm(60)
    try:
        result = inspect()
    except Exception:
        result = {'payloadVersion': 2, 'status': 'inspection_incomplete'}
    encoded = json.dumps(result, allow_nan=False)
    if len(encoded.encode()) > 65536:
        encoded = json.dumps({'payloadVersion': 2, 'status': 'metadata_output_limit'})
    print(encoded)


if __name__ == '__main__':
    main()
