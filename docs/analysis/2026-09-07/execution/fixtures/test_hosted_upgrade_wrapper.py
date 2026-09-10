"""Local-only watchdog, redaction, packaging and actual candidate-copy tests."""
import base64
import importlib.util
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import zlib
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[4]
spec = importlib.util.spec_from_file_location('wrapper', HERE / 'hosted-upgrade-wrapper.py')
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
PACKAGE = pathlib.Path(os.environ['UPGRADE_PACKAGE'])
NODE = pathlib.Path(shutil.which('node')).resolve()
MODULES = ROOT / 'packages/daemon/node_modules'


def package_entries():
    return {str(p.relative_to(PACKAGE)): base64.b64encode(p.read_bytes()).decode()
            for p in PACKAGE.rglob('*') if p.is_file() and
            (p.name in w.ARTIFACTS | {'manifest.json'} or p.parent.name == 'migrations')}


def payload(entries):
    raw = zlib.compress(json.dumps(entries, separators=(',', ':')).encode(), 9)
    return base64.b64encode(raw).decode(), w.digest(raw)


class WrapperTests(unittest.TestCase):
    def test_package_hash_and_traversal_refusals(self):
        encoded, sha = payload(package_entries())
        files = w.unpack_payload(encoded, sha)
        self.assertIn('candidate-migrations.mjs', files)
        with self.assertRaises(ValueError):
            w.unpack_payload(encoded, '0' * 64)
        entries = package_entries()
        entries['../escape'] = base64.b64encode(b'no').decode()
        with self.assertRaisesRegex(ValueError, 'entry_name'):
            w.unpack_payload(*payload(entries))

    def test_tampered_migration_and_artifact_refused(self):
        for name in ['candidate-migrations.mjs', next(n for n in package_entries()
                                                       if n.startswith('migrations/'))]:
            entries = package_entries()
            entries[name] = base64.b64encode(b'changed').decode()
            with self.assertRaises(ValueError):
                w.unpack_payload(*payload(entries))

    def test_decompression_limit(self):
        raw = zlib.compress(b' ' * (4 * 1024**2 + 1))
        with self.assertRaisesRegex(ValueError, 'expanded_limit'):
            w.unpack_payload(base64.b64encode(raw).decode(), w.digest(raw))

    def test_watchdog_reaps_hung_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            pidfile = pathlib.Path(tmp) / 'owned-pid'
            code = "import os,time,pathlib;pathlib.Path(%r).write_text(str(os.getpid()));time.sleep(30)" % str(pidfile)
            started = time.monotonic()
            with self.assertRaisesRegex(ValueError, 'process_timeout'):
                w.bounded_process([sys.executable, '-c', code], tmp, 0.4)
            self.assertLess(time.monotonic() - started, 4)
            pid = int(pidfile.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    def test_output_limit_and_no_inherited_secret(self):
        with self.assertRaisesRegex(ValueError, 'process_output_limit'):
            w.bounded_process([sys.executable, '-c', 'print("x"*20000)'], '/', 3, 128)
        with patch.dict(os.environ, {'SYNTHETIC_SECRET': 'must-not-reach-child'}):
            code, data = w.bounded_process([sys.executable, '-c',
                                           'import os;print(os.getenv("SYNTHETIC_SECRET", "absent"))'], '/', 3)
        self.assertEqual((code, data.strip()), (0, b'absent'))

    def test_malformed_child_output_redacted_and_private_directory_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            sentinel = pathlib.Path(tmp) / 'keep-me'
            sentinel.write_text('unrelated')
            files = {'verify-upgrade-copy-cli.mjs': b'console.log("sensitive synthetic row");'}
            result = w.private_run(files, tmp, MODULES, NODE, sentinel, '0' * 64, 3)
            self.assertEqual(result['status'], 'incomplete')
            self.assertTrue(result['privateDirectoryRemoved'])
            self.assertNotIn('sensitive', json.dumps(result))
            self.assertEqual(list(pathlib.Path(tmp).iterdir()), [sentinel])
            self.assertTrue(MODULES.is_dir())

    def test_hung_child_cleanup_and_cleanup_failure_stays_incomplete(self):
        with tempfile.TemporaryDirectory() as tmp:
            files = {'verify-upgrade-copy-cli.mjs': b'setInterval(()=>{},1000);'}
            result = w.private_run(files, tmp, MODULES, NODE, pathlib.Path(tmp)/'unused', '0'*64, 0.3)
            self.assertTrue(result['privateDirectoryRemoved'])
            self.assertEqual(result['status'], 'incomplete')
            with patch.object(w.shutil, 'rmtree', side_effect=OSError('synthetic private detail')):
                result = w.private_run({}, tmp, MODULES, NODE, pathlib.Path(tmp)/'unused', '0'*64, 3)
            self.assertEqual(result['status'], 'incomplete')
            self.assertFalse(result['privateDirectoryRemoved'])
            self.assertTrue(pathlib.Path(result['cleanupPendingPath']).is_dir())
            self.assertNotIn('synthetic private detail', json.dumps(result))

    def test_changed_service_refusal_is_actionable_and_never_creates_private_copy(self):
        with patch.object(w, 'service_identity', side_effect=ValueError('service_cwd_changed')), \
                patch.object(w, 'private_run') as run:
            result = w.main(*payload(package_entries()))
        self.assertEqual(result['failureCode'], 'service_cwd_changed')
        self.assertEqual(result['phase'], 'service_identity')
        run.assert_not_called()

    def test_unknown_preflight_error_cannot_export_private_text(self):
        with patch.object(w, 'service_identity', side_effect=ValueError('synthetic-private-value')), \
                patch.object(w, 'private_run') as run:
            result = w.main(*payload(package_entries()))
        self.assertEqual(result['failureCode'], 'invalid_preflight_data')
        self.assertNotIn('synthetic-private-value', json.dumps(result))
        run.assert_not_called()

    def test_actual_candidate_upgrade_inside_outer_wrapper(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = pathlib.Path(tmp)
            baseline = directory / 'baseline'
            baseline.mkdir()
            for source in (PACKAGE / 'migrations').glob('*.sql'):
                if int(source.name.split('_')[0]) <= w.SNAPSHOT_VERSION:
                    shutil.copyfile(source, baseline / source.name)
            snapshot = directory / 'snapshot.db'
            setup = """const {createRequire}=await import('node:module');
const require=createRequire(process.argv[1]+'/package.json'); const D=require('better-sqlite3');
const {runMigrations}=await import(process.argv[2]);const db=new D(process.argv[3]);
runMigrations(db,process.argv[4],{info(){},warn(){},debug(){},error(){}});
db.exec("INSERT INTO profiles(name,repo_url) VALUES ('fixture','https://example.test'); INSERT INTO pods(id,profile_name,task,status,model,runtime,branch,user_id) VALUES ('retained','fixture','Retain human decision','failed','fixture','codex','fixture','fixture');");db.close();"""
            subprocess.run([str(NODE), '--input-type=module', '-e', setup,
                            str(ROOT / 'packages/daemon'), (PACKAGE / 'candidate-migrations.mjs').as_uri(),
                            str(snapshot), str(baseline)], check=True, capture_output=True)
            expected = w.file_hash(snapshot)
            result = w.private_run(w.unpack_payload(*payload(package_entries())), directory,
                                   MODULES, NODE, snapshot, expected, 30)
            self.assertEqual(result['status'], 'isolated_upgrade_verified', result)
            self.assertTrue(result['privateDirectoryRemoved'])
            self.assertTrue(result['retainedOriginalColumnsAndRows'])
            self.assertEqual(w.file_hash(snapshot), expected)
            self.assertEqual(sorted(p.name for p in directory.iterdir()), ['baseline', 'snapshot.db'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
