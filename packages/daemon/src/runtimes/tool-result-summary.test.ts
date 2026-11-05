import { Readable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { ClaudeStreamParser } from './claude-stream-parser.js';
import { CodexStreamParser } from './codex-stream-parser.js';
import { CopilotStreamParser } from './copilot-stream-parser.js';
import { PiRpcParser } from './pi-rpc-parser.js';
import { toolInputSummary, toolResultSummary } from './tool-result-summary.js';

describe('native image activity summaries', () => {
  const secretPixels = 'confidential-base64-pixel-bytes';
  const native = {
    content: [
      { type: 'text', text: 'Reference receipt' },
      { type: 'image', mimeType: 'image/jpeg', data: secretPixels },
    ],
  };
  it('retains ordinary tool text and metadata but withholds native pixels before truncation', () => {
    expect(toolResultSummary('normal output')).toBe('normal output');
    expect(() =>
      toolResultSummary({ type: { toString: 'not callable' }, text: 'ordinary data' }),
    ).not.toThrow();
    expect(toolResultSummary('{ "hello": 1 }')).toBe('{ "hello": 1 }');
    for (const value of [
      native,
      JSON.stringify(native),
      { result: native },
      { content: [{ type: 'image', source: { type: 'base64', data: secretPixels } }] },
    ]) {
      const result = toolResultSummary(value);
      expect(result).not.toContain(secretPixels);
      expect(result).toContain('bytesWithheld');
    }
    expect(toolResultSummary(native)).toContain('Reference receipt');
  });
  it('fails closed for truncated/prefixed image JSON and strips data URLs', () => {
    expect(toolResultSummary('{"type":"image","data":"private')).not.toContain('private');
    expect(toolResultSummary('Tool result: {"type":"image","data":"private"}')).not.toContain(
      'private',
    );
    expect(toolResultSummary('data:image/png;base64,aGVsbG8=')).toBe('[image bytes withheld]');
  });
  it('keeps native image blocks out of real runtime event adapters', async () => {
    const logger = pino({ level: 'silent' });
    const stream = (record: unknown) => Readable.from([`${JSON.stringify(record)}\n`]);
    const collect = async (events: AsyncIterable<unknown>) => {
      const result = [];
      for await (const event of events) result.push(event);
      return JSON.stringify(result);
    };
    const outputs = [
      await collect(
        CodexStreamParser.parse(
          stream({
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call',
              id: 'call',
              server: 'autopod',
              tool: 'render_reference',
              arguments: { path: 'private-product/design.html' },
              result: native,
            },
          }),
          'pod',
          logger,
        ),
      ),
      await collect(
        PiRpcParser.parse(
          stream({
            type: 'tool_use',
            tool: 'render_reference',
            input: { path: 'private-product/design.html' },
            output: native,
          }),
          { podId: 'pod', logger },
        ),
      ),
      await collect(CopilotStreamParser.parse(stream(native), 'pod', logger)),
      await collect(
        ClaudeStreamParser.parse(
          stream({
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'call', content: native.content }],
            },
          }),
          'pod',
          logger,
        ),
      ),
    ];
    for (const output of outputs) {
      expect(output).not.toContain(secretPixels);
      expect(output).not.toContain('private-product');
    }
  });
  it('withholds known reference-file read contents while leaving ordinary source reads alone', async () => {
    const logger = pino({ level: 'silent' });
    const source = 'confidential raw reference source';
    const records = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              id: 'ref-read',
              input: { file_path: '/autopod/inputs/files/private-product/design.html' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'ref-read', content: source }] },
      },
    ];
    const events = [];
    for await (const event of ClaudeStreamParser.parse(
      Readable.from(records.map((record) => `${JSON.stringify(record)}\n`)),
      'pod',
      logger,
    ))
      events.push(event);
    expect(JSON.stringify(events)).not.toContain(source);
    expect(JSON.stringify(events)).not.toContain('private-product');
    expect(toolResultSummary(source)).toBe(source);
  });
  it('withholds owner-only paths from generated render receipts and tool inputs', () => {
    const receipt = {
      rendererProtocol: 1,
      bundleDigest: 'a'.repeat(64),
      sourceSha256: 'b'.repeat(64),
      entrypoint: 'private-product/wireframe.html',
    };
    const summary = toolResultSummary({
      content: [{ type: 'text', text: JSON.stringify({ receipt }) }],
    });
    expect(summary).not.toContain('private-product');
    expect(summary).toContain('sourceSha256');
    expect(
      toolInputSummary('mcp__autopod__render_reference', {
        path: receipt.entrypoint,
        call_id: 'call',
      }),
    ).toEqual({ call_id: 'call', reference: 'admitted HTML reference' });
    expect(toolInputSummary('Read', { path: 'src/main.ts' })).toEqual({ path: 'src/main.ts' });
  });
});
