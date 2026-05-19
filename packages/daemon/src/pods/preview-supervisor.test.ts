import { describe, expect, it } from 'vitest';
import { buildSupervisorCommand, parseStatus } from './preview-supervisor.js';

describe('buildSupervisorCommand', () => {
  it('produces a stable shell string for a simple start command (snapshot)', () => {
    const cmd = buildSupervisorCommand('pnpm dev');
    expect(cmd).toMatchInlineSnapshot(`
      "export START_COMMAND='pnpm dev'
      i=0
      rm -f /tmp/autopod-supervisor.pid /tmp/autopod-restart-count /tmp/autopod-start.log
      echo 0 > /tmp/autopod-restart-count
      (
        while true; do
          eval "$START_COMMAND" >> /tmp/autopod-start.log 2>&1 || true
          i=$((i+1))
          echo $i > /tmp/autopod-restart-count
          if [ $i -ge 5 ]; then sleep 5; else sleep 1; fi
        done
      ) &
      echo $! > /tmp/autopod-supervisor.pid"
    `);
  });

  it('escapes single quotes in the start command', () => {
    const cmd = buildSupervisorCommand('node -e "require(\'app\').start()"');
    expect(cmd).toContain('export START_COMMAND=\'node -e "require(');
    expect(cmd).toContain('eval "$START_COMMAND"');
  });

  it('writes logs to /tmp/autopod-start.log', () => {
    const cmd = buildSupervisorCommand('npm start');
    expect(cmd).toContain('/tmp/autopod-start.log');
  });

  it('writes pid to /tmp/autopod-supervisor.pid', () => {
    const cmd = buildSupervisorCommand('npm start');
    expect(cmd).toContain('/tmp/autopod-supervisor.pid');
  });
});

describe('parseStatus', () => {
  it('pid present + 200 → running=true, reachable=true', () => {
    const status = parseStatus({
      pid: '12345',
      restartCount: '0',
      startLogTail: null,
      reachableHttp: 200,
    });
    expect(status).toEqual({ running: true, reachable: true, restartCount: 0, lastError: null });
  });

  it('pid present + non-2xx → running=true, reachable=false', () => {
    const status = parseStatus({
      pid: '12345',
      restartCount: '2',
      startLogTail: null,
      reachableHttp: 503,
    });
    expect(status).toEqual({ running: true, reachable: false, restartCount: 2, lastError: null });
  });

  it('no pid + 200 → running=false, reachable=false', () => {
    const status = parseStatus({
      pid: null,
      restartCount: null,
      startLogTail: null,
      reachableHttp: 200,
    });
    expect(status).toEqual({ running: false, reachable: false, restartCount: 0, lastError: null });
  });

  it('no pid + null http → running=false, reachable=false', () => {
    const status = parseStatus({
      pid: null,
      restartCount: null,
      startLogTail: null,
      reachableHttp: null,
    });
    expect(status).toEqual({ running: false, reachable: false, restartCount: 0, lastError: null });
  });

  it('pid present + null http → running=true, reachable=false (supervisor alive but unreachable)', () => {
    const status = parseStatus({
      pid: '42',
      restartCount: '1',
      startLogTail: null,
      reachableHttp: null,
    });
    expect(status).toEqual({ running: true, reachable: false, restartCount: 1, lastError: null });
  });

  it('extracts last error line from a multi-line start-log tail', () => {
    const logTail = 'Starting server...\nError: EADDRINUSE port 3000\nFailed to start';
    const status = parseStatus({
      pid: null,
      restartCount: '3',
      startLogTail: logTail,
      reachableHttp: null,
    });
    expect(status.lastError).toBe('Failed to start');
  });

  it('extracts last non-empty line when log tail has trailing newlines', () => {
    const logTail = 'Error: connection refused\n\n\n';
    const status = parseStatus({
      pid: '1',
      restartCount: '0',
      startLogTail: logTail,
      reachableHttp: null,
    });
    expect(status.lastError).toBe('Error: connection refused');
  });

  it('returns null lastError when start-log tail is null', () => {
    const status = parseStatus({
      pid: '1',
      restartCount: '0',
      startLogTail: null,
      reachableHttp: 200,
    });
    expect(status.lastError).toBeNull();
  });

  it('returns null lastError when start-log tail is empty', () => {
    const status = parseStatus({
      pid: '1',
      restartCount: '0',
      startLogTail: '',
      reachableHttp: 200,
    });
    expect(status.lastError).toBeNull();
  });

  it('handles restartCount that is not a number', () => {
    const status = parseStatus({
      pid: '1',
      restartCount: 'bad',
      startLogTail: null,
      reachableHttp: 200,
    });
    expect(status.restartCount).toBe(0);
  });
});
