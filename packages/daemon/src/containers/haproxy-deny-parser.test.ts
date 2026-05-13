import { describe, expect, it } from 'vitest';
import { parseHaproxyLogLine } from './haproxy-deny-parser.js';

describe('parseHaproxyLogLine', () => {
  it('parses a real DENY line with syslog envelope', () => {
    const line =
      '<134>May 12 20:47:25 haproxy[8595]: sni=evil.example.com src=127.0.0.1 action=DENY';
    expect(parseHaproxyLogLine(line)).toEqual({
      sni: 'evil.example.com',
      src: '127.0.0.1',
      action: 'DENY',
    });
  });

  it('parses a real ALLOW line', () => {
    const line =
      '<134>May 12 20:47:25 haproxy[8595]: sni=api.anthropic.com src=127.0.0.1 action=ALLOW';
    expect(parseHaproxyLogLine(line)).toEqual({
      sni: 'api.anthropic.com',
      src: '127.0.0.1',
      action: 'ALLOW',
    });
  });

  it('parses a bare log line without the syslog envelope', () => {
    const line = 'sni=api.anthropic.com src=10.0.0.5 action=ALLOW';
    expect(parseHaproxyLogLine(line)).toEqual({
      sni: 'api.anthropic.com',
      src: '10.0.0.5',
      action: 'ALLOW',
    });
  });

  it('returns null on completely unrelated lines', () => {
    expect(parseHaproxyLogLine('starting up')).toBeNull();
    expect(parseHaproxyLogLine('')).toBeNull();
    expect(parseHaproxyLogLine('Configuration file is valid')).toBeNull();
  });

  it('returns null on partial / truncated lines', () => {
    expect(parseHaproxyLogLine('sni=foo')).toBeNull();
    expect(parseHaproxyLogLine('sni=foo src=1.2.3.4')).toBeNull();
  });

  it('returns null on unknown actions instead of guessing', () => {
    const line = 'sni=foo.com src=1.2.3.4 action=MAYBE';
    expect(parseHaproxyLogLine(line)).toBeNull();
  });

  it('handles empty SNI (rendered as "-" by HAProxy)', () => {
    const line = 'sni=- src=127.0.0.1 action=DENY';
    expect(parseHaproxyLogLine(line)).toEqual({
      sni: '-',
      src: '127.0.0.1',
      action: 'DENY',
    });
  });

  it('does not throw on bytes that resemble regex injection', () => {
    const line = 'sni=([a-z])+ src=$$$ action=DENY';
    const result = parseHaproxyLogLine(line);
    expect(result).toEqual({
      sni: '([a-z])+',
      src: '$$$',
      action: 'DENY',
    });
  });
});
