import { describe, expect, it } from 'vitest';
import { DecisionOutputError, parseSystemDecisionOutput } from './decision-output.js';
import {
  SYSTEM_CREDENTIAL_SHIM,
  SYSTEM_CREDENTIAL_SHIM_PATH,
  buildSystemRuntimeInvocation,
} from './runtime-adapters.js';

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

  it('disables Codex tools and user/project resources', () => {
    const command = buildSystemRuntimeInvocation({ runtime: 'codex', model: 'gpt-5' }).command.join(
      ' ',
    );
    expect(command).toContain(`${SYSTEM_CREDENTIAL_SHIM_PATH} codex exec`);
    for (const feature of [
      'shell_tool',
      'unified_exec',
      'browser_use',
      'computer_use',
      'apps',
      'plugins',
    ]) {
      expect(command).toContain(`--disable ${feature}`);
    }
    expect(command).toContain('--ignore-user-config');
    expect(command).toContain('--ignore-rules');
    expect(command).toContain('--ephemeral');
  });

  it('expands file-pointer credentials before each affected CLI', () => {
    for (const variable of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'COPILOT_GITHUB_TOKEN',
    ]) {
      expect(SYSTEM_CREDENTIAL_SHIM).toContain(`read_secret ${variable}`);
    }
    for (const runtime of ['claude', 'codex', 'copilot'] as const) {
      expect(buildSystemRuntimeInvocation({ runtime, model: 'model' }).command.join(' ')).toContain(
        SYSTEM_CREDENTIAL_SHIM_PATH,
      );
    }
  });

  it('gives Copilot no tools, built-in MCP, instructions, or remote control', () => {
    const command = buildSystemRuntimeInvocation({
      runtime: 'copilot',
      model: 'gpt-5',
    }).command.join(' ');
    expect(command).toContain('--available-tools=');
    expect(command).toContain('--disable-builtin-mcps');
    expect(command).toContain('--no-custom-instructions');
    expect(command).toContain('--no-remote');
    expect(command).not.toContain('--allow-all');
  });
});
