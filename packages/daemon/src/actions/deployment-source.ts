import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { extract, pack } from 'tar-stream';

const MAX_BYTES = 128 * 1024 * 1024;
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

/** Normalize an exact-commit archive into a deterministic, mount-free deployment bundle. */
export async function prepareDeploymentSource(
  raw: Buffer,
  scriptPath: string,
): Promise<{
  sourceTar: Buffer;
  sourceDigest: string;
  scriptDigest: string;
  scriptContent: string;
}> {
  if (raw.length > MAX_BYTES) throw new Error('Deployment archive exceeds the size limit');
  const source =
    raw[0] === 0x1f && raw[1] === 0x8b
      ? gunzipSync(raw, { maxOutputLength: MAX_BYTES })
      : Buffer.from(raw);
  const input = extract();
  const output = pack();
  const chunks: Buffer[] = [];
  const seen = new Set<string>();
  let total = 0;
  let outputBytes = 0;
  let script: Buffer | undefined;
  const done = new Promise<Buffer>((resolve, reject) => {
    output.on('data', (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) {
        output.destroy(new Error('Deployment archive stream is invalid'));
        return;
      }
      outputBytes += chunk.length;
      if (outputBytes > MAX_BYTES) {
        output.destroy(new Error('Deployment bundle exceeds the size limit'));
        return;
      }
      chunks.push(chunk);
    });
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);
  });
  const fail = (error: Error) => {
    input.destroy();
    output.destroy(error);
  };
  input.on('error', fail);
  input.on('finish', () => output.finalize());
  input.on('entry', (header, stream, next) => {
    const name = header.name.replace(/\/$/, '');
    if (
      !name ||
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').some((p) => !p || p === '.' || p === '..' || p === '.git') ||
      seen.has(name) ||
      seen.size >= 100_000 ||
      !['file', 'directory'].includes(header.type ?? 'file')
    ) {
      stream.resume();
      fail(new Error('Deployment source contains an unsafe member'));
      return;
    }
    seen.add(name);
    const parts: Buffer[] = [];
    let bytes = 0;
    stream.on('data', (part: unknown) => {
      if (!Buffer.isBuffer(part)) {
        fail(new Error('Deployment source stream is invalid'));
        return;
      }
      total += part.length;
      bytes += part.length;
      if (total > MAX_BYTES || (name === scriptPath && bytes > 100_000)) {
        fail(new Error('Deployment source exceeds the size limit'));
        return;
      }
      parts.push(part);
    });
    stream.on('error', fail);
    stream.on('end', () => {
      if (output.destroyed) return;
      const content = Buffer.concat(parts);
      if (name === scriptPath && header.type === 'file') script = content;
      output.entry(
        {
          name,
          type: header.type ?? 'file',
          uid: 1000,
          gid: 1000,
          uname: '',
          gname: '',
          mode: header.type === 'directory' || ((header.mode ?? 0) & 0o111) !== 0 ? 0o755 : 0o644,
          mtime: new Date(0),
        },
        content,
        (error) => {
          if (error) fail(error);
          else next();
        },
      );
    });
  });
  input.end(source);
  const sourceTar = await done;
  if (!script) throw new Error('Deployment script is absent from the approved source');
  const scriptContent = new TextDecoder('utf-8', { fatal: true }).decode(script);
  return { sourceTar, sourceDigest: hash(sourceTar), scriptDigest: hash(script), scriptContent };
}
