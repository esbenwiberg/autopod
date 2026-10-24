#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 - "$@" <<'PY'
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import sys

def command(*args):
    return subprocess.check_output(args, text=True).strip()

args = sys.argv[1:]
if len(args) not in (2, 3) or args[0] not in ('record', 'verify') or (args[0] == 'verify') != (len(args) == 3):
    sys.exit('Usage: measure-desktop-selection.sh record REPORT | verify REPORT BASELINE')
mode, output = args[:2]
report_path = Path(output)
if not report_path.is_absolute():
    sys.exit('Report must be an absolute path')
fixture_files = [
    'packages/desktop/Sources/AutopodUI/Models/DesktopPerformanceFixtures.swift',
    'packages/desktop/Tests/AutopodUITests/DesktopSelectionPerformanceHost.swift',
    'packages/desktop/Tests/AutopodUITests/DesktopSelectionPerformanceTests.swift',
]
def hashes(paths):
    return {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in paths}
configuration = dict(machine=platform.machine(), os=command('sw_vers', '-productVersion'),
    swift=command('swift', '--version'), xcode=command('xcodebuild', '-version'),
    build='release', window=[1800, 1050], animations=False, pods=1000,
    warmups=20, observations=100, deadlineSeconds=5, thresholdMs=250,
    fixtureAndHarness=hashes(fixture_files))
baseline = None
if mode == 'verify':
    baseline = json.loads(Path(args[2]).read_text())
    if baseline.get('configuration') != configuration:
        sys.exit('Baseline fixture, harness, or configuration differs; comparisons are invalid')
raw_path = report_path.with_suffix('.raw.json')
if raw_path.exists():
    sys.exit('Raw report already exists; use a fresh report path to avoid stale results')
env = dict(os.environ, AUTOPOD_DESKTOP_PERF_MODE=mode, AUTOPOD_DESKTOP_PERF_REPORT=str(raw_path))
source_paths = [
    'packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift',
    'packages/desktop/Sources/AutopodUI/Models/DesktopPresentation.swift',
    'packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift',
    'packages/desktop/Sources/AutopodDesktop/Views/AppRootView.swift',
]
metadata = dict(revision=command('git', 'rev-parse', 'HEAD'),
    dirty=bool(command('git', 'status', '--porcelain')), sourceHashes=hashes(source_paths))
result = subprocess.run(['swift', 'test', '--package-path', 'packages/desktop', '-c', 'release',
    '--no-parallel', '--filter', 'DesktopSelectionPerformanceTests'], env=env)
if not raw_path.is_file():
    sys.exit('Native test produced no report (build, fixture setup, or execution failed)')
cases = json.loads(raw_path.read_text())
expected = {(scope, action) for scope in ('active', 'recent', 'repository')
    for action in ('pod', 'overview', 'work', 'validation', 'readiness', 'evidence', 'diff', 'logs')}
if len(cases) != len(expected) or {(c['scope'], c['action']) for c in cases} != expected:
    sys.exit('Native report case matrix is missing entries or contains duplicates')
passed = result.returncode == 0
for case in cases:
    values = sorted(case['samplesMs'])
    if any(not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 for v in values):
        sys.exit('Invalid timing value')
    complete = len(values) == 100 and case['warmupsCompleted'] == 20 and case['timeouts'] == 0
    if not complete and not case.get('abortedReason') and case['timeouts'] == 0:
        sys.exit('Unexplained incomplete timing case')
    case.update(p50Ms=values[49] if complete else None,
        p95Ms=values[94] if complete else None, maximumMs=max(values) if values else None,
        overThreshold=sum(v > 250 for v in values), unsampled=100-len(values), complete=complete)
    case['passed'] = complete and case['p95Ms'] <= 250
    passed = passed and case['passed']
    print(f"{case['scope']}/{case['action']}: p95={case['p95Ms']} ms; n={len(values)}; failures={case['timeouts']}", flush=True)
report = dict(configuration=configuration, metadata=metadata, mode=mode,
    testExitCode=result.returncode, passed=passed, cases=cases)
report_path.write_text(json.dumps(report, indent=2, sort_keys=True)+'\n')
print(f'Report: {report_path}', flush=True)
# Record mode preserves failing baseline observations without imposing the after target.
sys.exit(result.returncode if mode == 'record' else (0 if passed else 1))
PY
