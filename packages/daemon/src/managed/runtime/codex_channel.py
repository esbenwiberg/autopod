"""Root-owned, per-container loopback endpoint. No provider network or credentials.

The daemon retrieves bounded requests through trusted exec and publishes each
response. The worker cannot access this root-owned spool or refresh its quota lease.
"""
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import threading
import time
import uuid

AGENT_FAILURE_REASONS = {
    'context-window-exceeded',
    'tool-permission-denied',
    'channel-unavailable',
    'cli-exit',
}

REPORT_MAX_REQUEST = 128 * 1024
AGENT_MAX_REQUEST = 1024 * 1024
# A validated agent-mode SSE transcript includes reasoning and tool events in
# addition to the final artifact. The host gateway remains the authority for the
# exact per-transport bound and never writes more than this hard channel ceiling.
MAX_RESPONSE = 1024 * 1024


def atomic(file, data):
    temporary = file.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(data, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file)


def serve(root, port, lifetime, maximum_request=REPORT_MAX_REQUEST):
    if maximum_request not in (REPORT_MAX_REQUEST, AGENT_MAX_REQUEST):
        raise RuntimeError('request-limit-invalid')
    lock = (root / 'channel.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    deadline = time.monotonic() + lifetime
    serial = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, body=b''):
            try:
                self.send_response(status)
                self.send_header('Content-Type', 'text/event-stream' if status == 200 else 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if self.path == '/health':
                self.reply(204)
                return
            if self.path != '/followups':
                self.reply(404)
                return
            try:
                for item in sorted(root.glob('followup-*.json')):
                    key = item.name[len('followup-'):-len('.json')]
                    if not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', key) or (root / ('followup-' + key + '.ack')).exists():
                        continue
                    value = json.loads(item.read_text())
                    message = value.get('message')
                    if not isinstance(message, str) or not 0 < len(message.encode()) <= 4096:
                        raise ValueError('followup')
                    body = json.dumps({'key': key, 'message': message}, ensure_ascii=False, separators=(',', ':')).encode()
                    self.reply(200, body)
                    return
                self.reply(204)
            except (OSError, ValueError, KeyError):
                self.reply(400)

        def do_POST(self):
            if not serial.acquire(blocking=False):
                self.reply(409)
                return
            try:
                self.handle_post()
            finally:
                serial.release()

        def handle_post(self):
            self.connection.settimeout(5)
            if self.path.startswith('/followups/'):
                key = self.path[len('/followups/'):]
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', key) or self.headers.get('Content-Length') not in (None, '0'):
                    self.reply(403)
                    return
                item = root / ('followup-' + key + '.json')
                if not item.exists():
                    self.reply(404)
                    return
                atomic(root / ('followup-' + key + '.ack'), {'observed': True})
                self.reply(204)
                return
            if self.path == '/failure':
                try:
                    if self.headers.get('Authorization') or self.headers.get('Transfer-Encoding'):
                        raise ValueError('headers')
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 1 <= length <= 1024:
                        raise ValueError('size')
                    value = json.loads(self.rfile.read(length))
                    if (
                        not isinstance(value, dict)
                        or set(value) != {'phase', 'reason', 'exitCode'}
                        or value.get('phase') != 'agent'
                        or value.get('reason') not in AGENT_FAILURE_REASONS
                        or not isinstance(value.get('exitCode'), int)
                        or not 1 <= value['exitCode'] <= 255
                    ):
                        raise ValueError('failure')
                    atomic(root / 'channel-failure.json', value)
                    self.reply(204)
                except (OSError, ValueError, KeyError):
                    self.reply(400)
                return
            if self.path == '/v1/responses/compact':
                atomic(root / 'channel-failure.json', {
                    'phase': 'request',
                    'reason': 'unsupported-auto-compaction',
                })
                self.reply(501)
                return
            github = self.path == '/github'
            if self.path not in ('/v1/responses', '/github') or self.headers.get('Authorization') or self.headers.get('Transfer-Encoding'):
                self.reply(403)
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length > maximum_request:
                    atomic(root / 'channel-failure.json', {
                        'phase': 'request',
                        'reason': 'request-limit',
                        'actualBytes': length,
                        'maximumBytes': maximum_request,
                    })
                    self.reply(413)
                    return
                if length < 1:
                    raise ValueError('size')
                data = self.rfile.read(length)
                if len(data) != length:
                    raise ValueError('truncated')
                raw = data.decode('utf8')
                prefix = 'github-' if github else 'channel-'
                if github and not (root / 'github-enabled').exists():
                    self.reply(403)
                    return
                request = {'digest': hashlib.sha256(data).hexdigest(), 'body': raw, 'ticket': str(uuid.uuid4())}
                (root / 'channel-failure.json').unlink(missing_ok=True)
                # Each HTTP delivery needs a fresh host authority check. Only provider
                # execution is replayed from the durable gateway journal.
                atomic(root / (prefix + 'request.json'), request)
                while time.monotonic() < deadline:
                    if (root / 'revoked').exists() or (root / 'channel-closed').exists():
                        self.reply(410)
                        return
                    response = root / (prefix + 'response.json')
                    if response.exists():
                        result = json.loads(response.read_text())
                        if result.get('ticket') != request['ticket']:
                            time.sleep(0.05)
                            continue
                        if result['digest'] != request['digest']:
                            raise ValueError('binding')
                        body = result.get('body', '').encode()
                        if len(body) > MAX_RESPONSE:
                            raise ValueError('size')
                        self.reply(200 if result.get('ok') else 502, body if result.get('ok') else b'')
                        return
                    time.sleep(0.05)
                self.reply(504)
            except (OSError, ValueError, KeyError):
                self.reply(400)

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    server.timeout = 0.2
    atomic(root / 'channel-ready.json', {'port': server.server_port})
    try:
        while time.monotonic() < deadline and not (root / 'channel-closed').exists() and not (root / 'revoked').exists():
            server.handle_request()
    finally:
        server.server_close()
        lock.close()


if __name__ == '__main__':
    import sys
    root = Path(sys.argv[1])
    if root.is_symlink() or not root.is_dir() or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise RuntimeError('channel-root-not-private')
    os.umask(0o077)
    maximum_request = int(sys.argv[4]) if len(sys.argv) > 4 else REPORT_MAX_REQUEST
    serve(root, int(sys.argv[2]), min(3600, max(1, int(sys.argv[3]))), maximum_request)
