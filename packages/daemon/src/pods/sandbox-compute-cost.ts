import type { PodResourceCost } from '@autopod/shared';
import type Database from 'better-sqlite3';

// Public active Consumption meters, retrieved 2026-11-21; not invoice amounts.
export const SANDBOX_RATES = {
  northeurope: ['4ebd2e58-3f2c-58a5-a442-8460e472dce7', 'c43d1f5d-5a92-5222-80a3-228227a1ddd8'],
  swedencentral: ['4ea1c35d-d999-57d0-88f2-e689d3475fcd', '05396e31-2622-5cc8-9bb4-06d0ac9c6047'],
} as const;
export interface ComputeObservation {
  resourceKey: string;
  sandboxId: string;
  podId: string;
  region: string;
  at: number;
  state: 'running' | 'stopped' | 'terminal' | 'unknown';
  cpu: number | null;
  gib: number | null;
}
interface Evidence {
  last: ComputeObservation;
  partial: boolean;
  // Compact totals grouped by pinned rate and allocation, rather than raw samples.
  prices: Record<
    string,
    {
      seconds: number;
      usd: number;
      cpu: number;
      gib: number;
      cpuMeter: string;
      memoryMeter: string;
      effective: string;
      retrieved: string;
      cpuUsd: number;
      gibUsd: number;
      source: string;
      currency: 'USD';
      sku: 'Standard';
    }
  >;
}
const usable = (n: number | null): n is number =>
  n !== null && Number.isFinite(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER;

export function createSandboxComputeCost(db: Database.Database) {
  const read = db.prepare('SELECT evidence FROM sandbox_compute_cost WHERE resource_key = ?');
  return {
    observe(o: ComputeObservation) {
      if (!Number.isFinite(o.at) || o.at < 0) return;
      db.transaction(() => {
        const row = read.get(o.resourceKey) as { evidence: string } | undefined;
        // The first observation cannot establish what ran before discovery.
        const e: Evidence = row ? JSON.parse(row.evidence) : { last: o, partial: true, prices: {} };
        if (row && (e.last.podId !== o.podId || e.last.sandboxId !== o.sandboxId)) return;
        if (row && e.last.state === 'terminal') return;
        if (row && o.at < e.last.at) return;
        if (row && o.at === e.last.at) {
          if (
            o.state !== e.last.state ||
            o.cpu !== e.last.cpu ||
            o.gib !== e.last.gib ||
            o.region !== e.last.region
          ) {
            e.partial = true;
            e.last = { ...e.last, state: 'unknown' };
            db.prepare('UPDATE sandbox_compute_cost SET evidence=? WHERE resource_key=?').run(
              JSON.stringify(e),
              o.resourceKey,
            );
          }
          return;
        }
        const previous = e.last;
        const gap = (o.at - previous.at) / 1000;
        const rate = Object.hasOwn(SANDBOX_RATES, previous.region)
          ? SANDBOX_RATES[previous.region as keyof typeof SANDBOX_RATES]
          : undefined;
        const known = o.state !== 'unknown' && previous.state !== 'unknown';
        const boundary = o.state === 'terminal' || o.state === 'stopped';
        const same =
          previous.region === o.region &&
          (boundary || (previous.cpu === o.cpu && previous.gib === o.gib));
        const allocation = previous.state === 'running' ? previous : o;
        const compatible =
          same ||
          (previous.state === 'stopped' && o.state === 'running' && previous.region === o.region);
        if (
          row &&
          (previous.state === 'running' || o.state === 'running') &&
          gap <= 90 &&
          known &&
          compatible &&
          rate &&
          usable(allocation.cpu) &&
          usable(allocation.gib)
        ) {
          const seconds =
            previous.state === 'running'
              ? gap * (o.state === 'running' ? 1 : 0.5)
              : o.state === 'running'
                ? gap * 0.5
                : 0;
          const key = `v1:${previous.region}:${allocation.cpu}:${allocation.gib}`;
          const p = e.prices[key] ?? {
            seconds: 0,
            usd: 0,
            cpu: allocation.cpu,
            gib: allocation.gib,
            cpuMeter: rate[0],
            memoryMeter: rate[1],
            effective: '2022-06-01',
            retrieved: '2026-11-21',
            cpuUsd: 0.000024,
            gibUsd: 0.000003,
            source: 'https://prices.azure.com/api/retail/prices',
            currency: 'USD' as const,
            sku: 'Standard' as const,
          };
          p.seconds += seconds;
          p.usd += seconds * (p.cpu * p.cpuUsd + p.gib * p.gibUsd);
          e.prices[key] = p;
        } else if (row && !(gap <= 90 && known && previous.state === 'stopped' && boundary))
          e.partial = true;
        if (!rate || (!boundary && (!usable(o.cpu) || !usable(o.gib))) || o.state === 'unknown')
          e.partial = true;
        e.last = o;
        db.prepare(`INSERT INTO sandbox_compute_cost(resource_key,sandbox_id,pod_id,evidence,settled) VALUES(?,?,?,?,?)
          ON CONFLICT(resource_key) DO UPDATE SET evidence=excluded.evidence,settled=excluded.settled`).run(
          o.resourceKey,
          o.sandboxId,
          o.podId,
          JSON.stringify(e),
          o.state === 'terminal' ? 1 : 0,
        );
      })();
    },
    last(resourceKey: string): ComputeObservation | undefined {
      const row = read.get(resourceKey) as { evidence: string } | undefined;
      return row ? (JSON.parse(row.evidence) as Evidence).last : undefined;
    },
    tracked(): ComputeObservation[] {
      return (
        db.prepare('SELECT evidence FROM sandbox_compute_cost WHERE settled=0').all() as {
          evidence: string;
        }[]
      )
        .map((r) => (JSON.parse(r.evidence) as Evidence).last)
        .filter((o) => o.state !== 'terminal');
    },
    get(podId: string): PodResourceCost {
      const rows = db
        .prepare('SELECT evidence FROM sandbox_compute_cost WHERE pod_id=?')
        .all(podId) as { evidence: string }[];
      const evidence = rows.map((r) => JSON.parse(r.evidence) as Evidence);
      const prices = evidence.flatMap((e) => Object.values(e.prices));
      return {
        state:
          prices.length === 0
            ? 'unavailable'
            : evidence.some(
                  (e) =>
                    e.partial || (e.last.state !== 'terminal' && Date.now() - e.last.at > 90_000),
                )
              ? 'partial'
              : 'estimated',
        estimateUsd: prices.length ? prices.reduce((sum, p) => sum + p.usd, 0) : null,
        observationCutoff: evidence.length
          ? new Date(Math.max(...evidence.map((e) => e.last.at))).toISOString()
          : null,
      };
    },
  };
}
