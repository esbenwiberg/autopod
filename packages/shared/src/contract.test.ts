import { describe, expect, it } from 'vitest';
import { inspectSpecContract, inspectSpecContractYaml, parseSpecContract } from './contract.js';

function validDomainContract() {
  return {
    contractVersion: 1 as const,
    title: 'Valid',
    dependsOn: [],
    // biome-ignore lint/suspicious/noThenProperty: contract scenarios use Given/When/Then.
    scenarios: [{ id: 'scenario', given: ['state'], when: ['action'], then: ['result'] }],
    requiredFacts: [
      {
        id: 'fact',
        proves: ['scenario'],
        kind: 'unit-test' as const,
        artifact: { path: 'test.ts', change: 'touch' as const },
        command: 'npx vitest run test.ts',
      },
    ],
    humanReview: [],
  };
}

describe('parseSpecContract fact kinds', () => {
  it('aggregates independent Luumi contract diagnostics', () => {
    const result = inspectSpecContractYaml(`contract_version: 1
title: Luumi
scenarios:
  - id: known
    given: [a]
    when: [b]
    then: [c]
required_facts:
  - id: broken
    proves: []
    kind: unit-test
    artifact: { path: test.ts, change: delete }
    command: npx pnpm --filter shared test -- contract.test.ts
  - id: too-long
    proves: [${'x'.repeat(129)}]
    kind: unit-test
    artifact: { path: other.ts, change: create }
    command: npx pnpm --filter shared test -- contract.test.ts --grep known
  - id: unknown
    proves: [missing]
    kind: unit-test
    artifact: { path: another.ts, change: create }
    command: npx pnpm --filter shared test -- contract.test.ts --grep missing
`);
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(4);
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining([
        'CONTRACT_ARTIFACT_CHANGE_INVALID',
        'CONTRACT_PROVES_EMPTY',
        'CONTRACT_PROVES_ENTRY_TOO_LONG',
        'CONTRACT_UNKNOWN_SCENARIO',
      ]),
    );
    expect(result.diagnostics.map((d) => d.path)).toEqual(
      expect.arrayContaining(['requiredFacts.0.artifact.change', 'requiredFacts.0.proves']),
    );
  });

  it('accepts the corrected Luumi counterpart', () => {
    const result = inspectSpecContractYaml(`contract_version: 1
title: Luumi corrected
scenarios:
  - id: known
    given: [a]
    when: [b]
    then: [c]
required_facts:
  - id: corrected
    proves: [known]
    kind: unit-test
    artifact: { path: test.ts, change: update }
    command: npx pnpm --filter @autopod/shared test -- contract.test.ts
`);
    expect(result).toMatchObject({ diagnostics: [], contract: { contractVersion: 1 } });
  });

  it('rejects YAML document errors including duplicate keys', () => {
    const result = inspectSpecContractYaml(`contract_version: 1
title: First
title: Second
scenarios: []
required_facts: []
`);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'CONTRACT_YAML_INVALID',
        source: 'contract.yaml',
        line: expect.any(Number),
        column: expect.any(Number),
      }),
    ]);
  });

  it('preserves optional lists, empty scenarios, trimming, and extension compatibility', () => {
    const contract = parseSpecContract(`contract_version: 1
title: "  Empty scenario contract  "
extension_value: preserved-by-author
scenarios: []
required_facts: []
`);
    expect(contract).toEqual({
      contractVersion: 1,
      title: 'Empty scenario contract',
      dependsOn: [],
      scenarios: [],
      requiredFacts: [],
      humanReview: [],
    });
  });
  it('accepts browser-test as a durable fact kind', () => {
    const contract = parseSpecContract(`contract_version: 1
title: Browser proof
depends_on: []
scenarios:
  - id: page-renders
    given: ["a web app exists"]
    when: ["the user opens the page"]
    then: ["the page renders the target state"]
required_facts:
  - id: fact-page-renders
    proves: [page-renders]
    kind: browser-test
    artifact:
      path: tests/e2e/page-renders.spec.ts
      change: create
    command: npx playwright test tests/e2e/page-renders.spec.ts
human_review: []
`);

    expect(contract.requiredFacts[0]?.kind).toBe('browser-test');
  });

  it('rejects unknown fact kinds', () => {
    expect(() =>
      parseSpecContract(`contract_version: 1
title: Bad kind
depends_on: []
scenarios:
  - id: behavior
    given: ["state"]
    when: ["action"]
    then: ["result"]
required_facts:
  - id: fact-behavior
    proves: [behavior]
    kind: screenshot
    artifact:
      path: tests/e2e/page.spec.ts
      change: create
    command: npx playwright test tests/e2e/page.spec.ts
human_review: []
`),
    ).toThrow(/kind must be one of/);
  });

  it('rejects validate_in_browser MCP tool syntax in required facts', () => {
    expect(() =>
      parseSpecContract(`contract_version: 1
title: MCP tool command
depends_on: []
scenarios:
  - id: page
    given: ["state"]
    when: ["open page"]
    then: ["page works"]
required_facts:
  - id: fact-page
    proves: [page]
    kind: browser-test
    artifact:
      path: tests/e2e/page.spec.ts
      change: create
    command: validate_in_browser /page 'assert[text="Ready"]'
human_review: []
`),
    ).toThrow(/validate_in_browser MCP tool syntax/);
  });

  it('rejects multiple facts that share the same broad command', () => {
    expect(() =>
      parseSpecContract(`contract_version: 1
title: Broad facts
depends_on: []
scenarios:
  - id: api
    given: ["state"]
    when: ["request"]
    then: ["response"]
  - id: page
    given: ["state"]
    when: ["open page"]
    then: ["page works"]
required_facts:
  - id: fact-api
    proves: [api]
    kind: contract-test
    artifact:
      path: tests/workpackages.spec.ts
      change: create
    command: npx playwright test tests/workpackages.spec.ts
  - id: fact-page
    proves: [page]
    kind: browser-test
    artifact:
      path: tests/workpackages.spec.ts
      change: create
    command: npx playwright test tests/workpackages.spec.ts
human_review: []
`),
    ).toThrow(/share the same broad command/);
  });

  it('allows shared fact commands when they are narrowed by grep', () => {
    const contract = parseSpecContract(`contract_version: 1
title: Narrow facts
depends_on: []
scenarios:
  - id: api
    given: ["state"]
    when: ["request"]
    then: ["response"]
  - id: api-extra
    given: ["state"]
    when: ["request"]
    then: ["extra response"]
required_facts:
  - id: fact-api
    proves: [api]
    kind: contract-test
    artifact:
      path: tests/workpackages.spec.ts
      change: create
    command: npx playwright test tests/workpackages.spec.ts --grep @workpackages-v2
  - id: fact-api-extra
    proves: [api-extra]
    kind: contract-test
    artifact:
      path: tests/workpackages.spec.ts
      change: create
    command: npx playwright test tests/workpackages.spec.ts --grep @workpackages-v2
human_review: []
`);

    expect(contract.requiredFacts).toHaveLength(2);
  });

  it.each([
    ['title length', { title: 'x'.repeat(201) }, 'CONTRACT_STRUCTURE_INVALID'],
    ['dependency length', { dependsOn: ['x'.repeat(129)] }, 'CONTRACT_STRUCTURE_INVALID'],
    [
      'scenario id uniqueness',
      { scenarios: [validDomainContract().scenarios[0], validDomainContract().scenarios[0]] },
      'CONTRACT_DUPLICATE_ID',
    ],
    [
      'required fact id uniqueness',
      {
        requiredFacts: [
          validDomainContract().requiredFacts[0],
          { ...validDomainContract().requiredFacts[0], command: 'npx vitest run other.ts' },
        ],
      },
      'CONTRACT_DUPLICATE_ID',
    ],
    [
      'human review id uniqueness',
      {
        requiredFacts: [],
        humanReview: [
          { id: 'review', covers: ['scenario'], criterion: 'looks right', reason: 'visual' },
          { id: 'review', covers: ['scenario'], criterion: 'still right', reason: 'visual' },
        ],
      },
      'CONTRACT_DUPLICATE_ID',
    ],
    [
      'unknown review scenario',
      {
        requiredFacts: [],
        humanReview: [
          { id: 'review', covers: ['missing'], criterion: 'looks right', reason: 'visual' },
        ],
      },
      'CONTRACT_UNKNOWN_SCENARIO',
    ],
    ['uncovered scenario', { requiredFacts: [], humanReview: [] }, 'CONTRACT_SCENARIO_UNCOVERED'],
    [
      'generic command',
      { requiredFacts: [{ ...validDomainContract().requiredFacts[0], command: 'npx npm test' }] },
      'CONTRACT_GENERIC_COMMAND',
    ],
    [
      'MCP command syntax',
      {
        requiredFacts: [
          { ...validDomainContract().requiredFacts[0], command: 'validate_in_browser /home' },
        ],
      },
      'CONTRACT_MCP_COMMAND',
    ],
  ])('diagnoses the %s rule', (_name, replacement, expectedCode) => {
    const result = inspectSpecContract({ ...validDomainContract(), ...replacement });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(expectedCode);
  });
});
