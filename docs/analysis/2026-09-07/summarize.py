"""Recompute the principal cohort statistics from the sanitized evidence snapshot."""
import collections
import json
from pathlib import Path

evidence = json.loads(Path(__file__).with_name('evidence.json').read_text())
auto = [p for p in evidence['pods'] if p['agentMode'] == 'auto']
auto_ids = {p['id'] for p in auto}
validations = [v for v in evidence['validations'] if v['podId'] in auto_ids]
assert len({p['id'] for p in evidence['pods']}) == len(evidence['pods'])
assert len({v['id'] for v in validations}) == len(validations)
phases = collections.Counter()
for pod in auto:
    for key, cost in pod['phaseCosts'].items():
        phases[key.split('_')[0]] += cost or 0
print('automatic pods:', len(auto), dict(collections.Counter(p['status'] for p in auto)))
print('validation records:', len(validations))
print('pods with validation:', len({v['podId'] for v in validations}))
print('pods with repeated validation:', sum(p['validationRecords'] > 1 for p in auto))
print('validation hours:', round(sum(v['durationMs'] for v in validations) / 3600000, 4))
print('agent and review recorded costs:', dict(phases))
for stage in ['build', 'test', 'factValidation', 'taskReview', 'sast']:
    ran = {v['podId'] for v in validations if v['phases'][stage] in ('pass', 'fail')}
    failed = {v['podId'] for v in validations if v['phases'][stage] == 'fail'}
    print(stage, 'ran:', len(ran), 'ever failed:', len(failed))
