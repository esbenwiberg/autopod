"""PROPOSED one-shot metadata read. Requires its own explicit approval.
Only fixed error aggregates, three named profile chains, and checkout identity leave VM.
No database write, raw logs, credentials, sandbox access, or service change.
"""
import datetime
import json
import os
import re
import selectors
import signal
import sqlite3
import subprocess
import time
from pathlib import Path

PROFILE_NAMES = ('luumi', 'dataverse-harness', 'teamplanner-pr-read')
SQLITE_ERROR_NAMES = frozenset(('SQLITE_ERROR', 'SQLITE_BUSY', 'SQLITE_LOCKED',
    'SQLITE_CORRUPT', 'SQLITE_NOTADB', 'SQLITE_FULL', 'SQLITE_IOERR', 'SQLITE_CANTOPEN',
    'SQLITE_CONSTRAINT', 'SQLITE_SCHEMA', 'SQLITE_INTERRUPT', 'SQLITE_READONLY'))


def bounded_command(args, limit=8192, seconds=10):
    data, reason = bytearray(), None
    with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}) as proc:
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


def label(value, maximum=80):
    return value if isinstance(value, str) and len(value) <= maximum and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', value) else None


def image_reference(value):
    if not isinstance(value, str) or len(value) > 256 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9./:_@-]*', value):
        return None
    if '@' in value and not re.fullmatch(r'[^@]+@sha256:[a-f0-9]{64}', value):
        return None
    return value


def endpoint(value):
    if not isinstance(value, str):
        return None
    return next((p for p in ('/pods/analytics/cost', '/pods')
                 if value == p or value.startswith(p + '?')), None)


def request_key(entry):
    pid, request_id = entry.get('pid'), entry.get('reqId')
    if type(pid) is int and isinstance(request_id, str) and 0 < len(request_id) <= 128:
        return pid, request_id
    return None


def stamp(entry):
    value = entry.get('time')
    return value if type(value) is int and 0 <= value < 10**16 else None


def aggregate_journal(raw):
    entries, unparsed = [], 0
    for line in raw.splitlines():
        try:
            entry = json.loads(line)
            if isinstance(entry, dict):
                entries.append(entry)
            else:
                unparsed += 1
        except (ValueError, TypeError):
            unparsed += 1
    requests, statuses = {}, {}
    for entry in entries:
        req = entry.get('req')
        route = endpoint(entry.get('path')) or endpoint(req.get('url') if isinstance(req, dict) else None)
        if not route:
            continue
        key, when = request_key(entry), stamp(entry)
        if key and when is not None:
            requests.setdefault(key, []).append((when, route))
        status = entry.get('status')
        if type(status) is int:
            category = '200' if status == 200 else '500' if status == 500 else 'other'
            key = route + ':' + category
            statuses[key] = statuses.get(key, 0) + 1
    groups = {}
    for entry in entries:
        err = entry.get('err')
        if not isinstance(err, dict):
            continue
        message, code, stack = (str(err.get(k, '')) for k in ('message', 'code', 'stack'))
        kind = code if code in SQLITE_ERROR_NAMES else None
        if not kind and ('JSON' in message or 'Unexpected token' in message or 'JSON.parse' in stack):
            kind = 'JSON_PARSE_ERROR'
        if not kind and ('No space left' in message or code == 'ENOSPC'):
            kind = 'ENOSPC'
        if not kind and ('Invalid string length' in message or 'Cannot create a string longer' in message or code == 'ERR_STRING_TOO_LONG'):
            kind = 'RESPONSE_SIZE_LIMIT'
        if not kind:
            kind = 'OTHER_ERROR'
        req = entry.get('req')
        route = endpoint(entry.get('path')) or endpoint(req.get('url') if isinstance(req, dict) else None)
        attribution = 'direct' if route else 'none'
        when = stamp(entry)
        if not route and when is not None:
            candidates = {p for t, p in requests.get(request_key(entry), []) if abs(t - when) <= 30000}
            if len(candidates) == 1:
                route, attribution = candidates.pop(), 'same_pid_request_within_30s'
        detail = next((value for phrase, value in (
            ('no such column:', 'missing_column'), ('no such table:', 'missing_table'),
            ('database or disk is full', 'disk_full'), ('database is locked', 'locked'),
            ('database disk image is malformed', 'malformed_database')) if phrase in message), None)
        key = (kind, route or 'unattributed', attribution, detail or 'unspecified')
        group = groups.setdefault(key, {'count': 0, 'firstTime': None, 'lastTime': None})
        group['count'] += 1
        if when is not None:
            group['firstTime'] = min(group['firstTime'], when) if group['firstTime'] is not None else when
            group['lastTime'] = max(group['lastTime'], when) if group['lastTime'] is not None else when
    return {'parsedLines': len(entries), 'unparsedLines': unparsed, 'statusCounts': statuses,
            'groups': [{'kind': k[0], 'endpoint': k[1], 'attribution': k[2], 'detail': k[3], **v}
                       for k, v in sorted(groups.items())], 'rootCauseAutomaticallyVerified': False}


def profile_projection(db):
    pending, seen, rows, missing = list(PROFILE_NAMES), set(), [], []
    while pending and len(seen) < 9:
        name = pending.pop(0)
        if name in seen:
            continue
        seen.add(name)
        row = db.execute('''SELECT substr(name,1,81), substr(extends,1,81), substr(execution_target,1,30),
                            substr(default_runtime,1,30), substr(warm_image_tag,1,257)
                            FROM profiles WHERE name=?''', (name,)).fetchone()
        if row is None:
            missing.append(name)
            continue
        parent = label(row[1])
        rows.append({'name': label(row[0]), 'extends': parent, 'target': label(row[2],29),
                     'runtime': label(row[3],29), 'warmImageTag': image_reference(row[4])})
        if parent and parent not in seen:
            pending.append(parent)
    return {'profiles': rows, 'missing': missing, 'unvisitedParents': len(set(pending) - seen)}


def inspect():
    raw, state = bounded_command(['systemctl', 'show', 'autopod-daemon', '--property=MainPID', '--value'])
    if state['exit'] != 0 or not raw.strip().isdigit():
        return {'status': 'pid_unavailable'}
    pid = int(raw.strip())
    cwd = Path('/proc/' + str(pid) + '/cwd').resolve(strict=True)
    if not re.fullmatch(r'/opt/autopod/releases/[a-f0-9]{8,40}/packages/daemon', str(cwd)):
        return {'status': 'release_identity_changed'}
    release = str(cwd.parents[1])
    git = ['git', '-c', 'safe.directory=' + release, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', release]
    sha, git_state = bounded_command(git + ['rev-parse', 'HEAD'])
    _, dirty = bounded_command(git + ['diff', '--no-ext-diff', '--no-textconv', '--quiet', 'HEAD', '--'])
    result = {'observedAtUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'pid': pid,
              'release': release, 'checkoutSha': sha.decode().strip() if git_state['exit'] == 0 and re.fullmatch(rb'[a-f0-9]{40}\n?', sha) else None,
              'checkoutRead': git_state, 'trackedCheckoutDirty': bool(dirty['exit']) if dirty['exit'] in (0, 1) else None,
              'loadedBytesAttested': False}
    database = Path('/data/autopod/autopod.db')
    expected, matched = (2049, 13107203), False
    info = database.stat()
    if (info.st_dev, info.st_ino) == expected:
        with os.scandir('/proc/' + str(pid) + '/fd') as files:
            for index, file in enumerate(files):
                if index >= 2048:
                    break
                try:
                    info = os.stat(file.path)
                    matched = matched or (info.st_dev, info.st_ino) == expected
                except OSError:
                    pass
    result['activeDatabaseMatched'] = matched
    if matched:
        db = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=1)
        try:
            db.execute('PRAGMA query_only=ON')
            deadline = time.monotonic() + 10
            db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
            result['affectedProfiles'] = profile_projection(db)
        finally:
            db.close()
    raw, state = bounded_command(['journalctl', '-u', 'autopod-daemon', '--since', '2026-09-07 00:00:00 UTC',
                                 '--until', '2026-09-08 00:00:00 UTC', '-n', '10000', '--no-pager', '-o', 'cat'], 2 * 1024**2, 10)
    result['historicalErrors'] = {**state, **aggregate_journal(raw)}
    result['processIdentityStableAtEnd'] = Path('/proc/' + str(pid) + '/cwd').resolve(strict=True) == cwd
    result['omittedErrorGroupsForTransport'] = 0
    result['omittedProfilesForTransport'] = 0
    encode = lambda: json.dumps(result, separators=(',', ':'), allow_nan=False)
    while len(encode().encode()) > 3500:
        if result['historicalErrors']['groups']:
            result['historicalErrors']['groups'].pop()
            result['omittedErrorGroupsForTransport'] += 1
        elif result.get('affectedProfiles', {}).get('profiles'):
            result['affectedProfiles']['profiles'].pop()
            result['omittedProfilesForTransport'] += 1
        else:
            return {'status': 'output_limit'}
    return result


def main():
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError()))
    signal.alarm(60)
    try:
        result = inspect()
    except Exception:
        result = {'status': 'inspection_incomplete'}
    finally:
        signal.alarm(0)
    print(json.dumps(result, separators=(',', ':'), allow_nan=False))


if __name__ == '__main__':
    main()
