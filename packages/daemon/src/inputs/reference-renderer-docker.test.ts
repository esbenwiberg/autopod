import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Dockerode from 'dockerode';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { referenceImage } from '../test-utils/reference-image-helpers.js';
import { InputBundleStore } from './input-bundle-store.js';
import { ReferencePreviewService } from './reference-preview-service.js';
import { DockerReferenceRenderer } from './reference-renderer.js';

const image = process.env.AUTOPOD_REFERENCE_RENDERER_IMAGE;
describe.skipIf(!image)('real isolated reference renderer', () => {
  it('renders local CSS/images/scripts while denying metadata/loopback/file/external access', async () => {
    if (!image) throw new Error('Set a locally present content-pinned renderer image');
    const docker = new Dockerode();
    const db = createTestDb();
    const store = new InputBundleStore(db);
    const fixtures = [
      {
        path: 'design/index.html',
        mediaType: 'text/html' as const,
        bytes: Buffer.from(
          `<!doctype html><link rel="stylesheet" href="assets/style.css"><div id="red"></div><div id="blue"></div><div id="green"></div><img src="assets/pixel.png" style="position:absolute;left:1200px;top:800px"><img src="http://169.254.169.254/metadata"><img src="file:///etc/passwd"><iframe src="http://127.0.0.1:1"></iframe><img loading="lazy" src="assets/offscreen.svg" style="position:absolute;top:50000px;width:100px;height:100px"><script>document.querySelector('#green').style.background='rgb(0,180,0)';fetch('http://169.254.169.254/metadata').catch(()=>{});fetch('http://127.0.0.1:1').catch(()=>{});try { new WebSocket('ws://reference.invalid/no-socket'); } catch {} throw new Error('fixture script failure');</script>`,
        ),
      },
      {
        path: 'design/assets/style.css',
        mediaType: 'text/css' as const,
        bytes: Buffer.from(
          'html,body{margin:0}div{position:absolute;top:0;height:900px;width:400px}#red{left:0;background:rgb(255,0,0)}#blue{left:400px;background:rgb(0,0,255)}#green{left:800px;background:white}',
        ),
      },
      {
        path: 'design/assets/offscreen.svg',
        mediaType: 'image/svg+xml' as const,
        bytes: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>',
        ),
      },
      {
        path: 'design/assets/pixel.png',
        mediaType: 'image/png' as const,
        bytes: referenceImage().bytes,
      },
    ];
    try {
      const { id } = store.create(
        {
          requestKey: randomUUID(),
          files: fixtures.map(({ bytes, ...file }) => ({
            ...file,
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          })),
        },
        'fixture',
      );
      for (const [index, file] of store.get(id, 'fixture').files.entries()) {
        const fixture = fixtures.find((candidate) => candidate.path === file.path);
        if (!fixture) throw new Error('Missing fixture bytes');
        store.put(id, 'fixture', index, fixture.bytes);
      }
      const { status: _, ...ref } = store.seal(id, 'fixture');
      const renderer = new DockerReferenceRenderer(docker, image);
      expect(await renderer.available()).toBe(true);
      const service = new ReferencePreviewService(store, renderer);
      const preview = await service.render(id, 'fixture', 'design/index.html');
      expect(preview.receipt).toMatchObject({
        width: 1280,
        height: 900,
        rendererImage: image,
        rendererProtocol: 1,
        mediaType: 'image/jpeg',
        bundleDigest: ref.digest,
      });
      expect(preview.receipt.resourceSha256s.sort()).toEqual(
        ref.files
          .filter((file) => file.path !== 'design/assets/offscreen.svg')
          .map((file) => file.sha256)
          .sort(),
      );
      expect(preview.receipt.blockedRequests).toBeGreaterThan(0);
      expect(preview.receipt.scriptErrors).toBeGreaterThan(0);
      expect(store.reviewInputs(ref, 'fixture', [preview]).images).toHaveLength(1);
      const artifactDir = process.env.AUTOPOD_REFERENCE_RENDERER_ARTIFACTS;
      if (artifactDir) {
        await mkdir(artifactDir, { recursive: true });
        const target = path.join(artifactDir, 'reference.jpg');
        await writeFile(target, preview.bytes);
        await writeFile(
          path.join(artifactDir, 'receipt.json'),
          JSON.stringify(preview.receipt, null, 2),
        );
        if (process.platform === 'darwin') {
          // Independent OS image decoding, not a privileged browser or model inference.
          const output = execFileSync(
            '/usr/bin/swift',
            [
              '-e',
              `import Foundation; import ImageIO; import CoreGraphics
let url = URL(fileURLWithPath: CommandLine.arguments.last!)
let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
var pixels = [UInt8](repeating: 0, count: 1280 * 900 * 4)
pixels.withUnsafeMutableBytes { buffer in
 let context = CGContext(data: buffer.baseAddress, width: 1280, height: 900, bitsPerComponent: 8, bytesPerRow: 1280 * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
 context.draw(image, in: CGRect(x: 0, y: 0, width: 1280, height: 900))
 let data = buffer.bindMemory(to: UInt8.self)
 let red = (450 * 1280 + 200) * 4, blue = (450 * 1280 + 600) * 4, green = (450 * 1280 + 1000) * 4
 precondition(data[red] > 240 && data[red+1] < 15 && data[red+2] < 15)
 precondition(data[blue] < 15 && data[blue+1] < 15 && data[blue+2] > 240)
 precondition(data[green] < 15 && data[green+1] > 165 && data[green+1] < 195 && data[green+2] < 15)
}
print("REFERENCE_PIXELS_VERIFIED")`,
              target,
            ],
            { encoding: 'utf8', timeout: 60_000 },
          );
          expect(output).toContain('REFERENCE_PIXELS_VERIFIED');
        }
      }
    } finally {
      db.close();
    }
  }, 120_000);
  it('times out non-terminating supplied scripts, confirms container removal and publishes no preview', async () => {
    if (!image) throw new Error('Set a locally present content-pinned renderer image');
    const docker = new Dockerode();
    const allocated: string[] = [];
    const db = createTestDb();
    const store = new InputBundleStore(db);
    try {
      const bytes = Buffer.from('<!doctype html><script>while(true){}</script>');
      const bundle = store.create(
        {
          requestKey: randomUUID(),
          files: [
            {
              path: 'loop.html',
              mediaType: 'text/html',
              byteLength: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
          ],
        },
        'fixture',
      );
      store.put(bundle.id, 'fixture', 0, bytes);
      const { status: _, ...ref } = store.seal(bundle.id, 'fixture');
      const renderer = new DockerReferenceRenderer(
        {
          modem: docker.modem,
          getImage: (name) => docker.getImage(name),
          createContainer: async (options) => {
            const container = await docker.createContainer(options);
            allocated.push(container.id);
            return container;
          },
        },
        image,
        3500,
      );
      const service = new ReferencePreviewService(store, renderer);
      await expect(service.render(bundle.id, 'fixture', 'loop.html')).rejects.toMatchObject({
        code: 'REFERENCE_RENDER_TIMEOUT',
      });
      expect(store.preview(ref, 'fixture', 'loop.html', image)).toBeNull();
      expect(allocated).toHaveLength(1);
      for (const id of allocated)
        await expect(docker.getContainer(id).inspect()).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      db.close();
    }
  }, 30_000);
});
