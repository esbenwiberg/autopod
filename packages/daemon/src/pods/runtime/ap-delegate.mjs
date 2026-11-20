#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const DESCRIPTOR_PATH = '/run/autopod/delegate.json';

const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_WAIT_MS = 15_000;
const DEFAULT_WAIT_MS = 15_000;
const REQUEST_GRACE_MS = 2_000;
const DEFAULT_REQUEST_MS = 10_000;
const KEY_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const RECIPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

class CliError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.uncertain = options.uncertain === true;
  }
}

function usage() {
  return [
    'Usage:',
    '  ap delegate start --key KEY --recipe RECIPE --brief TEXT',
    '  ap delegate status',
    '  ap delegate results [--after N]',
    '  ap delegate wait [--after N] [--timeout-ms N]',
  ].join('\n');
}

function parseInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? '')) {
    throw new CliError('INVALID_ARGUMENT', `${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new CliError('INVALID_ARGUMENT', `${name} is out of range`);
  }
  return parsed;
}

function parseOptions(tokens, allowed) {
  const options = Object.create(null);
  for (let index = 0; index < tokens.length; index++) {
    const flag = tokens[index];
    if (!allowed.has(flag) || options[flag] !== undefined) {
      throw new CliError('INVALID_ARGUMENT', `unsupported or repeated option: ${flag}`);
    }
    const value = tokens[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new CliError('INVALID_ARGUMENT', `missing value for ${flag}`);
    }
    options[flag] = value;
  }
  return options;
}

export function parseCommand(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { kind: 'help' };
  }
  if (argv[0] !== 'delegate') {
    throw new CliError('INVALID_NAMESPACE', 'only the delegate namespace is available');
  }
  const command = argv[1];
  const tokens = argv.slice(2);
  if (command === undefined || command === '--help' || command === '-h') return { kind: 'help' };

  if (command === 'start') {
    const options = parseOptions(tokens, new Set(['--key', '--recipe', '--brief']));
    const key = options['--key'];
    const recipe = options['--recipe'];
    const brief = options['--brief'];
    if (!KEY_PATTERN.test(key ?? '')) {
      throw new CliError('INVALID_ARGUMENT', '--key must match [a-zA-Z0-9_-]{1,64}');
    }
    if (!RECIPE_PATTERN.test(recipe ?? '')) {
      throw new CliError('INVALID_ARGUMENT', '--recipe must match [a-z][a-z0-9_-]{0,63}');
    }
    if (typeof brief !== 'string' || brief.trim().length === 0 || brief.length > 2048) {
      throw new CliError('INVALID_ARGUMENT', '--brief must contain 1 to 2048 characters');
    }
    return { kind: 'start', requestKey: key, recipe, brief };
  }

  if (command === 'status') {
    if (tokens.length !== 0) throw new CliError('INVALID_ARGUMENT', 'status accepts no options');
    return { kind: 'status' };
  }

  if (command === 'results' || command === 'wait') {
    const allowed =
      command === 'wait' ? new Set(['--after', '--timeout-ms']) : new Set(['--after']);
    const options = parseOptions(tokens, allowed);
    const after = parseInteger(options['--after'] ?? '0', '--after');
    if (command === 'results') return { kind: 'results', after };
    const timeoutMs = parseInteger(
      options['--timeout-ms'] ?? String(DEFAULT_WAIT_MS),
      '--timeout-ms',
      MAX_WAIT_MS,
    );
    return { kind: 'wait', after, timeoutMs };
  }

  throw new CliError('INVALID_COMMAND', 'unsupported delegate command');
}

function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError('CONFIG_INVALID', 'delegate descriptor is invalid');
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('url') || !keys.includes('authorization')) {
    throw new CliError('CONFIG_INVALID', 'delegate descriptor is invalid');
  }
  if (typeof value.url !== 'string' || typeof value.authorization !== 'string') {
    throw new CliError('CONFIG_INVALID', 'delegate descriptor is invalid');
  }
  if (value.authorization.length < 1 || value.authorization.length > 8192) {
    throw new CliError('CONFIG_INVALID', 'delegate descriptor is invalid');
  }
  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw new CliError('CONFIG_INVALID', 'delegate descriptor is invalid');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    value.url.length > 4096
  ) {
    throw new CliError('CONFIG_INVALID', 'delegate descriptor is invalid');
  }
  return { url: url.href, authorization: value.authorization };
}

export async function readDescriptor() {
  let bytes;
  try {
    bytes = await readFile(DESCRIPTOR_PATH);
  } catch {
    throw new CliError('CONFIG_UNAVAILABLE', 'delegate descriptor is unavailable');
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DESCRIPTOR_BYTES) {
    throw new CliError('CONFIG_INVALID', 'delegate descriptor is invalid');
  }
  try {
    return validateConfig(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('CONFIG_INVALID', 'delegate descriptor is invalid');
  }
}

async function readBounded(response) {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    throw new CliError('RESPONSE_TOO_LARGE', 'delegate response exceeded the size limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new CliError('RESPONSE_TOO_LARGE', 'delegate response exceeded the size limit');
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(combined);
}

function parseSse(text) {
  const events = [];
  let data = [];
  const flush = () => {
    if (data.length > 0) events.push(data.join('\n'));
    data = [];
  };
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (rawLine === '') {
      flush();
      continue;
    }
    if (rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
  }
  flush();
  if (events.length !== 1) {
    throw new CliError('RESPONSE_INVALID', 'delegate returned an invalid event stream');
  }
  return events[0];
}

function parseEnvelope(text, contentType) {
  let payload = text;
  if (contentType.toLowerCase().includes('text/event-stream')) payload = parseSse(text);
  try {
    return JSON.parse(payload);
  } catch {
    throw new CliError('RESPONSE_INVALID', 'delegate returned invalid JSON');
  }
}

function decodeToolResult(envelope) {
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    envelope.jsonrpc !== '2.0' ||
    envelope.id !== 1
  ) {
    throw new CliError('RESPONSE_INVALID', 'delegate returned an invalid response');
  }
  if (envelope.error) throw new CliError('REMOTE_ERROR', 'delegate tool returned an error');
  const result = envelope.result;
  if (!result || typeof result !== 'object' || result.isError === true) {
    throw new CliError('REMOTE_ERROR', 'delegate tool returned an error');
  }
  if (!Array.isArray(result.content)) {
    throw new CliError('RESPONSE_INVALID', 'delegate returned an invalid tool result');
  }
  const textItems = result.content.filter(
    (item) =>
      item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string',
  );
  if (textItems.length !== 1) {
    throw new CliError('RESPONSE_INVALID', 'delegate returned an invalid tool result');
  }
  try {
    return JSON.parse(textItems[0].text);
  } catch {
    throw new CliError('RESPONSE_INVALID', 'delegate returned an invalid tool result');
  }
}

function callFor(command) {
  switch (command.kind) {
    case 'start':
      return {
        name: 'managed_child_request',
        arguments: {
          requestKey: command.requestKey,
          recipe: command.recipe,
          brief: command.brief,
        },
      };
    case 'status':
      return { name: 'managed_family', arguments: {} };
    case 'results':
      return { name: 'managed_results', arguments: { after: command.after } };
    case 'wait':
      return {
        name: 'managed_wait',
        arguments: { after: command.after, timeoutMs: command.timeoutMs },
      };
    default:
      throw new CliError('INVALID_COMMAND', 'unsupported delegate command');
  }
}

async function invoke(command, config, transport) {
  const call = callFor(command);
  const timeoutMs =
    command.kind === 'wait' ? command.timeoutMs + REQUEST_GRACE_MS : DEFAULT_REQUEST_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await transport(config.url, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: {
        authorization: config.authorization,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: call,
      }),
      signal: controller.signal,
    });
    if (!response || typeof response.status !== 'number' || !response.headers) {
      throw new CliError('TRANSPORT_ERROR', 'delegate transport failed');
    }
    if (!response.ok) {
      throw new CliError('HTTP_ERROR', `delegate request failed with HTTP ${response.status}`, {
        uncertain: response.status >= 500,
      });
    }
    const text = await readBounded(response);
    return decodeToolResult(parseEnvelope(text, response.headers.get('content-type') ?? ''));
  } catch (error) {
    if (error instanceof CliError) {
      if (
        command.kind === 'start' &&
        ['RESPONSE_INVALID', 'RESPONSE_TOO_LARGE', 'REMOTE_ERROR'].includes(error.code)
      ) {
        error.uncertain = true;
      }
      throw error;
    }
    throw new CliError('TRANSPORT_ERROR', 'delegate transport failed');
  } finally {
    clearTimeout(timer);
  }
}

function startResult(command, family) {
  const children =
    family && typeof family === 'object' && Array.isArray(family.children) ? family.children : [];
  const receipt = children.find(
    (child) => child && typeof child === 'object' && child.requestKey === command.requestKey,
  );
  if (!receipt) {
    throw new CliError('START_UNCERTAIN', 'delegate start reply could not be reconciled', {
      uncertain: true,
    });
  }
  return receipt;
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

export async function runDelegate(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let command;
  try {
    command = parseCommand(argv);
    if (command.kind === 'help') {
      stdout.write(`${usage()}\n`);
      return 0;
    }
    const config = options.config ? validateConfig(options.config) : await readDescriptor();
    const result = await invoke(command, config, options.transport ?? fetch);
    writeJson(stdout, {
      ok: true,
      command: command.kind,
      result: command.kind === 'start' ? startResult(command, result) : result,
    });
    return 0;
  } catch (error) {
    const safe =
      error instanceof CliError ? error : new CliError('INTERNAL_ERROR', 'delegate command failed');
    const output = {
      ok: false,
      error: { code: safe.code, message: safe.message },
    };
    if (command?.kind === 'start' && (safe.uncertain || safe.code === 'TRANSPORT_ERROR')) {
      output.error.uncertain = true;
      output.error.requestKey = command.requestKey;
      output.error.reconcile = `Run "ap delegate status" and reuse the exact stable key "${command.requestKey}"; do not create a new key or auto-retry.`;
    }
    writeJson(stderr, output);
    return safe.code === 'INVALID_ARGUMENT' ||
      safe.code === 'INVALID_COMMAND' ||
      safe.code === 'INVALID_NAMESPACE'
      ? 2
      : 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = await runDelegate(process.argv.slice(2));
