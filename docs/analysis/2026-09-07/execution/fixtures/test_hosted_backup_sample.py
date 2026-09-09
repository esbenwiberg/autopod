"""Local SQLite fixtures only. No production main() or network execution."""
import importlib.util
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('sample', Path(__file__).with_name('verify-hosted-backup-sample.py'))
sample = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sample)


class IsolatedSample(unittest.TestCase):
    def fixture(self, directory):
        active = Path(directory) / 'active.db'
        backup = Path(directory) / 'backup.db'
        db = sqlite3.connect(active)
        db.executescript('CREATE TABLE pods(id TEXT PRIMARY KEY, updated_at TEXT); INSERT INTO pods VALUES("one", "2026-09-09T00:00:00Z");')
        db.close()
        shutil.copyfile(active, backup)
        return active, backup

    def test_copy_checks_and_private_write_leave_originals_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            active, backup = self.fixture(directory)
            before = (active.read_bytes(), backup.read_bytes())
            result = sample.verify(active, backup, Path(directory))
            self.assertEqual(result['status'], 'isolated_restore_verified')
            self.assertTrue(result['rollbackWriteProbeOk'])
            self.assertTrue(result['schemasMatch'])
            self.assertTrue(result['watermarksMatch'])
            self.assertFalse(result['creationProvenanceVerified'])
            self.assertFalse(result['watermarksAreFullContentEquality'])
            self.assertTrue(result['isolatedDirectoryRemoved'])
            self.assertEqual(before, (active.read_bytes(), backup.read_bytes()))
            self.assertEqual(sorted(p.name for p in Path(directory).iterdir()), ['active.db', 'backup.db'])

    def test_valid_restore_does_not_hide_newer_active_data(self):
        with tempfile.TemporaryDirectory() as directory:
            active, backup = self.fixture(directory)
            db = sqlite3.connect(active)
            db.execute('INSERT INTO pods VALUES(?,?)', ('two', '2026-09-09T01:00:00Z'))
            db.commit(); db.close()
            result = sample.verify(active, backup, Path(directory))
            self.assertEqual(result['status'], 'isolated_restore_verified')
            self.assertFalse(result['watermarksMatch'])
            self.assertTrue(result['isolatedDirectoryRemoved'])

    def test_corrupt_backup_is_incomplete_and_copy_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            active, backup = self.fixture(directory)
            backup.write_bytes(b'not a database')
            result = sample.verify(active, backup, Path(directory))
            self.assertEqual(result['status'], 'verification_incomplete')
            self.assertTrue(result['isolatedDirectoryRemoved'])
            self.assertEqual(backup.read_bytes(), b'not a database')

    def test_foreign_key_failure_cannot_pass_integrity_alone(self):
        with tempfile.TemporaryDirectory() as directory:
            active, backup = self.fixture(directory)
            db = sqlite3.connect(backup)
            db.executescript('CREATE TABLE child(id TEXT REFERENCES pods(id)); INSERT INTO child VALUES("missing");')
            db.close()
            result = sample.verify(active, backup, Path(directory))
            self.assertEqual(result['status'], 'verification_incomplete')
            self.assertTrue(result['isolatedDirectoryRemoved'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
