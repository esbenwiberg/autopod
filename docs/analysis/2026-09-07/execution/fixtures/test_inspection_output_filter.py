import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('filter', Path(__file__).with_name('inspection-output-filter.py'))
output_filter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(output_filter)


class OutputFilter(unittest.TestCase):
    def test_large_metadata_is_bounded_with_explicit_omissions(self):
        record = {'database': {'quickCheckOk': True},
                  'migrationFiles': [{'name': str(n), 'sha256': 'a' * 64} for n in range(256)],
                  'backupInventory': [{'latestFiles': [{'name': 'x' * 256} for n in range(20)]} for _ in range(3)],
                  'logEvidence': {'errors': [{'kind': 'SQLITE_ERROR'} for n in range(100)]}}
        raw = output_filter.reduce_output(record)
        result = json.loads(raw)
        self.assertLessEqual(len(raw.encode()), 3500)
        self.assertTrue(result['database']['quickCheckOk'])
        self.assertEqual(len(record['migrationFiles']), 256)
        self.assertEqual(result['transport']['omittedMigrationFiles'] + len(result['migrationFiles']), 256)
        self.assertEqual(len(result['migrationManifestSha256']), 64)

    def test_incomplete_inspection_stays_incomplete(self):
        result = json.loads(output_filter.reduce_output({'status': 'inspection_incomplete'}))
        self.assertEqual(result['status'], 'inspection_incomplete')

    def test_unreducible_output_reports_limit_instead_of_truncating_json(self):
        result = json.loads(output_filter.reduce_output({'oversized': 'x' * 4000}))
        self.assertEqual(result['status'], 'transport_output_limit')


if __name__ == '__main__':
    unittest.main(verbosity=2)
