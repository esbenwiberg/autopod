"""Proposed read-only VM inspection. Requires explicit payload-egress approval.

Run over existing SSH as sudo python3 on stdin. No remote writes, cleanup,
service changes, worker starts, or provider calls. Output is limited to selected
service/database identity, migration hashes, backup file metadata, filesystem
capacity, and sanitized SQLite/JSON error metadata. No row contents, source
contents, raw logs, environment variables, credentials, or backup data leave VM.
"""
import datetime
import hashlib
import json
import os
import re
import sqlite3
import subprocess
from pathlib import Path


def command(args):
    return subprocess.check_output(args, text=True, timeout=30, stderr=subprocess.DEVNULL).strip()


out = {'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
pid = int(command(['systemctl', 'show', 'autopod-daemon', '-p', 'MainPID', '--value']))
out['service'] = {'pid': pid, 'state': command(['systemctl', 'is-active', 'autopod-daemon']),
                  'release': str(Path('/opt/autopod/current').resolve())}
paths = []
for fd in list(Path(f'/proc/{pid}/fd').iterdir())[:2048]:
    try:
        name = os.readlink(fd)
        if name.endswith(('.db', '.db-wal', '.db-shm')):
            paths.append(name)
    except OSError:
        pass
out['activeSqliteDescriptors'] = sorted(set(paths))
file = Path('/data/autopod/autopod.db')
db = sqlite3.connect(f'file:{file}?mode=ro', uri=True)
db.execute('PRAGMA query_only=ON')
out['database'] = {'path': str(file), 'size': file.stat().st_size,
    'schemaVersion': db.execute('SELECT MAX(version) FROM schema_version').fetchone()[0],
    'appliedCount': db.execute('SELECT count(*) FROM schema_version').fetchone()[0],
    'quickCheck': db.execute('PRAGMA quick_check').fetchone()[0],
    'podCount': db.execute('SELECT count(*) FROM pods').fetchone()[0]}
out['managedTables'] = [r[0] for r in db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'managed_%' ORDER BY name")]
db.close()
root = Path('/opt/autopod/managed/releases/a2d14f4a34b39604')
out['managedMigrationFiles'] = [
    {'name': p.name, 'path': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
    for p in root.rglob('*.sql') if re.match(r'1(?:4[2-9]|50)_', p.name)]
out['backupInventory'] = []
for root in map(Path, ['/data/autopod/backups', '/data/autopod/managed/backups', '/home/ewi/.autopod/backups']):
    files = sorted([p for p in root.glob('*') if p.is_file()],
                   key=lambda p: p.stat().st_mtime, reverse=True)[:20]
    out['backupInventory'].append({'root': str(root), 'exists': root.exists(), 'latestFiles': [
        {'name': p.name, 'bytes': p.stat().st_size,
         'mtime': datetime.datetime.fromtimestamp(p.stat().st_mtime, datetime.timezone.utc).isoformat()}
        for p in files]})
fs = os.statvfs('/')
out['rootFilesystem'] = {'capacityBytes': fs.f_blocks * fs.f_frsize,
                         'availableBytes': fs.f_bavail * fs.f_frsize}
logs = subprocess.run(['journalctl', '-u', 'autopod-daemon', '--since', '2026-09-01',
                       '-n', '30000', '--no-pager', '-o', 'cat'],
                      capture_output=True, text=True, timeout=30)
errors = []
unparsed = 0
for line in logs.stdout.splitlines():
    try:
        entry = json.loads(line)
    except (ValueError, TypeError):
        unparsed += 1
        continue
    if not isinstance(entry, dict) or not isinstance(entry.get('err'), dict):
        continue
    err = entry['err']
    message, code, stack = str(err.get('message', '')), str(err.get('code', '')), str(err.get('stack', ''))
    kind = None
    if re.fullmatch(r'SQLITE_[A-Z_]+', code):
        kind = code
    elif 'JSON' in message or 'Unexpected token' in message or 'JSON.parse' in stack:
        kind = 'JSON_PARSE_ERROR'
    elif 'No space left' in message or code == 'ENOSPC':
        kind = 'ENOSPC'
    if not kind:
        continue
    safe = None
    if re.fullmatch(r'no such (?:column|table): [A-Za-z0-9_.]{1,100}', message):
        safe = message
    if message in ['database or disk is full', 'database is locked', 'database disk image is malformed']:
        safe = message
    request = entry.get('req', {})
    url = request.get('url', '') if isinstance(request, dict) else ''
    endpoint = '/pods/analytics/cost' if str(url).startswith('/pods/analytics/cost') else '/pods' if str(url).startswith('/pods') else None
    timestamp = entry.get('time')
    errors.append({'time': timestamp if isinstance(timestamp, (int, float)) else None,
                   'kind': kind, 'message': safe, 'endpoint': endpoint})
out['logEvidence'] = {'commandExit': logs.returncode, 'boundedLines': 30000,
    'unparsedLines': unparsed, 'matchingErrors': errors[-100:], 'matchingErrorCount': len(errors)}
print(json.dumps(out, indent=2))
