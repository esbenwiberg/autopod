import { describe, expect, it } from 'vitest';
import { parseAcList } from './parse-ac-list.js';

describe('parseAcList', () => {
  it('parses plain text lines (no prefixes)', () => {
    expect(parseAcList('Login works\nLogout works')).toEqual(['Login works', 'Logout works']);
  });

  it('strips markdown dash prefix', () => {
    expect(parseAcList('- First\n- Second\n- Third')).toEqual(['First', 'Second', 'Third']);
  });

  it('strips markdown asterisk prefix', () => {
    expect(parseAcList('* First\n* Second')).toEqual(['First', 'Second']);
  });

  it('strips checkbox prefixes', () => {
    expect(parseAcList('- [ ] Unchecked\n- [x] Checked\n- [X] Also checked')).toEqual([
      'Unchecked',
      'Checked',
      'Also checked',
    ]);
  });

  it('strips asterisk checkbox prefixes', () => {
    expect(parseAcList('* [ ] One\n* [x] Two')).toEqual(['One', 'Two']);
  });

  it('strips numbered dot prefixes', () => {
    expect(parseAcList('1. First\n2. Second\n10. Tenth')).toEqual(['First', 'Second', 'Tenth']);
  });

  it('strips numbered paren prefixes', () => {
    expect(parseAcList('1) First\n2) Second\n10) Tenth')).toEqual(['First', 'Second', 'Tenth']);
  });

  it('strips lettered dot prefixes', () => {
    expect(parseAcList('a. First\nb. Second\nc. Third')).toEqual(['First', 'Second', 'Third']);
  });

  it('strips lettered paren prefixes', () => {
    expect(parseAcList('a) First\nb) Second\nc) Third')).toEqual(['First', 'Second', 'Third']);
  });

  it('strips uppercase lettered prefixes', () => {
    expect(parseAcList('A. First\nB) Second')).toEqual(['First', 'Second']);
  });

  it('handles mixed prefix formats in one input', () => {
    const input = [
      '- Dash item',
      '* Star item',
      '1. Numbered item',
      'a) Lettered item',
      'Plain item',
    ].join('\n');
    expect(parseAcList(input)).toEqual([
      'Dash item',
      'Star item',
      'Numbered item',
      'Lettered item',
      'Plain item',
    ]);
  });

  it('handles leading whitespace / indentation', () => {
    expect(parseAcList('  - Indented dash\n    * Indented star\n  1. Indented num')).toEqual([
      'Indented dash',
      'Indented star',
      'Indented num',
    ]);
  });

  it('drops blank lines and whitespace-only lines', () => {
    expect(parseAcList('First\n\n  \nSecond\n\n')).toEqual(['First', 'Second']);
  });

  it('handles Windows CRLF line endings', () => {
    expect(parseAcList('- First\r\n- Second\r\n- Third')).toEqual(['First', 'Second', 'Third']);
  });

  it('returns empty array for empty input', () => {
    expect(parseAcList('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(parseAcList('  \n  \n\n')).toEqual([]);
  });

  it('filters out lines that are only a prefix with no content', () => {
    expect(parseAcList('- \n1. \nActual criterion')).toEqual(['Actual criterion']);
  });

  it('does not strip non-list prefix patterns', () => {
    expect(parseAcList('2-factor auth should work\nSSO login must pass')).toEqual([
      '2-factor auth should work',
      'SSO login must pass',
    ]);
  });

  it('handles multi-digit numbers', () => {
    expect(parseAcList('123. Big list item\n99) Another one')).toEqual([
      'Big list item',
      'Another one',
    ]);
  });
});
