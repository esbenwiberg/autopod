import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export const API_VERSION = '2026-02-01-preview';
export const MAX_BYTES = 1024 * 1024;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const safeId = (value) => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);

export function validateTarget(target) {
  assert.match(
    target.subscriptionId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
  );
  for (const key of ['resourceGroup', 'sandboxGroup', 'readyDiskImageId']) {
    assert(safeId(target[key]), `invalid-${key}`);
  }
  assert.match(target.location, /^[a-z]{2,30}$/);
  assert.match(target.image, /^[a-z0-9]+\.azurecr\.io\/[\w./-]+@sha256:[a-f0-9]{64}$/);
  assert.match(
    target.imagePullIdentityResourceId,
    /^\/subscriptions\/[\w-]+\/resourceGroups\/[\w-]+\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[\w-]+$/i,
  );
  return target;
}

export function endpoints(target) {
  const group = `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/sandboxGroups/${target.sandboxGroup}`;
  return { group, base: `https://management.${target.location}.azuredevcompute.io${group}` };
}

export function listItems(value) {
  if (Array.isArray(value)) return value;
  assert(value && !value.nextLink && !value.continuationToken, 'incomplete-list');
  const items = value.value ?? value.items ?? value.sandboxes ?? value.diskImages;
  assert(Array.isArray(items), 'unknown-list-shape');
  return items;
}

export function verifyCache(target, images) {
  const sourceHash = sha256(target.image).slice(0, 16);
  const digest = target.image.split('@')[1];
  const candidates = images.filter((image) => {
    const labels = image.labels ?? image.properties?.labels;
    return labels?.managedBy === 'autopod' && labels.sourceImageHash === sourceHash;
  });
  assert.equal(candidates.length, 1, 'ambiguous-or-stale-cache');
  const image = candidates[0];
  assert.equal(image.id, target.readyDiskImageId);
  assert.equal(image.image?.base, target.image);
  assert.equal((image.labels ?? image.properties?.labels)?.sourceDigest, digest);
  assert(['Ready', 'Succeeded'].includes(image.status?.state ?? image.properties?.status?.state));
}

export function verifyOwner(object, runId, initialIds) {
  assert(safeId(object?.id), 'invalid-sandbox-id');
  assert(!initialIds.includes(object.id), 'preexisting-sandbox');
  assert.equal(object.labels?.podId, runId, 'wrong-pod-label');
  assert.equal(object.labels?.managedBy, 'autopod', 'wrong-manager-label');
  assert.equal(object.labels?.purpose, 'autopod-sandbox', 'wrong-purpose-label');
}

/** Forward unchanged requests/responses, with bounds encompassing the response body. */
export function createGuard({
  target,
  receipt,
  save,
  cleanup = false,
  transport = fetch,
  socketFactory = (url, headers) => new WebSocket(url, { headers }),
  requestMs = 30_000,
  createMs = 60_000,
  socketMs = 30_000,
}) {
  const { base } = endpoints(target);
  let confirmedId;
  let closed = false;
  let requestCount = 0;
  let responseBytes = 0;
  const sockets = new Set();
  const controllers = new Set();
  const deny = (code) => {
    receipt.guardFailures ??= [];
    receipt.guardFailures.push(code);
    save();
    throw new Error(code);
  };
  const owned = (id) => id && id === receipt.acceptedId && id === confirmedId;
  const adopt = (object) => {
    verifyOwner(object, receipt.runId, receipt.initialIds);
    assert(!receipt.acceptedId || receipt.acceptedId === object.id, 'conflicting-owned-id');
    receipt.acceptedId = confirmedId = object.id;
    save();
  };
  const guardedFetch = async (input, init = {}) => {
    if (closed) return deny('guard-closed');
    const url = new URL(input);
    if (url.username || url.password || url.hash || !url.href.startsWith(`${base}/`)) {
      return deny('http-target-denied');
    }
    const path = url.pathname.slice(new URL(base).pathname.length);
    if (url.searchParams.get('api-version') !== API_VERSION) return deny('api-version-denied');
    const method = init.method ?? 'GET';
    const create = method === 'PUT' && path === '/sandboxes';
    const match = /^\/sandboxes\/([\w-]+)(\/.*)?$/.exec(path);
    if (create) {
      if (cleanup || receipt.createAttempted) return deny('second-or-cleanup-create-denied');
      if (!receipt.preflightPassed) return deny('preflight-required');
      assert.deepEqual(JSON.parse(init.body), {
        sourcesRef: { diskImage: { id: target.readyDiskImageId } },
        resources: { cpu: '500m', memory: '1024Mi', disk: '10Gi' },
        lifecycle: { autoSuspendPolicy: { enabled: true, interval: 900, mode: 'Memory' } },
        environment: {},
        egressPolicy: { defaultAction: 'Deny' },
        labels: { purpose: 'autopod-sandbox', managedBy: 'autopod', podId: receipt.runId },
      });
      receipt.createAttempted = true;
      receipt.createIntentAt = Date.now();
      save(); // Durable before the first byte is sent. Never retry an uncertain create.
    } else if (method === 'GET') {
      if (
        !/^\/(sandboxes|diskimages)(\/[\w-]+)?$/.test(path) &&
        !(match && owned(match[1]) && /^\/files(?:\/list|\/stat)?$/.test(match[2]))
      ) {
        return deny('read-path-denied');
      }
    } else {
      if (!match || !owned(match[1])) return deny('unowned-mutation-denied');
      const suffix = match[2] ?? '';
      const allowed =
        (method === 'DELETE' && suffix === '') ||
        (!cleanup &&
          ((method === 'PUT' && suffix === '/files') ||
            (method === 'POST' &&
              ['/executeShellCommand', '/files/mkdir', '/egresspolicy', '/resume'].includes(
                suffix,
              ))));
      if (!allowed) return deny('mutation-path-denied');
      if (suffix === '/resume' && init.body !== undefined) return deny('resume-body-denied');
      if (suffix === '/egresspolicy')
        assert.deepEqual(JSON.parse(init.body), { defaultAction: 'Deny' });
    }
    if (init.body && Buffer.byteLength(init.body) > MAX_BYTES) return deny('request-size-denied');
    if (++requestCount > 1000) return deny('request-count-denied');
    const observed = { phase: cleanup ? 'cleanup' : 'work', method, path, status: null };
    receipt.requests ??= [];
    receipt.requests.push(observed);
    save();
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), create ? createMs : requestMs);
    const signal = AbortSignal.any([controller.signal, ...(init.signal ? [init.signal] : [])]);
    let reader;
    try {
      const response = await transport(input, { ...init, signal, redirect: 'error' });
      observed.status = response.status;
      save();
      reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      while (reader) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        responseBytes += value.byteLength;
        if (size > MAX_BYTES || responseBytes > 8 * MAX_BYTES) return deny('response-size-denied');
        chunks.push(Buffer.from(value));
      }
      signal.throwIfAborted();
      const body = Buffer.concat(chunks);
      observed.bytes = size;
      if (create && response.ok) {
        const object = JSON.parse(body.toString());
        if (!safeId(object.id) || receipt.initialIds.includes(object.id))
          return deny('create-id-denied');
        receipt.acceptedId = object.id;
        receipt.acceptedAt = Date.now();
      }
      if (
        method === 'GET' &&
        match &&
        !match[2] &&
        response.status === 200 &&
        match[1] === receipt.acceptedId
      ) {
        const object = JSON.parse(body.toString());
        assert.equal(object.id, match[1]);
        adopt(object);
      }
      save(); // Accepted ID survives a crash during production readiness polling.
      return new Response(body.length ? body : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      clearTimeout(timeout);
      controller.abort();
      void reader?.cancel().catch(() => {});
      controllers.delete(controller);
    }
  };
  const webSocket = (url, headers) => {
    const expected = `${base.replace('https:', 'wss:')}/sandboxes/${receipt.acceptedId}/exec/stream`;
    if (closed || cleanup || !owned(receipt.acceptedId) || url !== expected)
      return deny('socket-target-denied');
    const socket = socketFactory(url, headers);
    let socketClosed = false;
    const wrapper = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data) {
        if (socketClosed) return fail('socket-closed');
        if (typeof data !== 'string' || Buffer.byteLength(data) > 65536)
          return fail('socket-send-size');
        socket.send(data);
      },
      close() {
        if (socketClosed) return;
        socketClosed = true;
        clearTimeout(timer);
        sockets.delete(wrapper);
        socket.close();
      },
    };
    const fail = (code) => {
      receipt.guardFailures ??= [];
      receipt.guardFailures.push(code);
      save();
      wrapper.close();
      wrapper.onerror?.(new Error(code));
    };
    const timer = setTimeout(() => fail('socket-deadline'), socketMs);
    sockets.add(wrapper);
    let bytes = 0;
    socket.onopen = (event) => {
      if (!socketClosed) wrapper.onopen?.(event);
    };
    socket.onmessage = (event) => {
      if (socketClosed) return;
      if (typeof event.data !== 'string') return fail('socket-nontext-frame');
      const size = Buffer.byteLength(event.data);
      bytes += size;
      if (size > 65536 || bytes > MAX_BYTES) return fail('socket-receive-size');
      wrapper.onmessage?.(event);
    };
    socket.onerror = () => {
      wrapper.close();
      wrapper.onerror?.(new Error('socket-error'));
    };
    socket.onclose = (event) => {
      socketClosed = true;
      clearTimeout(timer);
      sockets.delete(wrapper);
      wrapper.onclose?.(event);
    };
    return wrapper;
  };
  return {
    fetch: guardedFetch,
    webSocket,
    adopt,
    close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      for (const socket of sockets) socket.close();
    },
  };
}

/** Resolve only after the process is gone; cleanup cannot race a late work request. */
export function supervise(file, args, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { stdio: 'ignore' });
    let timedOut = false;
    const stop = () => {
      timedOut = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.once('error', reject);
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve({ code, signal: exitSignal, timedOut });
    });
  });
}
