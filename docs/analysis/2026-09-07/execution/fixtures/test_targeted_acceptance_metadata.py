import importlib.util
import json
import sqlite3
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('targeted', Path(__file__).with_name('inspect-targeted-acceptance-metadata.py'))
targeted = importlib.util.module_from_spec(spec)
spec.loader.exec_module(targeted)


def summarize(entries):
    return targeted.aggregate_journal('\n'.join(json.dumps(e) for e in entries).encode())


class TargetedMetadata(unittest.TestCase):
    def test_aggregates_all_matches_without_transport_sample_bias(self):
        entries = [{'time': i, 'err': {'code': 'SQLITE_FULL', 'message': 'database or disk is full'}} for i in range(47)]
        entries.append({'time': 60, 'err': {'message': 'Invalid string length'}})
        result = summarize(entries)
        groups = {g['kind']: g for g in result['groups']}
        self.assertEqual(groups['SQLITE_FULL']['count'], 47)
        self.assertEqual(groups['RESPONSE_SIZE_LIMIT']['count'], 1)
        self.assertFalse(result['rootCauseAutomaticallyVerified'])

    def test_correlates_only_same_process_request_nearby(self):
        result = summarize([
            {'pid': 9, 'reqId': 'request-private', 'time': 100000, 'err': {'code': 'SQLITE_FULL'}},
            {'pid': 9, 'reqId': 'request-private', 'time': 100001, 'path': '/pods/analytics/cost?token=private', 'status': 500},
        ])
        self.assertEqual(result['groups'][0]['endpoint'], '/pods/analytics/cost')
        self.assertEqual(result['groups'][0]['attribution'], 'same_pid_request_within_30s')
        self.assertEqual(result['statusCounts'], {'/pods/analytics/cost:500': 1})
        self.assertNotIn('private', json.dumps(result))

    def test_cross_process_stale_and_ambiguous_requests_do_not_attribute(self):
        error = {'pid': 9, 'reqId': 'r', 'time': 100000, 'err': {'code': 'SQLITE_FULL'}}
        for requests in [
            [{'pid': 8, 'reqId': 'r', 'time': 100001, 'path': '/pods'}],
            [{'pid': 9, 'reqId': 'r', 'time': 140000, 'path': '/pods'}],
            [{'pid': 9, 'reqId': 'r', 'time': 100001, 'path': p} for p in ('/pods', '/pods/analytics/cost')],
        ]:
            self.assertEqual(summarize([error, *requests])['groups'][0]['endpoint'], 'unattributed')

    def test_unknown_errors_and_malformed_lines_never_export_content(self):
        raw = b'private invalid log\n' + json.dumps({'err': {'message': 'private arbitrary failure', 'stack': 'private stack', 'code': 'private-code'}, 'path': '/private'}).encode()
        result = targeted.aggregate_journal(raw)
        self.assertEqual(result['unparsedLines'], 1)
        self.assertEqual(result['groups'][0]['kind'], 'OTHER_ERROR')
        self.assertNotIn('private', json.dumps(result))

    def test_named_profiles_follow_parents_without_selecting_unrelated_data(self):
        db = sqlite3.connect(':memory:')
        db.execute('CREATE TABLE profiles(name, extends, execution_target, default_runtime, warm_image_tag, credential)')
        db.executemany('INSERT INTO profiles VALUES(?,?,?,?,?,?)', [
            ('luumi', 'base', 'sandbox', 'codex', None, 'private'),
            ('base', 'luumi', None, None, 'registry.azurecr.io/app:latest', 'private'),
            ('unrelated', None, 'sandbox', 'codex', 'registry.azurecr.io/unrelated', 'private'),
        ])
        result = targeted.profile_projection(db)
        self.assertEqual([r['name'] for r in result['profiles']], ['luumi', 'base'])
        self.assertEqual(result['missing'], ['dataverse-harness', 'teamplanner-pr-read'])
        self.assertEqual(result['unvisitedParents'], 0)
        self.assertNotIn('private', json.dumps(result))
        self.assertNotIn('unrelated', json.dumps(result))
        db.close()

    def test_projection_caps_parent_chain_and_rejects_credential_image(self):
        db = sqlite3.connect(':memory:')
        db.execute('CREATE TABLE profiles(name, extends, execution_target, default_runtime, warm_image_tag)')
        db.execute('INSERT INTO profiles VALUES(?,?,?,?,?)', ('luumi', 'parent0', 'sandbox', 'codex', 'https://user:private@registry/app'))
        db.executemany('INSERT INTO profiles VALUES(?,?,?,?,?)', [(f'parent{i}', f'parent{i+1}', None, None, None) for i in range(20)])
        result = targeted.profile_projection(db)
        self.assertIsNone(result['profiles'][0]['warmImageTag'])
        self.assertLessEqual(len(result['profiles']), 9)
        self.assertEqual(result['unvisitedParents'], 1)
        self.assertNotIn('private', json.dumps(result))
        db.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
