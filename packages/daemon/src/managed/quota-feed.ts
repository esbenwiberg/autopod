import type { ContainerManager } from '../interfaces/container-manager.js';
import { canonical } from './canonical.js';
import type { ManagedPodService } from './managed-service.js';
import { ManagedQuotaBroker } from './quota-broker.js';

/** Only trusted daemon exec can refresh this root-owned lease; stale feeds stop the worker. */
export class ManagedQuotaFeed {
  private readonly feeds = new Map<string, ReturnType<typeof setInterval>>();
  constructor(
    readonly service: ManagedPodService,
    readonly manager: ContainerManager,
  ) {}
  async attach(
    installation: string,
    podId: string,
    runtimeRef: string,
    stateRoot: string,
  ): Promise<void> {
    const row = this.service.row(installation, podId);
    if (row.runtime_ref !== runtimeRef || stateRoot !== `/run/dispatcher-${podId}`)
      throw new Error('managed-quota-feed-binding');
    const request = JSON.parse(row.request_json) as {
      route?: { executionTarget?: string };
    };
    const write = async () => {
      const snapshot = new ManagedQuotaBroker(this.service).snapshot(installation, podId);
      const payload = canonical(snapshot);
      let failure: unknown = new Error('managed-quota-feed-unavailable');
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          if (request.route?.executionTarget === 'sandbox') {
            // Azure rejects overlapping buffered exec operations. Keep the
            // supervisor lease independent of the channel's control-exec lane.
            await this.manager.writeFile(runtimeRef, `${stateRoot}/quota.json`, payload);
            return;
          }
          const result = await this.manager.execInContainer(
            runtimeRef,
            [
              'python3',
              '-c',
              `import os,sys
p=sys.argv[1];temporary=p+'.feed-tmp'
fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:f.write(sys.argv[2]);f.flush();os.fsync(f.fileno())
os.replace(temporary,p)
`,
              `${stateRoot}/quota.json`,
              payload,
            ],
            { user: 'root' },
          );
          if (result.exitCode === 0) return;
          failure = new Error('managed-quota-feed-unavailable');
        } catch (error) {
          failure = error;
        }
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
      throw failure;
    };
    await write();
    if (this.feeds.has(podId)) return;
    let active = false;
    const timer = setInterval(() => {
      if (active) return;
      active = true;
      void write()
        .catch(() => {
          // Keep the lease refresher alive after a transient Sandbox data-plane
          // outage. The supervisor remains fail-closed if the feed stays stale,
          // while a later interval can recover before that deadline.
        })
        .finally(() => {
          active = false;
        });
    }, 1000);
    timer.unref();
    this.feeds.set(podId, timer);
  }
  detach(podId: string): void {
    const timer = this.feeds.get(podId);
    if (timer) clearInterval(timer);
    this.feeds.delete(podId);
  }
  close(): void {
    for (const timer of this.feeds.values()) clearInterval(timer);
    this.feeds.clear();
  }
}
