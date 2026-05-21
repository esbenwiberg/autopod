# Scenario Browser QA

## Status

Parked idea. Not committed, not roadmap, not an ADR.

## Question

Could Autopod use `contract.yaml` scenarios as input to an LLM-driven browser QA
pass? In other words: for each Given/When/Then scenario, have a model browse the
running app, perform the behavior, attach screenshots, and report whether the
scenario appears satisfied.

## Current Read

Do not add this as a separate blocking validation phase yet.

The stronger near-term direction is to improve how `/plan-feature` and `/prep`
author `browser-test` required facts from scenarios. Scenarios should describe
behavior. Required facts should remain the executable proof layer.

This preserves the contract model:

- `scenarios` describe the behavior in domain language.
- `required_facts` prove one or more scenarios with durable artifacts and
  narrow commands.
- `human_review` covers judgment that cannot honestly become executable yet.
- AI/browser exploration can be useful evidence, but should not become a second
  validation semantics beside required facts.

## Why This Came Up

The desktop Validation tab shows scenarios and required facts separately. After
tightening the UI, scenario cards can now show the facts that prove each
scenario. That raised a product question: if the scenario already has Given,
When, and Then, could Autopod ask an LLM to browse the app and QA it directly?

The answer is: possibly, but the extra value is not proof. The extra value is
exploratory judgment.

Examples where exploratory QA might notice something facts miss:

- A fact proves the API returns a canonical repo string, but the Reviews UI still
  displays the raw input.
- A fact checks that a component exists, but the flow lands on the wrong tab.
- A fact verifies a narrow state transition, but the end-to-end screen journey is
  confusing or visibly broken.
- A fact passes technically, but screenshot evidence shows an empty, awkward, or
  ambiguous state.

Those are useful observations, but they are not the same as durable validation.
If they matter enough to block merge, they should usually be converted into a
required fact.

## Council Summary

The code-council framing was:

> Is a browser QA runner driven by contract scenarios a good idea?

The decisive variable was whether it would be advisory evidence or a blocking
validation gate.

### Strongest Case For

Autopod already has several pieces of the machinery:

- `FactKind` already includes `browser-test`.
- `RequiredFact.proves` already links proof artifacts to scenarios.
- The validation engine already routes `browser-test` facts through browser
  execution.
- The validation prompt already includes scenarios and executed facts for AI
  review.
- Desktop already displays contract scenarios, fact counts, and fact details.

So the basic product shape is coherent: scenario behavior can be connected to
browser-visible proof.

### Strongest Case Against

The capability is already expressible as `browser-test` required facts. Adding a
separate "scenario QA runner" risks creating overlapping proof layers:

- smoke pages,
- browser-test facts,
- AI task review,
- human review,
- and then scenario-driven LLM QA.

That would make it less clear which layer owns truth. It could also encourage
broad natural-language checks that bypass the current required-fact discipline:
durable artifact, narrow command, explicit scenario coverage.

## Decision For Now

Do not build a separate scenario-browser QA runner now.

Instead:

1. Keep scenarios descriptive.
2. Keep required facts as the blocking proof layer.
3. For user-visible behavior, require at least one `browser-test` fact when the
   repo has a runnable web UI.
4. Improve planning so each scenario has an obvious proof matrix:
   - primary fact that validates the outcome,
   - corroborating facts that catch wiring regressions,
   - weak-proof risks where a fact could pass while the feature is broken.
5. If an LLM browser pass is added later, make it advisory by default:
   screenshot-backed observations attached to scenario cards, not an automatic
   merge gate.

## What It Would Give Us

Only build this if we want one of these products:

- Advisory QA notes beside each scenario.
- Screenshot-backed scenario observations in the desktop UI.
- Suggestions for missing or weak `browser-test` facts.
- A planning assistant that turns Given/When/Then scenarios into durable
  Playwright facts.
- Exploratory UI review for flows that are hard to encode deterministically.

The best first version is probably not "run QA after implementation." It is
"help author better facts before implementation."

## What It Should Not Become

- A replacement for required facts.
- A new blocking phase that can fail pods based only on model judgment.
- A parallel browser harness that duplicates smoke pages and `browser-test`
  facts.
- A way to hide weak contracts behind "the LLM looked at it."
- A broad natural-language test suite with no durable artifact after merge.

## Revisit When

Reopen this if one or more of these become true:

- We see repeated UI regressions where required facts pass but screenshots or
  human review catch obvious broken behavior.
- Contract authors struggle to write good `browser-test` facts from scenarios.
- Scenario cards need richer evidence than pass/fail fact chips.
- The desktop UX wants a "review this scenario visually" workflow.
- We add a stable browser evidence artifact format that can attach observations
  to scenarios without becoming a blocking gate.

## Possible Future Shape

If revived, prefer this order:

1. Add a scenario proof matrix to `/plan-feature` and `/prep` show-backs.
2. Add fact-authoring help: propose `browser-test` facts from UI scenarios.
3. Attach browser evidence to scenarios in the desktop UI.
4. Only then consider an advisory LLM browser QA pass.

Blocking validation should remain fact-driven unless there is a separate ADR
that explicitly changes Autopod's contract model.
