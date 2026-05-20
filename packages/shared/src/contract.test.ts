import { describe, expect, it } from 'vitest';
import { parseSpecContract } from './contract.js';

describe('parseSpecContract fact kinds', () => {
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
});
