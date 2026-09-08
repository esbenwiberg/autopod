"""One report using the real Codex CLI. No reusable credential or external endpoint."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import urlparse

parser = argparse.ArgumentParser()
parser.add_argument('--model', required=True)
parser.add_argument('--reasoning', required=True)
parser.add_argument('--readme', required=True)
parser.add_argument('--output', default='/output/report.md')
parser.add_argument('--endpoint', default='http://127.0.0.1:4187/v1')
parser.add_argument('objective', nargs='*')
args = parser.parse_args()
endpoint = urlparse(args.endpoint)
if endpoint.scheme != 'http' or endpoint.hostname != '127.0.0.1' or not endpoint.port or endpoint.username or endpoint.password or endpoint.path != '/v1' or endpoint.query or endpoint.fragment:
    raise RuntimeError('loopback-required')
source = Path(args.readme)
fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
# Bound input bytes independently of the 16 KiB output contract.
with os.fdopen(fd, 'rb') as stream:
    readme_bytes = stream.read(96 * 1024 + 1)
if len(readme_bytes) > 96 * 1024:
    raise RuntimeError('readme-too-large')
readme = readme_bytes.decode('utf-8')
with tempfile.TemporaryDirectory(prefix='managed-codex-') as temporary:
    home = Path(temporary) / 'home'
    home.mkdir()
    instructions = Path(temporary) / 'instructions.md'
    instructions.write_text('Produce the requested factual report from the supplied frozen README. Do not call tools. Return only the report.\n')
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
        'web_search': 'disabled',
        'otel.exporter': 'none',
        'otel.metrics_exporter': 'none',
        'otel.trace_exporter': 'none',
    }
    command = ['codex', 'exec', '--ephemeral', '--skip-git-repo-check', '--json', '--sandbox', 'read-only', '-m', args.model, '-C', temporary, '--output-last-message', args.output]
    for key, value in config.items():
        command.extend(['-c', key + '=' + json.dumps(value)])
    command.extend(['--', '-'])
    # This is an isolated child's home, never the user's Codex home or auth cache.
    env = {'HOME': str(home), 'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'), 'TMPDIR': temporary}
    prompt = ' '.join(args.objective) + '\n\nFrozen README data follows:\n' + readme
    result = subprocess.run(command, input=prompt, text=True, env=env, timeout=170)
    raise SystemExit(result.returncode)
