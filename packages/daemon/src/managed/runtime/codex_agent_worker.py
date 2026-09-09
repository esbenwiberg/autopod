"""Run one reviewed Codex agent inside the managed repository boundary."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlparse

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
        f'Write the final work product to {output}. '
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
        'model_instructions_file': str(instructions),
        'model_reasoning_effort': args.reasoning,
        'web_search': 'disabled', 'otel.exporter': 'none',
        'otel.metrics_exporter': 'none', 'otel.trace_exporter': 'none',
    }
    command = ['codex', 'exec', '--ephemeral', '--json', '--sandbox', args.sandbox,
               '-m', args.model, '-C', str(repository), '--output-last-message', str(output)]
    for key, value in config.items(): command.extend(['-c', key + '=' + json.dumps(value)])
    command.extend(['--', '-'])
    prompt = ' '.join(args.objective)
    if inputs: prompt += '\n\nVerified Dispatcher input artifacts:\n' + '\n\n---\n\n'.join(inputs)
    env = {'HOME': str(home), 'PATH': '/opt/dispatcher:' + os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'), 'TMPDIR': temporary}
    result = subprocess.run(command, input=prompt, text=True, env=env)
    raise SystemExit(result.returncode)
