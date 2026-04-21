import { execFile, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Saves clipboard image to destPath. Returns false if clipboard has no image.
export async function saveClipboardImage(destPath: string): Promise<boolean> {
  if (process.platform === 'darwin') {
    return saveMacosClipboardImage(destPath);
  }
  if (process.platform === 'linux') {
    return saveLinuxClipboardImage(destPath);
  }
  return false;
}

async function saveMacosClipboardImage(destPath: string): Promise<boolean> {
  // Try PNG first, then TIFF (macOS screenshots land as TIFF in clipboard)
  const script = `
try
  set imgData to the clipboard as «class PNGf»
  set f to open for access POSIX file "${destPath}" with write permission
  write imgData to f
  close access f
  return "ok"
on error
  try
    set imgData to the clipboard as «class TIFF»
    set f to open for access POSIX file "${destPath}" with write permission
    write imgData to f
    close access f
    return "ok"
  on error
    return "no-image"
  end try
end try
`;
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script]);
    return stdout.trim() === 'ok';
  } catch {
    return false;
  }
}

async function saveLinuxClipboardImage(destPath: string): Promise<boolean> {
  return spawnToFile('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], destPath).then(
    (ok) => ok || spawnToFile('xsel', ['--clipboard', '--output'], destPath),
  );
}

function spawnToFile(cmd: string, args: string[], destPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn(cmd, args);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('close', async (code) => {
      if (code !== 0 || chunks.length === 0) {
        resolve(false);
        return;
      }
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) {
        resolve(false);
        return;
      }
      try {
        await writeFile(destPath, buf);
        resolve(true);
      } catch {
        resolve(false);
      }
    });
    child.on('error', () => resolve(false));
  });
}
