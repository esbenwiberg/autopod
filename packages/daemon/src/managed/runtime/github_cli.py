#!/usr/bin/env python3
"""Credential-free, read-only gh subset backed by the managed host broker."""
import json
import sys
import urllib.request

args = sys.argv[1:]
def option(name, default=None):
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else default
repo = option('--repo')
if not repo:
    raise SystemExit('managed gh requires --repo')
if len(args) >= 3 and args[:2] == ['issue', 'view']:
    request = {'operation': 'issue-view', 'repository': repo, 'number': int(args[2])}
elif len(args) >= 2 and args[:2] == ['issue', 'list']:
    request = {'operation': 'issue-list', 'repository': repo, 'search': option('--search', ''), 'limit': int(option('--limit', '30'))}
elif len(args) >= 2 and args[0] == 'api':
    import re
    match = re.fullmatch(r'repos/([^/]+/[^/]+)/issues/(\d+)/comments', args[1])
    if not match or match.group(1) != repo:
        raise SystemExit('managed gh api route denied')
    request = {'operation': 'issue-comments', 'repository': repo, 'number': int(match.group(2))}
else:
    raise SystemExit('managed gh operation denied')
body = json.dumps(request, separators=(',', ':')).encode()
call = urllib.request.Request('http://127.0.0.1:4187/github', data=body, method='POST', headers={'Content-Type': 'application/json'})
with urllib.request.urlopen(call, timeout=60) as response:
    sys.stdout.write(response.read().decode())
