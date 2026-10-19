#!/usr/bin/env python3
"""Credential-free public HTTPS GET through the attempt-bound host broker."""
import json
import sys
import urllib.request
if len(sys.argv) != 2:
    raise SystemExit('usage: public-read https://...')
body = json.dumps({'url': sys.argv[1]}, separators=(',', ':')).encode()
call = urllib.request.Request('http://127.0.0.1:4187/public-read', data=body,
    method='POST', headers={'Content-Type': 'application/json'})
with urllib.request.urlopen(call, timeout=60) as response:
    sys.stdout.write(response.read().decode())
