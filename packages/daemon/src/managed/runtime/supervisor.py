"""Trusted per-container supervisor. Runs outside the worker uid and survives daemon loss.

The caller provisions a root-owned state directory and a reviewed argv. Network,
mounts and the account-bound quota broker are enforced by the container boundary.
This process adds a hard local expiry, one-start claim and observed-exit record.
"""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

QUOTA_LEASE_SECONDS = 30
QUOTA_FUTURE_SKEW_SECONDS = 5


def atomic(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def supervise(root, clock=time.time):
    spec = json.loads((root / 'launch.json').read_text())
    lock = (root / 'launch.lock').open('a')
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    receipt = root / 'execution.json'
    if receipt.exists():
        # Even a crash between claim and Popen never authorizes a duplicate launch.
        return
    deadline = min(spec['expiresAt'], clock() + spec['maxDurationSeconds'])
    state = {'state': 'claimed', 'specDigest': spec['specDigest'], 'expiresAt': deadline,
             'consumedTokens': 0, 'observedExit': False}
    atomic(receipt, state)
    if clock() >= deadline:
        atomic(receipt, {**state, 'state': 'expired', 'observedExit': True})
        return
    # A child may only inherit explicitly reviewed, non-secret environment fields.
    env = {key: value for key, value in spec['environment'].items() if key in ('PATH', 'LANG', 'HOME', 'TMPDIR')}
    def isolate():
        os.setsid()
        if sys.platform == 'linux':
            import ctypes
            if ctypes.CDLL(None).prctl(38, 1, 0, 0, 0) != 0:
                raise RuntimeError('no-new-privileges-unavailable')
        if os.getuid() == 0:
            os.setgroups([])
            os.setgid(spec['workerGid'])
            os.setuid(spec['workerUid'])
    stdout = (root / 'stdout').open('ab')
    stderr = (root / 'stderr').open('ab')
    process = subprocess.Popen(spec['argv'], cwd=spec['cwd'], env=env,
                               stdout=stdout, stderr=stderr, preexec_fn=isolate)
    state.update(state='running', pid=process.pid)
    atomic(receipt, state)
    quota_grace_started_at = clock()
    last_valid_quota_at = None
    reason = 'exited'
    while process.poll() is None:
        reason = None
        now = clock()
        if now >= deadline:
            reason = 'expired'
        if (root / 'revoked').exists():
            reason = 'revoked'
        # The trusted account gateway writes quota receipts, never the worker.
        if spec['requireQuotaReceipt']:
            try:
                quota = json.loads((root / 'quota.json').read_text())
                if quota['specDigest'] != spec['specDigest']:
                    reason = 'quota-unavailable'
                else:
                    observed_at = quota['observedAt']
                    consumed_tokens = quota['consumedTokens']
                    if (not isinstance(observed_at, (int, float)) or isinstance(observed_at, bool) or
                            observed_at < 0 or observed_at > now + QUOTA_FUTURE_SKEW_SECONDS or
                            not isinstance(consumed_tokens, int) or isinstance(consumed_tokens, bool) or
                            consumed_tokens < 0):
                        raise ValueError('invalid quota receipt')
                    last_valid_quota_at = max(last_valid_quota_at or observed_at, observed_at)
                    state['consumedTokens'] = max(state['consumedTokens'], consumed_tokens)
                    if quota.get('revoked'):
                        reason = 'revoked'
                    if (spec.get('budgetMode') != 'request-time' and
                            state['consumedTokens'] >= spec['maxTokens']):
                        reason = 'budget-exhausted'
            except (OSError, TypeError, ValueError, KeyError):
                # File publication is remote for sandbox workers. Keep the last
                # trusted lease through a bounded transient read/write failure.
                pass
            lease_at = last_valid_quota_at if last_valid_quota_at is not None else quota_grace_started_at
            if reason is None and now - lease_at > QUOTA_LEASE_SECONDS:
                reason = 'quota-unavailable'
        if reason:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            except ProcessLookupError:
                process.wait()
            break
        time.sleep(0.05)
    # Reap any children in the worker process group before reporting observed exit.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    atomic(receipt, {**state, 'state': reason or 'exited', 'observedExit': True,
                     'exitCode': process.returncode})
    stdout.close()
    stderr.close()


if __name__ == '__main__':
    directory = Path(sys.argv[1]).resolve()
    if '--detach' in sys.argv:
        if os.fork():
            sys.exit(0)
        os.setsid()
        if os.fork():
            os._exit(0)
        with open(os.devnull, 'rb', 0) as source, open(os.devnull, 'ab', 0) as sink:
            os.dup2(source.fileno(), 0)
            os.dup2(sink.fileno(), 1)
            os.dup2(sink.fileno(), 2)
    supervise(directory)
