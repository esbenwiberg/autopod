"""PROPOSED metadata read for runtime/canary discovery and September 7 errors.
Requires explicit approval. No raw environment, profiles, logs or credentials exported.
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
from urllib.parse import urlsplit

SQLITE_ERROR_NAMES = frozenset(('SQLITE_ERROR', 'SQLITE_BUSY', 'SQLITE_LOCKED',
    'SQLITE_CORRUPT', 'SQLITE_NOTADB', 'SQLITE_FULL', 'SQLITE_IOERR', 'SQLITE_CANTOPEN',
    'SQLITE_CONSTRAINT', 'SQLITE_SCHEMA', 'SQLITE_INTERRUPT', 'SQLITE_READONLY'))

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


def label(value, maximum=90):
    return value if isinstance(value, str) and len(value) <= maximum and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', value) else None


def image_reference(value):
    if not isinstance(value, str) or len(value) > 256 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9./:_@-]*', value):
        return None
    if '@' in value and not re.fullmatch(r'[^@]+@sha256:[a-f0-9]{64}', value):
        return None
    return value


def selected_environment(raw):
    fields = {}
    for item in raw.split(b'\0'):
        key, separator, value = item.partition(b'=')
        if not separator:
            continue
        if key in (b'AZURE_SUBSCRIPTION_ID', b'AZURE_RESOURCE_GROUP', b'AZURE_SANDBOX_GROUP',
                   b'SANDBOX_GROUP', b'AZURE_SANDBOX_LOCATION', b'AZURE_LOCATION',
                   b'AZURE_SANDBOX_TIER', b'SANDBOX_TIER'):
            fields[key.decode()] = label(value.decode('utf-8', errors='replace'))
        elif key == b'ACR_REGISTRY_URL':
            text = value.decode('utf-8', errors='replace')
            parts = urlsplit(text if '://' in text else '//' + text)
            fields['ACR_REGISTRY_HOST'] = parts.hostname if (len(text) <= 256 and not parts.username
                and not parts.password and not parts.query and not parts.fragment
                and parts.path in ('', '/') and parts.scheme in ('', 'https')
                and parts.hostname and parts.hostname.endswith('.azurecr.io')) else None
    return fields


def inspect():
    raw, status = bounded_command(['systemctl', 'show', 'autopod-daemon', '-p', 'MainPID', '--value'])
    if status['exit'] or status['incomplete'] or not re.fullmatch(rb'[1-9][0-9]{0,9}\s*', raw):
        return {'status': 'active_pid_unavailable'}
    pid = int(raw)
    cwd = Path(os.readlink('/proc/' + str(pid) + '/cwd')).resolve()
    if not any(cwd.is_relative_to(Path(root)) for root in ('/opt/autopod/releases', '/opt/autopod/managed/releases')):
        return {'status': 'release_path_unavailable'}
    result = {'observedAtUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'pid': pid, 'cwd': str(cwd)}
    raw, state = bounded_command(['git', '-C', str(cwd), 'rev-parse', 'HEAD'])
    result['checkoutSha'] = raw.strip().decode() if not state['exit'] and re.fullmatch(rb'[a-f0-9]{40}\s*', raw) else None
    raw, state = bounded_command(['git', '-C', str(cwd), 'status', '--porcelain', '--untracked-files=no'])
    result['trackedCheckoutDirty'] = bool(raw) if not state['exit'] and not state['incomplete'] else None
    bundle = (cwd / 'dist/index.js').resolve()
    if bundle.is_relative_to(cwd) and bundle.is_file():
        with bundle.open('rb') as file:
            data = file.read(8 * 1024**2 + 1)
        result['onDiskEntryBundleSha256'] = hashlib.sha256(data).hexdigest() if len(data) <= 8 * 1024**2 else None
    result['loadedBytesAttested'] = False
    result['nodeVersion'] = None
    if Path(os.readlink('/proc/' + str(pid) + '/exe')).name == 'node':
        raw, state = bounded_command(['/proc/' + str(pid) + '/exe', '--version'])
        result['nodeVersion'] = raw.strip().decode() if not state['exit'] and re.fullmatch(rb'v[0-9]+\.[0-9]+\.[0-9]+\s*', raw) else None
    with open('/proc/' + str(pid) + '/environ', 'rb') as file:
        env = file.read(65537)
    result['configuredTarget'] = selected_environment(env) if len(env) <= 65536 else {'status': 'environment_limit'}
    database = Path('/data/autopod/autopod.db')
    expected = (2049, 13107203)
    info = database.stat()
    matched = False
    if (info.st_dev, info.st_ino) == expected:
        with os.scandir('/proc/' + str(pid) + '/fd') as entries:
            for index, entry in enumerate(entries):
                if index >= 2048:
                    break
                try:
                    info = os.stat(entry.path)
                    matched = matched or (info.st_dev, info.st_ino) == expected
                except OSError:
                    continue
    result['activeDatabaseMatched'] = matched
    if matched:
        db = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=1)
        try:
            db.execute('PRAGMA query_only=ON')
            deadline = time.monotonic() + 10
            db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
            rows = db.execute('''SELECT substr(name,1,81), substr(extends,1,81), substr(execution_target,1,30),
                                substr(default_runtime,1,30), substr(warm_image_tag,1,257)
                                FROM profiles ORDER BY name LIMIT 21''').fetchall()
            result['profileInventoryMoreThan20'] = len(rows) > 20
            result['profileImages'] = [{'name':label(row[0],80),'extends':label(row[1],80),
                                       'target':label(row[2],29),'runtime':label(row[3],29),
                                       'warmImageTag':image_reference(row[4])} for row in rows[:20]]
        except sqlite3.Error:
            result['profileMetadataStatus'] = 'unavailable'
        finally:
            db.close()
    raw, state = bounded_command(['journalctl', '-u', 'autopod-daemon', '--since', '2026-09-07 00:00:00 UTC',
                                  '--until', '2026-09-08 00:00:00 UTC', '-n', '10000', '--no-pager', '-o', 'cat'],
                                 2 * 1024**2, 10)
    errors, unparsed, matching = [], 0, 0
    for line in raw.splitlines():
        try:
            error = safe_error(json.loads(line))
        except (ValueError, TypeError):
            unparsed += 1
            continue
        if error:
            errors = (errors + [error])[-30:]
            matching += 1
    result['historicalErrors'] = {**state, 'unparsedLines': unparsed, 'matchingCount': matching,
                                  'errors': errors, 'absenceProvesRootCause': False}
    result['omittedProfilesForTransport'] = 0
    result['omittedErrorsForTransport'] = max(0, matching - len(errors))
    encode = lambda: json.dumps(result, separators=(',', ':'), allow_nan=False)
    while len(encode().encode()) > 3500:
        if result.get('profileImages'):
            result['profileImages'].pop()
            result['omittedProfilesForTransport'] += 1
        elif errors:
            errors.pop(0)
            result['omittedErrorsForTransport'] += 1
        else:
            return {'status': 'metadata_output_limit'}
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
