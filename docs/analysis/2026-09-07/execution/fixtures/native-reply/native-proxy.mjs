import { createServer } from 'node:http';
const podDefaults = {
  title: 'Local acceptance fixture',
  executionTarget: 'sandbox',
  branch: 'fixture/acceptance',
  hasWebUi: false,
  userId: 'local-fixture',
  filesChanged: 0,
  linesAdded: 0,
  linesRemoved: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  commitCount: 0,
  outputMode: 'pr',
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:31992');
  const finish = (value, status = 200) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(value));
  };
  try {
    console.log(JSON.stringify({ method: req.method, path: url.pathname }));
    if (
      [
        '/profiles',
        '/memory',
        '/memory/candidates',
        '/scheduled-jobs',
        '/scheduled-job-templates',
      ].includes(url.pathname)
    )
      return finish([]);
    if (req.method === 'POST' && url.pathname === '/pods/local-fixture/message')
      return finish({ error: 'Reply was not stored' }, 500);
    if (url.pathname === '/version') return finish({ version: 'local-acceptance' });
    if (url.pathname === '/pods/stats') return finish({ counts: { awaiting_input: 1 } });
    const body =
      req.method === 'GET' ? undefined : await Array.fromAsync(req).then((a) => Buffer.concat(a));
    const response = await fetch(`http://127.0.0.1:31991${req.url}`, {
      method: req.method,
      body,
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    let data = await response.json();
    if (url.pathname === '/pods' && req.method === 'GET') {
      data = data.map((p) => ({ ...podDefaults, ...p, title: 'Local acceptance fixture' }));
      if (url.searchParams.get('page') === 'true') data = { pods: data, nextCursor: null };
    } else if (url.pathname === '/pods/local-fixture' && req.method === 'GET')
      data = { ...podDefaults, ...data };
    finish(data, response.status);
  } catch {
    finish({ error: 'local_fixture_error' }, 500);
  }
});
server.on('upgrade', (_req, socket) => socket.destroy());
server.listen(31992, '127.0.0.1', () => console.log('Native proxy ready on 31992'));
