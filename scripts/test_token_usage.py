import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).with_name('token_usage.py')
spec = importlib.util.spec_from_file_location('token_usage', SCRIPT)
usage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(usage)


def assistant(tokens=10, timestamp=1790479800000, model='model', cost=0.01):
    return {'role': 'assistant', 'provider': 'provider', 'model': model,
            'timestamp': timestamp, 'usage': {'totalTokens': tokens, 'cost': {'total': cost}}}


def write_rows(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('\n'.join(map(json.dumps, rows)) + '\n')


def native(message, identity='message'):
    return {'type': 'message', 'id': identity, 'timestamp': '2026-09-27T02:00:00Z', 'message': message}


def result(run, log=None, session=None, tokens=20, cost=0.02):
    child = {'usage': {'totalTokens': tokens, 'cost': cost}}
    if log:
        child['logPath'] = str(log)
    if session:
        child['sessionPath'] = str(session)
    return {'type': 'message', 'id': run, 'message': {
        'role': 'toolResult', 'toolName': 'subagent',
        'details': {'jobId': run, 'runDir': '/tmp/pi-minsub/' + run, 'results': [child]}}}


class UsageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sessions = self.root / 'sessions'
        self.logs = self.root / 'logs'
        self.sessions.mkdir()
        self.child = self.sessions / 'parent.jsonl.pi-minimal-subagent' / 'run' / '1-worker.jsonl'
        self.log = self.logs / 'run' / '1-worker.jsonl'

    def collect(self, legacy=False):
        return usage.collect(self.sessions, self.logs, legacy=legacy)

    def test_local_day(self):
        old = os.environ.get('TZ')
        try:
            os.environ['TZ'] = 'America/New_York'
            time.tzset()
            self.assertEqual(usage.local_day('2026-09-27T02:00:00Z'), '2026-09-26')
            self.assertEqual(usage.local_day('2026-09-27T04:00:00Z'), '2026-09-27')
        finally:
            if old is None:
                os.environ.pop('TZ', None)
            else:
                os.environ['TZ'] = old
            time.tzset()

    def test_native_and_legacy_copies_count_once(self):
        write_rows(self.child, [native(assistant(20, cost=0.02), 'child')])
        write_rows(self.log, [{'type': 'message_end', 'message': assistant(20, cost=0.02)}])
        rows = [native(assistant(), 'parent'), result('run', self.log, self.child)]
        write_rows(self.sessions / 'parent.jsonl', rows)
        write_rows(self.sessions / 'fork.jsonl', rows)
        for legacy in [False, True]:
            totals, unknown, warnings = self.collect(legacy)
            self.assertEqual(sum(v['tokens'] for v in totals.values()), 30)
            self.assertAlmostEqual(sum(v['cost'] for v in totals.values()), 0.03)
            self.assertEqual(unknown['tokens'], 0)

    def test_legacy_is_additive_for_mixed_history(self):
        write_rows(self.child, [native(assistant(20), 'child')])
        oldlog = self.logs / 'old' / '1-worker.jsonl'
        old_message = assistant(7, model='old', cost=0.007)
        write_rows(oldlog, [
            {'type': 'message_end', 'message': old_message},
            {'type': 'turn_end', 'message': old_message},
            {'type': 'agent_end', 'messages': [old_message]},
        ])
        saved = result('old', oldlog, tokens=7, cost=0.007)
        completion = {'type': 'custom_message', 'id': 'completion',
                      'customType': 'minimal-subagent-complete', 'details': saved['message']['details']}
        write_rows(self.sessions / 'parent.jsonl', [saved, completion])
        totals, unknown, _ = self.collect()
        self.assertEqual(sum(v['tokens'] for v in totals.values()), 20)
        self.assertEqual(unknown['tokens'], 7)
        totals, unknown, _ = self.collect(True)
        self.assertEqual(sum(v['tokens'] for v in totals.values()), 27)
        self.assertEqual(unknown['tokens'], 0)

    def test_orphan_native_does_not_duplicate_its_log(self):
        write_rows(self.child, [native(assistant(20), 'child')])
        write_rows(self.log, [{'type': 'message_end', 'message': assistant(20)}])
        totals, _, _ = self.collect(True)
        self.assertEqual(sum(v['tokens'] for v in totals.values()), 20)

    def test_native_authoritative_when_temporary_log_has_extra_turns(self):
        write_rows(self.child, [native(assistant(20), 'child')])
        write_rows(self.log, [{'type': 'message_end', 'message': assistant(40)}])
        write_rows(self.sessions / 'parent.jsonl', [result('run', self.log, self.child, tokens=25)])
        totals, unknown, _ = self.collect(True)
        self.assertEqual(sum(v['tokens'] for v in totals.values()), 20)
        self.assertEqual(unknown['tokens'], 5)

    def test_missing_allocated_native_session_falls_back_to_legacy(self):
        write_rows(self.log, [{'type': 'message_end', 'message': assistant(20, cost=0.02)}])
        write_rows(self.sessions / 'parent.jsonl', [result('run', self.log, self.child)])
        totals, unknown, _ = self.collect(True)
        self.assertEqual(sum(v['tokens'] for v in totals.values()), 20)
        self.assertEqual(unknown['tokens'], 0)

    def test_missing_and_zero_cost_are_different(self):
        write_rows(self.sessions / 'parent.jsonl', [
            native(assistant(cost=0), 'zero'),
            native(assistant(cost=None), 'missing'),
        ])
        totals, _, warnings = self.collect()
        values = list(totals.values())
        self.assertEqual(values[0]['cost'], 0)
        self.assertTrue(values[0]['missing_cost'])
        self.assertTrue(warnings)

    def test_partial_line_and_mixed_models(self):
        write_rows(self.log, [{'type': 'message_end', 'message': assistant(7, model=m)} for m in ['a', 'b']])
        with self.log.open('a') as stream:
            stream.write('{"type":')
        totals, _, warnings = self.collect(True)
        self.assertEqual(sum(v['tokens'] for v in totals.values()), 14)
        self.assertEqual(len(totals), 2)
        self.assertTrue(warnings)

    def test_cost_and_token_pivot(self):
        write_rows(self.sessions / 'parent.jsonl', [
            native(assistant(model='a'), 'a'), native(assistant(model='b'), 'b')])
        output = subprocess.check_output([
            sys.executable, str(SCRIPT), '--sessions', str(self.sessions),
            '--logs', str(self.logs), '--days', '36500'], text=True)
        self.assertIn('Tokens', output)
        self.assertIn('Reported cost (USD)', output)
        self.assertIn('provider/a', output)
        self.assertIn('provider/b', output)
        self.assertEqual(output.count('TOTAL'), 2)
        self.assertIn('$0.0200', output)


if __name__ == '__main__':
    unittest.main()
