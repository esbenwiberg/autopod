// Test-only preload for the packaged idle test. Never include in a release invocation.

import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { Server, Socket } from 'node:net';
import { promisify } from 'node:util';

function refuse(operation) {
  // Fail the process even if startup catches and suppresses an adapter error.
  process.stderr.write(`candidate idle fixture refused: ${operation}\n`);
  process.exit(82);
}

// Only an inbound loopback listener is required. No Entra, Azure, Docker socket,
// model, or provider request belongs in this test.
Socket.prototype.connect = () => refuse('outbound socket');
const listen = Server.prototype.listen;
Server.prototype.listen = function (options, ...args) {
  if (options?.host !== '127.0.0.1' || options?.port !== 0) refuse('non-fixture listener');
  return listen.call(this, options, ...args);
};
globalThis.fetch = () => refuse('outbound fetch');
const execFile = childProcess.execFile;
const gitArgs = (file, args, options) => {
  if (file !== 'git' || !Array.isArray(args) || !options?.env) refuse('subprocess');
  // Git may import the pinned local bundle but may not use any transport.
  return [file, args, { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: '' } }];
};
childProcess.execFile = (file, args, options, callback) =>
  execFile(...gitArgs(file, args, options), callback);
const exec = promisify(execFile);
childProcess.execFile[promisify.custom] = (file, args, options) =>
  exec(...gitArgs(file, args, options));
childProcess.spawn = () => refuse('subprocess');
childProcess.exec = () => refuse('subprocess');
childProcess.fork = () => refuse('subprocess');
childProcess.spawnSync = () => refuse('subprocess');
childProcess.execSync = () => refuse('subprocess');
childProcess.execFileSync = () => refuse('subprocess');
syncBuiltinESMExports();

const docker = `export default class IdleDocker {
  constructor() {
    return new Proxy(this, {
      get(target, key) {
        if (key === 'ping' || key === 'info') return target[key];
        process.stderr.write('candidate idle fixture refused: Docker operation\\n');
        process.exit(82);
      },
    });
  }
  async ping() {}
  async info() { return { MemTotal: 64 * 1024 ** 3 }; }
}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dockerode') {
      return { url: `data:text/javascript,${encodeURIComponent(docker)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
