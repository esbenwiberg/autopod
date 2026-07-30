import { describe, expect, it } from 'vitest';
import { DecisionOutputError, parseSystemDecisionOutput } from './decision-output.js';
import { buildSystemRuntimeInvocation } from './runtime-adapters.js';

const valid = {
  contractVersion: 1,
  attentionSignature: 'sig-1',
  action: 'no_action',
  arguments: {},
  reason: 'No safe intervention is needed.',
  evidenceRefs: ['pod:state'],
  confidence: 'high',
  remainingRisk: 'None identified.',
  stopCondition: 'Reconsider when evidence changes.',
};

describe('system decision output', () => {
  it.each([
    ['claude', JSON.stringify({ result: JSON.stringify(valid) })],
    ['codex', JSON.stringify({ item: { text: JSON.stringify(valid) } })],
    ['copilot', JSON.stringify(valid)],
    ['pi', JSON.stringify({ message: { content: JSON.stringify(valid) } })],
  ] as const)('parses strict %s runtime output', (runtime, output) => {
    expect(parseSystemDecisionOutput(runtime, output)).toEqual(valid);
  });

  it('rejects prose, unknown actions, fields, and contract versions', () => {
    expect(() => parseSystemDecisionOutput('copilot', 'looks good')).toThrow(DecisionOutputError);
    expect(() =>
      parseSystemDecisionOutput('copilot', JSON.stringify({ ...valid, action: 'shell' })),
    ).toThrow(DecisionOutputError);
    expect(() =>
      parseSystemDecisionOutput('copilot', JSON.stringify({ ...valid, extra: true })),
    ).toThrow(DecisionOutputError);
    expect(() =>
      parseSystemDecisionOutput('copilot', JSON.stringify({ ...valid, contractVersion: 2 })),
    ).toThrow(DecisionOutputError);
  });

  it('disables Pi tools, extensions, skills, sessions, and project context', () => {
    const invocation = buildSystemRuntimeInvocation({
      runtime: 'pi',
      model: 'anthropic/claude-sonnet',
    });
    const command = invocation.command.join(' ');
    expect(command).toContain('--no-tools');
    expect(command).toContain('--no-extensions');
    expect(command).toContain('--no-skills');
    expect(command).toContain('--no-prompt-templates');
    expect(command).toContain('--no-context-files');
    expect(command).toContain('--no-session');
  });
});
