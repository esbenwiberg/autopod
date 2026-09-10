"""PROPOSED next action. Requires explicit isolated restore/data-handling approval.

One existing backup is copied to a private on-VM directory, checked, then removed.
No database/backup bytes or rows are exported. No production files are changed.
"""
import datetime
import hashlib
import json
import os
import shutil
import signal
import sqlite3
import stat
import subprocess
import tempfile
import time
from pathlib import Path

ACTIVE = Path('/data/autopod/autopod.db')
BACKUPS = Path('/data/autopod/backups')
EXPECTED_IDENTITY = (2049, 13107203)
MAX_BYTES = 1024**3


def fingerprint(db):
    schema = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()
    digest = lambda value: hashlib.sha256(json.dumps(value, separators=(',', ':'),
                                                     ensure_ascii=True).encode()).hexdigest()
    rows = []
    tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
    if len(tables) > 256:
        raise ValueError('table_limit')
    for (name,) in tables:
        quoted = '"' + name.replace('"', '""') + '"'
        columns = {row[1] for row in db.execute('PRAGMA table_info(' + quoted + ')')}
        newest = 'MAX(updated_at)' if 'updated_at' in columns else 'NULL'
        count, updated = db.execute('SELECT COUNT(*),' + newest + ' FROM ' + quoted).fetchone()
        rows.append((name, count, updated))
    return {'schemaSha256': digest(schema), 'watermarkSha256': digest(rows), 'tableCount': len(rows)}


def connect_readonly(path, deadline):
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=1)
    db.execute('PRAGMA query_only=ON')
    db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
    return db


def verify(active, backup, parent):
    """Parameterized only for local tests; main pins the production target paths."""
    deadline = time.monotonic() + 150
    before = backup.stat()
    if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_BYTES:
        raise ValueError('backup_file_limit')
    if os.statvfs(parent).f_bavail * os.statvfs(parent).f_frsize < 2 * before.st_size + 128 * 1024**2:
        raise ValueError('headroom_unavailable')
    directory = Path(tempfile.mkdtemp(prefix='autopod-verify-', dir=parent))
    result = {'status': 'verification_incomplete', 'creationProvenanceVerified': False,
              'scope': 'Existing backup restore and current database schema/watermark comparison; no invented creation receipt.'}
    try:
        restored = directory / 'restored.db'
        checksum = hashlib.sha256()
        copied = 0
        with os.fdopen(os.open(backup, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source, restored.open('xb') as target:
            opened = os.fstat(source.fileno())
            if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) != (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns):
                raise ValueError('backup_identity_changed')
            while chunk := source.read(1024**2):
                copied += len(chunk)
                if copied > before.st_size or time.monotonic() > deadline:
                    raise ValueError('copy_limit')
                checksum.update(chunk)
                target.write(chunk)
            target.flush()
            os.fsync(target.fileno())
            after = os.fstat(source.fileno())
            if copied != before.st_size or (after.st_size, after.st_mtime_ns) != (before.st_size, before.st_mtime_ns):
                raise ValueError('backup_changed_during_copy')
        copied_hash = hashlib.sha256()
        with restored.open('rb') as source:
            while chunk := source.read(1024**2):
                if time.monotonic() > deadline:
                    raise ValueError('checksum_timeout')
                copied_hash.update(chunk)
        if copied_hash.digest() != checksum.digest():
            raise ValueError('copy_checksum_mismatch')
        db = sqlite3.connect(str(restored), timeout=1)
        db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        try:
            if db.execute('PRAGMA integrity_check').fetchone() != ('ok',):
                raise ValueError('integrity_failed')
            if db.execute('PRAGMA foreign_key_check').fetchone() is not None:
                raise ValueError('foreign_keys_failed')
            restored_fingerprint = fingerprint(db)
            db.execute('BEGIN')
            db.execute('CREATE TABLE autopod_isolated_restore_probe (id INTEGER)')
            db.execute('ROLLBACK')
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='autopod_isolated_restore_probe'").fetchone():
                raise ValueError('probe_rollback_failed')
        finally:
            db.close()
        source = connect_readonly(active, deadline)
        try:
            source.execute('BEGIN')
            active_fingerprint = fingerprint(source)
        finally:
            source.close()
        result.update(status='isolated_restore_verified', backupBytes=copied,
                      backupSha256=checksum.hexdigest(), copiedChecksumMatches=True,
                      integrityOk=True, foreignKeysOk=True, rollbackWriteProbeOk=True,
                      backupFingerprint=restored_fingerprint, activeFingerprint=active_fingerprint,
                      schemasMatch=restored_fingerprint['schemaSha256'] == active_fingerprint['schemaSha256'],
                      watermarksMatch=restored_fingerprint['watermarkSha256'] == active_fingerprint['watermarkSha256'],
                      watermarksAreFullContentEquality=False)
    except Exception:
        result = {'status': 'verification_incomplete', 'creationProvenanceVerified': False}
    finally:
        signal.alarm(0)
        try:
            shutil.rmtree(directory)
        except OSError:
            result['cleanupPendingPath'] = str(directory)
    result['isolatedDirectoryRemoved'] = not directory.exists()
    return result


def main():
    # Time limit applies to this task-owned verification, never the daemon process.
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError()))
    signal.alarm(180)
    output = {'status': 'verification_incomplete'}
    try:
        identity = ACTIVE.stat()
        if (identity.st_dev, identity.st_ino) != EXPECTED_IDENTITY:
            raise ValueError('active_identity_changed')
        pid = int(subprocess.check_output(['systemctl', 'show', 'autopod-daemon', '-p', 'MainPID', '--value'],
                                         timeout=10, stderr=subprocess.DEVNULL))
        matched = False
        with os.scandir('/proc/' + str(pid) + '/fd') as descriptors:
            for index, entry in enumerate(descriptors):
                if index >= 2048:
                    raise ValueError('descriptor_limit')
                try:
                    observed = os.stat(entry.path)
                    matched = matched or ((observed.st_dev, observed.st_ino) == EXPECTED_IDENTITY)
                except OSError:
                    continue
        if not matched:
            raise ValueError('active_descriptor_unverified')
        candidates = []
        with os.scandir(BACKUPS) as entries:
            for index, entry in enumerate(entries):
                if index >= 512:
                    raise ValueError('backup_inventory_limit')
                if entry.is_symlink() or not entry.name.endswith('.db') or not entry.name[:-3].isdigit():
                    continue
                info = entry.stat()
                age = time.time() - info.st_mtime
                if 60 <= age <= 1800 and 0 < info.st_size <= MAX_BYTES:
                    candidates.append((info.st_mtime, Path(entry.path)))
        if not candidates:
            raise ValueError('fresh_stable_backup_unavailable')
        backup = max(candidates)[1]
        output = verify(ACTIVE, backup, ACTIVE.parent)
        after = ACTIVE.stat()
        output.update(backupFile=backup.name, observedAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      activeIdentityStableAtEnd=(after.st_dev, after.st_ino) == EXPECTED_IDENTITY)
    except Exception:
        output = {'status': 'verification_incomplete', 'productionDatabaseWriteRequested': False}
    finally:
        signal.alarm(0)
    print(json.dumps(output, separators=(',', ':'), allow_nan=False))


if __name__ == '__main__':
    main()
