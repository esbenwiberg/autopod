import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';

const repo = fileURLToPath(new URL('../', import.meta.url));
const adapter = path.join(repo, 'packages/desktop/VillageRenderer');
const destination = path.join(
  repo,
  'packages/desktop/Sources/AutopodUI/Resources/Village/renderer',
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (source, ...args) =>
  execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();

async function filesBelow(directory) {
  const result = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${full}`);
    if (item.isDirectory()) result.push(...(await filesBelow(full)));
    else result.push(full);
  }
  return result;
}

export async function updateRenderer({ source, output = destination, check = false } = {}) {
  const lock = `${output}.lock`;
  await fs.mkdir(lock); // Prevent two updates from replacing each other's output.
  let staging;
  let preserveBackup = false;
  try {
    staging = await fs.realpath(await fs.mkdtemp(`${output}.staging-`));
    const upstream = path.join(staging, 'upstream');
    const captured = new Map();
    let provenance;
    if (source) {
      source = await fs.realpath(source);
      const revision = git(source, 'rev-parse', 'HEAD');
      const dirty = Boolean(git(source, 'status', '--porcelain', '--untracked-files=normal'));
      async function capture(relative) {
        if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..'))
          throw new Error('Unsafe source path');
        const original = path.join(source, relative);
        const real = await fs.realpath(original);
        if (real !== original) throw new Error(`Symlinked renderer input: ${relative}`);
        const bytes = await fs.readFile(original);
        captured.set(relative, hash(bytes));
        const target = path.join(upstream, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes);
        return bytes;
      }
      // Let the JS parser find the browser dependency graph; never copy sessions or server data.
      await build({
        stdin: {
          contents:
            "export {drawCharacter} from './src/render.mjs'; export {performanceAt,drawPerformance} from './src/performance.mjs'; export {LOCATIONS,STATION_NAMES,stationRoute,stationSeat} from './src/world.mjs';",
          resolveDir: source,
        },
        bundle: true,
        write: false,
        platform: 'browser',
        logLevel: 'silent',
        plugins: [
          {
            name: 'capture-browser-source',
            setup(builder) {
              builder.onLoad({ filter: /\.mjs$/ }, async ({ path: filename }) => {
                const relative = path.relative(source, filename);
                if (!relative.startsWith('src/'))
                  throw new Error('Browser dependency escaped src/');
                return { contents: await capture(relative), loader: 'js' };
              });
            },
          },
        ],
      });
      const metadata = JSON.parse(await capture('public/assets/sprites.json'));
      const images = new Set(
        Object.values(metadata.characters).flatMap((character) =>
          Object.values(character.animations).map((animation) => animation.image),
        ),
      );
      for (const image of images) {
        const relative = image.replace(/^\//, '');
        if (!relative.startsWith('assets/sprites/') || !relative.endsWith('.png'))
          throw new Error('Unsupported sprite path');
        await capture(`public/${relative}`);
      }
      await capture('public/assets/village-v4.png');
      await capture('public/assets/fonts/PixelifySans.ttf');
      // Preserve supplied per-character credits, source URLs and license notices verbatim.
      for (const filename of await filesBelow(path.join(source, 'public/assets'))) {
        if (/\.(txt|md|pb)$/i.test(filename)) await capture(path.relative(source, filename));
      }
      for (const relative of ['README.md', 'docs/asset-production.md']) await capture(relative);
      for (const [relative, expected] of captured) {
        if (hash(await fs.readFile(path.join(source, relative))) !== expected) {
          throw new Error(
            'Renderer changed during capture; rerun the update. Existing bundle was preserved.',
          );
        }
      }
      if (revision !== git(source, 'rev-parse', 'HEAD'))
        throw new Error('Renderer revision changed during capture; rerun.');
      provenance = {
        repository: 'https://github.com/Esbenwiberg/jsonl-animate',
        revision,
        dirty,
        files: Object.fromEntries([...captured].sort(([a], [b]) => a.localeCompare(b))),
      };
      await fs.writeFile(
        path.join(upstream, 'provenance.json'),
        `${JSON.stringify(provenance, null, 2)}\n`,
      );
    } else {
      await fs.cp(path.join(output, 'upstream'), upstream, { recursive: true });
      provenance = JSON.parse(await fs.readFile(path.join(upstream, 'provenance.json'), 'utf8'));
      for (const [relative, expected] of Object.entries(provenance.files)) {
        if (hash(await fs.readFile(path.join(upstream, relative))) !== expected)
          throw new Error(`Upstream input changed: ${relative}`);
      }
    }
    await build({
      entryPoints: [path.join(adapter, 'renderer.mjs')],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'safari17',
      minifyWhitespace: true,
      legalComments: 'none',
      banner: {
        js: '// Generated by scripts/update-village-renderer.mjs. Edit VillageRenderer/, not this file.',
      },
      outfile: path.join(staging, 'renderer.js'),
      logLevel: 'silent',
      plugins: [
        {
          name: 'pinned-jsonl-village',
          setup(builder) {
            builder.onResolve({ filter: /^@jsonl-village\// }, ({ path: name }) => ({
              path: name.endsWith('/sprites.json')
                ? path.join(upstream, 'public/assets/sprites.json')
                : path.join(upstream, 'src', name.split('/').at(-1)),
            }));
          },
        },
      ],
    });
    await fs.copyFile(path.join(adapter, 'renderer.css'), path.join(staging, 'renderer.css'));
    const outputs = {};
    for (const filename of (await filesBelow(staging)).sort())
      outputs[path.relative(staging, filename)] = hash(await fs.readFile(filename));
    await fs.writeFile(
      path.join(staging, 'build.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          esbuild: esbuildVersion,
          revision: provenance.revision,
          files: outputs,
        },
        null,
        2,
      )}\n`,
    );
    if (check) {
      const oldFiles = (await filesBelow(output)).map((file) => path.relative(output, file)).sort();
      const newFiles = (await filesBelow(staging))
        .map((file) => path.relative(staging, file))
        .sort();
      if (JSON.stringify(oldFiles) !== JSON.stringify(newFiles))
        throw new Error('Village bundle is out of date');
      for (const relative of newFiles)
        if (
          hash(await fs.readFile(path.join(output, relative))) !==
          hash(await fs.readFile(path.join(staging, relative)))
        )
          throw new Error(`Village bundle is out of date: ${relative}`);
    } else {
      const backup = path.join(lock, 'previous');
      let previous = false;
      try {
        await fs.rename(output, backup);
        previous = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try {
        await fs.rename(staging, output);
        staging = null;
      } catch (error) {
        if (previous) {
          try {
            await fs.rename(backup, output);
          } catch (restoreError) {
            preserveBackup = true;
            throw new Error(
              `Could not restore renderer. Previous bundle is preserved at ${backup}`,
              { cause: restoreError },
            );
          }
        }
        throw error;
      }
    }
    return provenance;
  } finally {
    if (staging) await fs.rm(staging, { recursive: true, force: true });
    if (!preserveBackup) await fs.rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (
    args.some(
      (arg, index) => !['--source', '--check'].includes(arg) && args[index - 1] !== '--source',
    ) ||
    (args.includes('--source') &&
      (!args[args.indexOf('--source') + 1] || args[args.indexOf('--source') + 1].startsWith('--')))
  ) {
    throw new Error(
      'Usage: node scripts/update-village-renderer.mjs [--source /path/to/jsonl-animate] [--check]',
    );
  }
  const result = await updateRenderer({
    source: args.includes('--source')
      ? path.resolve(args[args.indexOf('--source') + 1])
      : undefined,
    check: args.includes('--check'),
  });
  console.log(
    `Village renderer ${args.includes('--check') ? 'verified' : 'built'} from ${result.revision}${result.dirty ? ' (local changes captured)' : ''}`,
  );
}
