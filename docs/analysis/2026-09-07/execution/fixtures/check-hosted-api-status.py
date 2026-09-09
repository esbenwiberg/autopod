"""PROPOSED authenticated API read. Requires specific approval after auto-review rejection.

Bearer token is kept in memory, never printed or written. Fixed origin, no redirects.
Response bodies are read transiently (2 MiB cap each) and never retained/exported.
"""
import datetime
import json
import subprocess
import signal
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError()))
    try:
        auth = subprocess.run(['ap', 'token'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              text=True, timeout=30)
    except Exception:
        print(json.dumps({'status': 'existing_auth_unavailable'}))
        return
    token = auth.stdout.strip()
    if auth.returncode or not token.startswith('eyJ') or token.count('.') != 2:
        print(json.dumps({'status': 'existing_auth_unavailable'}))
        return
    opener = urllib.request.build_opener(NoRedirect())
    records = []
    for route in ('/health?detail=full', '/pods?compact=true&limit=10',
                  '/pods?limit=10', '/pods/analytics/cost?days=30'):
        item = {'observedAtUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'path': route}
        request = urllib.request.Request('https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com' + route,
                                         headers={'Authorization': 'Bearer ' + token})
        signal.alarm(20)
        try:
            with opener.open(request, timeout=20) as response:
                body = response.read(2 * 1024**2 + 1)
                item.update(status=response.status, bytes=len(body), bodyLimitExceeded=len(body) > 2 * 1024**2)
        except urllib.error.HTTPError as error:
            body = error.read(2 * 1024**2 + 1)
            item.update(status=error.code, bytes=len(body), bodyLimitExceeded=len(body) > 2 * 1024**2)
        except Exception:
            item['status'] = 'request_incomplete'
        finally:
            signal.alarm(0)
        records.append(item)
    print(json.dumps(records, separators=(',', ':')))


if __name__ == '__main__':
    main()
