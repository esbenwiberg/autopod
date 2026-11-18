import { randomUUID } from 'node:crypto';
import Dockerode from 'dockerode';
import pino from 'pino';
import { expect, it } from 'vitest';
import {
  DockerContainerManager,
  terminateStreamingProcessGroupScript,
} from './docker-container-manager.js';

/** Explicit cached Linux image with node, setsid and the autopod user. No mounts/network/pulls. */
it.skipIf(!process.env.AUTOPOD_DOCKER_REAPING_FIXTURE_IMAGE)(
  'reaps 2675 orphan tool processes and verifies the production cleanup within its existing test deadline',
  async () => {
    const image = process.env.AUTOPOD_DOCKER_REAPING_FIXTURE_IMAGE;
    const socketPath = process.env.AUTOPOD_DOCKER_REAPING_FIXTURE_SOCKET;
    if (!image || !/(?:^|@)sha256:[a-f0-9]{64}$/.test(image) || !socketPath) {
      throw new Error('Explicit immutable cached image and local Docker socket required');
    }
    const docker = new Dockerode({ socketPath });
    await docker.getImage(image).inspect(); // Refuse unavailable fixtures, never pull.
    const created: Dockerode.Container[] = [];
    const create = docker.createContainer.bind(docker);
    docker.createContainer = (async (options: Dockerode.ContainerCreateOptions) => {
      const container = await create({
        ...options,
        Labels: { ...options.Labels, 'autopod.fixture': 'worker-reaping' },
        HostConfig: { ...options.HostConfig, PidsLimit: 3072 },
      });
      created.push(container);
      return container;
    }) as typeof docker.createContainer;
    const manager = new DockerContainerManager({ docker, logger: pino({ level: 'silent' }) });
    try {
      const id = await manager.spawn({
        podId: `reaping-fixture-${randomUUID()}`,
        image,
        env: {},
        networkName: 'none',
        exposeHostGateway: false,
        workingDir: '/tmp',
        memoryBytes: 256 * 1024 * 1024,
        nanoCpus: 2_000_000_000,
      });
      const observed = await docker.getContainer(id).inspect();
      expect(observed.HostConfig.Init).toBe(true);
      expect(observed.Mounts).toHaveLength(0);
      expect(observed.HostConfig.NetworkMode).toBe('none');
      const probe = `
const fs = require('node:fs');
const cp = require('node:child_process');
const terminate = ${terminateStreamingProcessGroupScript.toString()};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function zombies() {
  return fs.readdirSync('/proc').filter(p => /^\\d+$/.test(p)).filter(p => {
    try { return fs.readFileSync('/proc/'+p+'/stat','utf8').split(') ')[1].split(' ')[0] === 'Z'; }
    catch { return false; }
  }).length;
}
(async () => {
  for (let i=0; i<2675; i++) {
    await new Promise((resolve,reject) => {
      const child=cp.spawn('sh',['-c','sleep 0.03 &'],{stdio:'ignore'});
      child.on('error',reject); child.on('exit',resolve);
    });
  }
  for (let i=0; i<100 && zombies(); i++) await delay(10);
  const accumulated=zombies();
  const pid='/tmp/reaping-group.pid';
  const ready='/tmp/reaping-child.ready';
  fs.writeFileSync('/tmp/reaping-child.sh','trap "" TERM; echo $$ > '+ready+'; while :; do sleep 1; done\\n');
  const group=cp.spawn('setsid',['-w','sh','-c',
    'echo $$ > '+pid+'; sh /tmp/reaping-child.sh & wait'
  ],{stdio:'ignore'});
  try {
    for(let i=0;i<100 && !fs.existsSync(ready);i++) await delay(10);
    if (!fs.existsSync(ready)) throw new Error('Owned child was not ready');
    const result=cp.spawnSync('sh',['-c',terminate(pid)],{timeout:6000,encoding:'utf8'});
    console.log(JSON.stringify({zombies:accumulated,exitCode:result.status,error:result.error?.code ?? null}));
  } finally { group.kill('SIGKILL'); }
})().catch(error => { console.error(error);process.exitCode=1; });
`;
      const result = await manager.execInContainer(id, ['node', '-e', probe], { timeout: 60_000 });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ zombies: 0, exitCode: 0, error: null });
    } finally {
      const results = await Promise.allSettled(
        created.map((container) => container.remove({ force: true, v: true })),
      );
      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    }
  },
  90_000,
);
