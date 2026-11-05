import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  AutopodError,
  type InputBundleRef,
  inputBundleRefSchema,
  MAX_REFERENCE_PREVIEW_BYTES,
  REFERENCE_PREVIEW_VIEWPORT,
  REFERENCE_RENDERER_PROTOCOL,
  type ReferencePreviewReceipt,
  referencePreviewReceiptSchema,
  referenceRendererImageSchema,
} from '@autopod/shared';
import type Dockerode from 'dockerode';
import { inputImageDimensions } from './image-dimensions.js';

export interface ReferencePreview {
  receipt: ReferencePreviewReceipt;
  bytes: Buffer;
}
export interface ReferenceRenderer {
  readonly image: string;
  available?(): Promise<boolean>;
  render(
    ref: InputBundleRef,
    entrypoint: string,
    files: readonly Buffer[],
  ): Promise<ReferencePreview>;
}
export function verifyReferencePreview(
  preview: ReferencePreview,
  ref: InputBundleRef,
  entrypoint: string,
  image: string,
): ReferencePreview {
  const receipt = referencePreviewReceiptSchema.parse(preview.receipt);
  const source = ref.files.find((file) => file.path === entrypoint);
  const dimensions = inputImageDimensions(preview.bytes, 'image/jpeg');
  if (
    !receipt.resourceSha256s.includes(receipt.sourceSha256) ||
    receipt.resourceSha256s.some((hash) => !ref.files.some((file) => file.sha256 === hash)) ||
    !source ||
    source.mediaType !== 'text/html' ||
    receipt.entrypoint !== entrypoint ||
    receipt.bundleDigest !== ref.digest ||
    receipt.sourceSha256 !== source.sha256 ||
    receipt.rendererImage !== image ||
    preview.bytes.length !== receipt.byteLength ||
    preview.bytes[0] !== 0xff ||
    preview.bytes[1] !== 0xd8 ||
    createHash('sha256').update(preview.bytes).digest('hex') !== receipt.sha256 ||
    dimensions?.width !== receipt.width ||
    dimensions?.height !== receipt.height
  )
    throw new AutopodError(
      'Reference renderer output does not match its admitted source',
      'REFERENCE_PREVIEW_MISMATCH',
      409,
    );
  return { receipt, bytes: Buffer.from(preview.bytes) };
}

export interface ReferenceRendererDocker {
  createContainer(options: Dockerode.ContainerCreateOptions): Promise<Dockerode.Container>;
  getImage(name: string): Dockerode.Image;
  modem: Pick<Dockerode['modem'], 'demuxStream'>;
}

/** A separate short-lived Docker sandbox: no worker mounts, tokens, ports, Docker socket or egress. */
export class DockerReferenceRenderer implements ReferenceRenderer {
  readonly image: string;
  private active = 0;
  private cleanupUncertain = false;
  constructor(
    private readonly docker: ReferenceRendererDocker,
    image: string,
    private readonly timeoutMs = 30_000,
  ) {
    this.image = referenceRendererImageSchema.parse(image);
  }
  async available(): Promise<boolean> {
    if (this.cleanupUncertain) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.docker
          .getImage(this.image)
          .inspect()
          .then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 1000);
        }),
      ]);
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async render(
    input: InputBundleRef,
    entrypoint: string,
    files: readonly Buffer[],
  ): Promise<ReferencePreview> {
    const ref = inputBundleRefSchema.parse(input);
    if (this.cleanupUncertain)
      throw new AutopodError(
        'Reference renderer cleanup requires reconciliation',
        'REFERENCE_RENDER_CLEANUP_UNCERTAIN',
        503,
      );
    if (this.active >= 2)
      throw new AutopodError(
        'Reference renderer is busy; retry shortly',
        'REFERENCE_RENDER_BUSY',
        429,
      );
    const source = ref.files.find((file) => file.path === entrypoint);
    if (source?.mediaType !== 'text/html' || files.length !== ref.files.length)
      throw new AutopodError('Select an admitted HTML reference', 'REFERENCE_RENDER_INPUT', 400);
    this.active++;
    let container: Dockerode.Container | undefined;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async (): Promise<ReferencePreview> => {
      container = await this.docker.createContainer({
        Image: this.image,
        User: '1000:1000',
        Entrypoint: [],
        Cmd: [
          '/usr/bin/timeout',
          '--signal=KILL',
          '25s',
          'node',
          '/opt/autopod-reference-renderer/render.cjs',
        ],
        Env: ['HOME=/tmp/reference-home'],
        WorkingDir: '/tmp',
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: true,
        OpenStdin: true,
        StdinOnce: true,
        Tty: false,
        Labels: { 'autopod.component': 'reference-renderer' },
        HostConfig: {
          NetworkMode: 'none',
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          Memory: 1024 ** 3,
          MemorySwap: 1024 ** 3,
          NanoCpus: 1e9,
          PidsLimit: 256,
          AutoRemove: true,
          Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m,mode=1777' },
          LogConfig: { Type: 'none', Config: {} },
        },
      });
      const target = container;
      if (expired) {
        if (!(await removeRenderer(target))) this.cleanupUncertain = true;
        throw new Error('Reference allocation expired');
      }
      const stream = await target.attach({
        hijack: true,
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
      });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.on('error', () => {});
      stderr.on('error', () => {});
      stream.on('end', () => {
        stdout.end();
        stderr.end();
      });
      stream.on('close', () => {
        stdout.end();
        stderr.end();
      });
      stream.on('error', (error) => {
        stdout.destroy(error);
        stderr.destroy(error);
      });
      this.docker.modem.demuxStream(stream, stdout, stderr);
      const output = collect(stdout, Math.ceil((MAX_REFERENCE_PREVIEW_BYTES * 4) / 3) + 16_384);
      const diagnostics = collect(stderr, 4096, true);
      // Install rejection handlers before asynchronous allocation/upload can suspend.
      void output.catch(() => {});
      void diagnostics.catch(() => {});
      await target.start();
      const stopped = target.wait();
      void stopped.catch(() => {});
      if (expired) throw new Error('Reference allocation expired');
      const payload = renderPayload(ref, entrypoint, files, this.image);
      await new Promise<void>((resolve, reject) =>
        stream.write(payload, (error?: Error | null) => (error ? reject(error) : resolve())),
      );
      const [exit, encoded, diagnostic] = await Promise.all([stopped, output, diagnostics]);
      if (expired || exit.StatusCode !== 0) {
        const stage =
          diagnostic
            .toString('utf8')
            .match(
              /REFERENCE_RENDER_(?:FAILED|TIMEOUT):(input|browser|context|navigation|images|screenshot|output|cleanup)\b/,
            )?.[1] ?? 'unknown';
        throw new AutopodError(
          `Isolated reference render failed (exit ${exit.StatusCode}, stage ${stage})`,
          'REFERENCE_RENDER_FAILED',
          503,
        );
      }
      const result = JSON.parse(encoded.toString('utf8')) as {
        receipt: ReferencePreviewReceipt;
        base64: string;
      };
      if (
        typeof result.base64 !== 'string' ||
        result.base64.length > Math.ceil((MAX_REFERENCE_PREVIEW_BYTES * 4) / 3) + 4
      )
        throw new Error('Reference raster exceeds bounds');
      return verifyReferencePreview(
        { receipt: result.receipt, bytes: Buffer.from(result.base64, 'base64') },
        ref,
        entrypoint,
        this.image,
      );
    };
    let result: ReferencePreview | undefined;
    let failed = false;
    let failure: unknown;
    let cleaned = true;
    try {
      result = await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(
              new AutopodError('Reference renderer timed out', 'REFERENCE_RENDER_TIMEOUT', 503),
            );
          }, this.timeoutMs);
        }),
      ]);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      expired = true;
      if (timer) clearTimeout(timer);
      if (container) cleaned = await removeRenderer(container);
      if (cleaned) this.active--;
      else this.cleanupUncertain = true;
    }
    if (!cleaned)
      throw new AutopodError(
        'Reference renderer cleanup is unconfirmed; new rendering is blocked until reconciled',
        'REFERENCE_RENDER_CLEANUP_UNCERTAIN',
        503,
      );
    if (failed || !result) {
      if (failure instanceof AutopodError) throw failure;
      throw new AutopodError(
        'Isolated reference renderer is unavailable or returned invalid output',
        'REFERENCE_RENDER_FAILED',
        503,
      );
    }
    return result;
  }
}
async function removeRenderer(container: Dockerode.Container): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const removed = await Promise.race([
        container
          .remove({ force: true })
          .then(() => true)
          .catch((error: unknown) => {
            const status =
              error && typeof error === 'object'
                ? (error as { statusCode?: number }).statusCode
                : undefined;
            return status === 404 ? true : status === 409 ? null : false;
          }),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(1, deadline - Date.now()));
        }),
      ]);
      if (removed !== null) return removed;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
async function collect(stream: PassThrough, limit: number, discard = false): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    const remaining = limit - size;
    size += bytes.length;
    if (size > limit && !discard) throw new Error('Reference renderer output exceeds bounds');
    if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
  }
  return Buffer.concat(chunks);
}
function renderPayload(
  ref: InputBundleRef,
  entrypoint: string,
  files: readonly Buffer[],
  image: string,
): string {
  const payload = ref.files.map((file, index) => {
    const bytes = files[index];
    if (
      !bytes ||
      bytes.length !== file.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    )
      throw new Error('Reference input bytes changed');
    return { ...file, base64: bytes.toString('base64') };
  });
  return `${JSON.stringify({ protocol: REFERENCE_RENDERER_PROTOCOL, bundleDigest: ref.digest, entrypoint, rendererImage: image, viewport: REFERENCE_PREVIEW_VIEWPORT, files: payload })}\n`;
}
