import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AutopodError } from '@autopod/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readAcFile } from './ac-file-parser.js';

const tmpDir = path.join(import.meta.dirname, '..', '..', '.test-tmp-ac');

beforeAll(async () => {
  await mkdir(tmpDir, { recursive: true });
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('readAcFile', () => {
  it('parses plain text criteria', async () => {
    await writeFile(path.join(tmpDir, 'plain.txt'), 'Login works\nLogout works\n');
    const result = await readAcFile(tmpDir, 'plain.txt');
    expect(result).toEqual(['Login works', 'Logout works']);
  });

  it('strips markdown list prefixes', async () => {
    await writeFile(path.join(tmpDir, 'md.txt'), '- First\n* Second\n  - Third\n');
    const result = await readAcFile(tmpDir, 'md.txt');
    expect(result).toEqual(['First', 'Second', 'Third']);
  });

  it('drops blank lines and whitespace-only lines', async () => {
    await writeFile(path.join(tmpDir, 'blanks.txt'), 'A\n\n  \nB\n');
    const result = await readAcFile(tmpDir, 'blanks.txt');
    expect(result).toEqual(['A', 'B']);
  });

  it('throws AC_FILE_NOT_FOUND when file does not exist', async () => {
    await expect(readAcFile(tmpDir, 'nope.txt')).rejects.toThrow(AutopodError);
    await expect(readAcFile(tmpDir, 'nope.txt')).rejects.toMatchObject({
      code: 'AC_FILE_NOT_FOUND',
    });
  });

  it('throws AC_FILE_EMPTY when file has only blank lines', async () => {
    await writeFile(path.join(tmpDir, 'empty.txt'), '\n\n  \n');
    await expect(readAcFile(tmpDir, 'empty.txt')).rejects.toThrow(AutopodError);
    await expect(readAcFile(tmpDir, 'empty.txt')).rejects.toMatchObject({
      code: 'AC_FILE_EMPTY',
    });
  });
});
