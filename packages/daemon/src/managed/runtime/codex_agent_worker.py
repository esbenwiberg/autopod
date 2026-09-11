"""Run one reviewed Codex agent inside the managed repository boundary."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

FAILURE_REASONS = {
    'context-window-exceeded',
    'tool-permission-denied',
    'channel-unavailable',
    'cli-exit',
}


def report_failure(endpoint, log, exit_code):
    try:
        with log.open('rb') as stream:
            stream.seek(0, os.SEEK_END)
            size = stream.tell()
            stream.seek(max(0, size - 256 * 1024))
            tail = stream.read().decode('utf8', errors='replace').lower()
        if any(value in tail for value in ('context_length_exceeded', 'context window', 'prompt is too long')):
            reason = 'context-window-exceeded'
        elif any(value in tail for value in ('approval required', 'permission denied', 'operation not permitted')):
            reason = 'tool-permission-denied'
        elif any(value in tail for value in ('connection refused', 'error sending request', 'channel closed')):
            reason = 'channel-unavailable'
        else:
            reason = 'cli-exit'
        if reason not in FAILURE_REASONS:
            reason = 'cli-exit'
        payload = json.dumps({'phase': 'agent', 'reason': reason, 'exitCode': exit_code}, separators=(',', ':')).encode()
        request = urllib.request.Request(
            endpoint.removesuffix('/v1') + '/failure', data=payload, method='POST',
            headers={'Content-Type': 'application/json', 'Content-Length': str(len(payload))},
        )
        with urllib.request.urlopen(request, timeout=1) as response:
            if response.status != 204:
                raise RuntimeError('failure-report-rejected')
    except (OSError, RuntimeError, ValueError, urllib.error.URLError):
        pass

parser = argparse.ArgumentParser()
parser.add_argument('--model', required=True)
parser.add_argument('--reasoning', required=True)
parser.add_argument('--repository', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--sandbox', choices=('read-only', 'workspace-write'), required=True)
parser.add_argument('--endpoint', default='http://127.0.0.1:4187/v1')
parser.add_argument('--input-root', action='append', default=[])
parser.add_argument('--github-repository')
parser.add_argument('objective', nargs='*')
args = parser.parse_args()
endpoint = urlparse(args.endpoint)
if (endpoint.scheme, endpoint.hostname, endpoint.path) != ('http', '127.0.0.1', '/v1') or not endpoint.port or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
    raise RuntimeError('loopback-required')
repository = Path(args.repository)
if repository.is_symlink() or not repository.is_dir() or not str(repository).startswith('/repositories/'):
    raise RuntimeError('repository-boundary-invalid')
output = Path(args.output)
if output.is_absolute() is False or not str(output).startswith('/output/') or '..' in output.parts:
    raise RuntimeError('output-boundary-invalid')
if args.github_repository and not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.github_repository):
    raise RuntimeError('github-repository-invalid')
inputs = []
for raw in args.input_root:
    root = Path(raw)
    if root.is_symlink() or not root.is_dir() or not str(root).startswith('/inputs/'):
        raise RuntimeError('input-boundary-invalid')
    files = sorted(item for item in root.rglob('*') if item.is_file() and not item.is_symlink())
    if len(files) != 1 or files[0].stat().st_size > 1024 * 1024:
        raise RuntimeError('input-contract-invalid')
    inputs.append(files[0].read_text())
with tempfile.TemporaryDirectory(prefix='managed-codex-') as temporary:
    home = Path(temporary) / 'home'; home.mkdir()
    instructions = Path(temporary) / 'instructions.md'
    instructions.write_text(
        'Work only in the supplied repository and output directory. Follow repository instructions. '
        'Do not use network access. Do not push, merge, publish, deploy, or access credentials. '
        f'Return the complete work product as your final response; the reviewed Codex launcher '
        f'captures that response at {output}. Do not edit that output path directly. '
        + (f'For GitHub issue reads only, use the credential-free gh helper with --repo {args.github_repository}. '
           if args.github_repository else '')
        + ('Commit only the files you intentionally changed after required checks pass. '
           if args.sandbox == 'workspace-write' else '')
    )
    config = {
        'model_provider': 'dispatcher-channel',
        'model_providers.dispatcher-channel.name': 'Dispatcher attempt channel',
        'model_providers.dispatcher-channel.base_url': args.endpoint,
        'model_providers.dispatcher-channel.wire_api': 'responses',
        'model_providers.dispatcher-channel.requires_openai_auth': False,
        'model_providers.dispatcher-channel.supports_websockets': False,
        'model_providers.dispatcher-channel.request_max_retries': 0,
        'model_providers.dispatcher-channel.stream_max_retries': 0,
        # The bounded managed loopback deliberately exposes only /v1/responses.
        # Codex auto-compaction uses /v1/responses/compact, so disable it here
        # and let the reviewed model context window remain the only context cap.
        'features.auto_compaction': False,
        'model_instructions_file': str(instructions),
        'model_reasoning_effort': args.reasoning,
        'web_search': 'disabled', 'otel.exporter': 'none',
        'otel.metrics_exporter': 'none', 'otel.trace_exporter': 'none',
    }
    captured = Path(temporary) / 'last-message.md'
    command = ['codex', 'exec', '--json', '--sandbox', args.sandbox,
               '-m', args.model, '-C', str(repository), '--output-last-message', str(captured)]
    for key, value in config.items(): command.extend(['-c', key + '=' + json.dumps(value)])
    command.extend(['--', '-'])
    prompt = ' '.join(args.objective)
    if inputs: prompt += '\n\nVerified Dispatcher input artifacts:\n' + '\n\n---\n\n'.join(inputs)
    env = {'HOME': str(home), 'PATH': '/opt/dispatcher:' + os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'), 'TMPDIR': temporary}
    log = Path(temporary) / 'codex.jsonl'
    with log.open('w') as stream:
        result = subprocess.run(
            command, input=prompt, text=True, env=env, cwd=repository,
            stdout=stream, stderr=subprocess.STDOUT,
        )
    if result.returncode:
        report_failure(args.endpoint, log, result.returncode)
        raise SystemExit(result.returncode)
    empty_polls = 0
    handled = 0
    while handled < 16 and empty_polls < 4:
        try:
            with urllib.request.urlopen(args.endpoint.removesuffix('/v1') + '/followups', timeout=1) as response:
                if response.status == 204:
                    empty_polls += 1
                    time.sleep(0.25)
                    continue
                followup = json.loads(response.read())
        except urllib.error.HTTPError:
            raise
        empty_polls = 0
        key = followup.get('key')
        message = followup.get('message')
        if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', key) or not isinstance(message, str) or not 0 < len(message.encode()) <= 4096:
            raise RuntimeError('followup-invalid')
        resume = ['codex', 'exec', 'resume', '--last', '--json', '-m', args.model,
                  '--output-last-message', str(captured)]
        for key, value in config.items(): resume.extend(['-c', key + '=' + json.dumps(value)])
        resume.extend(['--', message])
        with log.open('w') as stream:
            result = subprocess.run(
                resume, text=True, env=env, cwd=repository,
                stdout=stream, stderr=subprocess.STDOUT,
            )
        if result.returncode:
            report_failure(args.endpoint, log, result.returncode)
            raise SystemExit(result.returncode)
        acknowledgement = urllib.request.Request(
            args.endpoint.removesuffix('/v1') + '/followups/' + key,
            data=b'', method='POST', headers={'Content-Length': '0'},
        )
        with urllib.request.urlopen(acknowledgement, timeout=1) as response:
            if response.status != 204:
                raise RuntimeError('followup-ack-failed')
        handled += 1
    if not captured.is_file() or captured.is_symlink() or captured.stat().st_size > 1024 * 1024:
        raise RuntimeError('agent-output-invalid')
    temporary_output = output.with_suffix(output.suffix + '.tmp')
    temporary_output.write_bytes(captured.read_bytes())
    os.replace(temporary_output, output)
