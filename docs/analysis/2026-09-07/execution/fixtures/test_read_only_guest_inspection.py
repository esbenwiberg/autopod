"""Local-only payload boundary tests. Never invokes inspect() or contacts a VM."""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'inspection', Path(__file__).with_name('read-only-guest-inspection.py'))
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)


class PayloadBoundaries(unittest.TestCase):
    def test_arbitrary_log_values_do_not_leave_vm(self):
        secret = 'PRIVATE_ROW_CREDENTIAL_AND_URL'
        result = inspection.safe_error({'time': secret, 'req': {'url': '/pods?token=' + secret},
                                        'err': {'code': 'SQLITE_ERROR', 'message': 'no such column: ' + secret,
                                                'stack': secret}})
        self.assertNotIn(secret, json.dumps(result))
        self.assertEqual(result, {'time': None, 'kind': 'SQLITE_ERROR',
                                  'detail': 'missing_column', 'endpoint': '/pods'})
        self.assertIsNone(inspection.safe_error({'err': {'code': 'SQLITE_' + secret}}))
        self.assertIsNone(inspection.safe_error({'err': secret}))
        self.assertIsNone(inspection.safe_error([secret]))

    def test_json_classification_exports_no_error_text(self):
        result = inspection.safe_error({'time': 1750000000000,
                                        'err': {'message': 'Unexpected token private row', 'stack': 'JSON.parse private'}})
        self.assertEqual(result['kind'], 'JSON_PARSE_ERROR')
        self.assertNotIn('private', json.dumps(result))

    def test_actual_child_output_is_bounded_and_terminated(self):
        data, result = inspection.bounded_command(
            [sys.executable, '-c', 'import os; os.write(1, b"x" * 1000000)'], 128, 2)
        self.assertEqual(len(data), 128)
        self.assertEqual(result['incomplete'], 'byte_limit')
        self.assertIsInstance(result['exit'], int)

    def test_actual_child_timeout_is_observed(self):
        data, result = inspection.bounded_command(
            [sys.executable, '-c', 'import time; time.sleep(30)'], 128, .05)
        self.assertEqual(data, b'')
        self.assertEqual(result['incomplete'], 'timeout')
        self.assertIsInstance(result['exit'], int)

    def test_inventory_truncation_and_release_allowlist(self):
        with tempfile.TemporaryDirectory() as directory:
            for n in range(4):
                Path(directory, str(n)).touch()
            entries, truncated = inspection.directory_entries(directory, 3)
            self.assertEqual(len(entries), 3)
            self.assertTrue(truncated)
        self.assertTrue(inspection.allowed_release(Path('/opt/autopod/managed/releases/example')))
        self.assertFalse(inspection.allowed_release(Path('/home/ewi/.ssh')))
        self.assertFalse(inspection.allowed_release(Path('/opt/autopod/releases-other/example')))


if __name__ == '__main__':
    unittest.main(verbosity=2)
