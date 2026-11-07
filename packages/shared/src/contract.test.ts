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
    artifact: { path: test.ts, change: unsupported }
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

  it('retains the explicit complete validation input manifest and rejects incomplete identities', () => {
    const manifest = {
      version: 1,
      hermetic: true,
      toolchainFiles: ['tools/compiler'],
      dependencyPaths: ['node_modules'],
      environmentFiles: [],
      environmentRevision: 'a'.repeat(64),
    };
    expect(
      inspectSpecContract({ ...validDomainContract(), validationEvidence: manifest }).contract
        ?.validationEvidence,
    ).toEqual(manifest);
    for (const invalid of [
      { ...manifest, hermetic: false },
      { ...manifest, toolchainFiles: [] },
      { ...manifest, environmentRevision: 'mutable' },
      { ...manifest, dependencyPaths: undefined },
    ]) {
      expect(
        inspectSpecContract({ ...validDomainContract(), validationEvidence: invalid }).diagnostics
          .length,
      ).toBeGreaterThan(0);
    }
  });

  it('accepts an explicit delete declaration', () => {
    const contract = validDomainContract();
    const result = inspectSpecContract({
      ...contract,
      requiredFacts: [
        { ...contract.requiredFacts[0], artifact: { path: 'obsolete.ts', change: 'delete' } },
      ],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.contract?.requiredFacts[0]?.artifact.change).toBe('delete');
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

it('preserves explicit execution requirements in YAML and rejects unsafe executable and resource declarations', () => {
  const requirements = {
    version: 1,
    executables: ['node', 'dotnet'],
    minimumMemoryBytes: 2147483648,
    minimumCpu: 2,
  };
  expect(
    inspectSpecContract({ ...validDomainContract(), executionRequirements: requirements }).contract
      ?.executionRequirements,
  ).toEqual(requirements);
  expect(
    inspectSpecContract({
      ...validDomainContract(),
      executionRequirements: { ...requirements, executables: ['-v'] },
    }).diagnostics.length,
  ).toBeGreaterThan(0);
  expect(
    inspectSpecContract({
      ...validDomainContract(),
      executionRequirements: { ...requirements, minimumCpu: -1 },
    }).diagnostics.length,
  ).toBeGreaterThan(0);
  const parsed = inspectSpecContractYaml(`contract_version: 1
title: Environment
scenarios:
  - id: scenario
    given: [input]
    when: [compiled]
    then: [verified]
required_facts:
  - id: fact
    proves: [scenario]
    kind: custom-command
    artifact: {path: result.ts, change: create}
    command: node result.ts
execution_requirements:
  version: 1
  executables: [node, dotnet]
  minimumMemoryBytes: 2147483648
  minimumCpu: 2
`);
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.contract?.executionRequirements).toEqual(requirements);
});

function strictRequirements() {
  return {
    version: 2,
    executables: ['node'],
    platform: 'linux/amd64',
    minimumMemoryBytes: 1024 ** 3,
    minimumCpu: 1,
    requiredReferenceRepositories: [{ repositoryId: 'works', commitSha: 'a'.repeat(40) }],
    requiresImageBuild: true,
  };
}

it('preserves v2 fields without defaulting them into absent or v1 contracts', () => {
  const inspect = (executionRequirements: unknown) =>
    inspectSpecContract({ ...validDomainContract(), executionRequirements });
  expect(inspect(strictRequirements()).diagnostics).toEqual([]);
  expect(inspect(strictRequirements()).contract?.executionRequirements).toEqual(
    strictRequirements(),
  );
  expect(inspect({ version: 2, executables: [] }).contract?.executionRequirements).toEqual({
    version: 2,
    executables: [],
  });
  expect(inspectSpecContract(validDomainContract()).contract).not.toHaveProperty(
    'executionRequirements',
  );
  // v1 duplicates remain accepted; its nonempty executable list and strict object are unchanged.
  expect(inspect({ version: 1, executables: ['node', 'node'] }).diagnostics).toEqual([]);
  expect(inspect({ version: 1, executables: [] }).diagnostics.length).toBeGreaterThan(0);
  expect(
    inspect({ version: 1, executables: ['node'], platform: 'linux/amd64' }).diagnostics.length,
  ).toBeGreaterThan(0);
});

it.each([
  { version: 3 },
  { executables: undefined },
  { executables: ['node', 'node'] },
  { executables: Array.from({ length: 65 }, (_, i) => `tool${i}`) },
  { executables: ['-v'] },
  { executables: ['node;whoami'] },
  { executables: ['x'.repeat(257)] },
  { minimumCpu: 0 },
  { minimumCpu: 1025 },
  { minimumMemoryBytes: 1.5 },
  { minimumMemoryBytes: 1024 ** 4 + 1 },
  { platform: 'macos/arm64' },
  { requiresImageBuild: false },
  { unknownQualification: true },
  { requiredReferenceRepositories: [{ repositoryId: 'bad/id', commitSha: 'a'.repeat(40) }] },
  { requiredReferenceRepositories: [{ repositoryId: 'x'.repeat(129), commitSha: 'a'.repeat(40) }] },
  { requiredReferenceRepositories: [{ repositoryId: 'works', commitSha: 'A'.repeat(40) }] },
  { requiredReferenceRepositories: [{ repositoryId: 'works', commitSha: 'a'.repeat(41) }] },
  { requiredReferenceRepositories: [{ repositoryId: 'works', commitSha: 'main' }] },
  {
    requiredReferenceRepositories: [
      { repositoryId: 'works', commitSha: 'a'.repeat(40), token: 'no' },
    ],
  },
  {
    requiredReferenceRepositories: [
      { repositoryId: 'works', commitSha: 'a'.repeat(40) },
      { repositoryId: 'works', commitSha: 'b'.repeat(40) },
    ],
  },
  {
    requiredReferenceRepositories: Array.from({ length: 17 }, (_, i) => ({
      repositoryId: `ref${i}`,
      commitSha: 'a'.repeat(40),
    })),
  },
])('rejects malformed strict execution requirements: %j', (replacement) => {
  const result = inspectSpecContract({
    ...validDomainContract(),
    executionRequirements: { ...strictRequirements(), ...replacement },
  });
  expect(result.contract).toBeUndefined();
  expect(result.diagnostics.length).toBeGreaterThan(0);
});

it.each([
  'linux/amd64',
  'linux/arm64',
  'darwin/amd64',
  'darwin/arm64',
])('accepts the explicit v2 platform %s and exact SHA-256 reference revision', (platform) => {
  const requirements = {
    ...strictRequirements(),
    platform,
    requiredReferenceRepositories: [{ repositoryId: 'works', commitSha: 'b'.repeat(64) }],
  };
  const parsed = inspectSpecContractYaml(`contract_version: 1
title: Strict execution
scenarios: []
required_facts: []
execution_requirements: ${JSON.stringify(requirements)}
`);
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.contract?.executionRequirements).toEqual(requirements);
});
