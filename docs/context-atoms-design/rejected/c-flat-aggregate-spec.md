# Rejected: Flat aggregate spec documents

## What it was
The autopod SDD model — a `purpose.md`, `design.md`, `briefs/*.md` per feature, multi-page narrative documents that aim to capture the full context of a feature in one place.

## Why it looked attractive
- One place to read about a feature.
- Captures full context, narrative continuity, design rationale.
- Familiar — most teams already write something like this.
- Easy to version with the code.

## Why we rejected
- **Specs rarely get maintained.** They drift from code on the first PR that doesn't update them, and the gap widens.
- **They pollute agent context.** Too long, too much irrelevant content per task, biases the agent's exploration. Empirically verified: the ETH Zurich + LogicStar.ai AGENTS.md study (arXiv 2602.11988) found such context files REDUCED task success in 5/8 settings and added 20%+ token cost.
- **They make work feel "strict."** The agent reads the spec as a contract rather than guidance, which is exactly the opposite of what Esben wanted.
- **Reading cost is per-task, not per-feature.** Every agent run pays the full price of the spec, regardless of which sliver is actually relevant.

## What we want instead
- **Atomic** — one fact per file, ~30 lines.
- **Anchored** — selector can find them based on what the work touches.
- **Read selectively** — only what's relevant to the current envelope.
- **Captures intent and constraint only** — NOT procedure (the agent can grep the code for that).

## What would change our mind
- Long-form spec docs prove themselves on the ablation eval. (Unlikely; the study's evidence already runs against this.)
- A specific class of tasks emerges where narrative context outperforms atomic context. Then specs become a third kind for that class only.

## Provenance
Chat with Esben — this is the explicit problem the whole design exists to solve. 2026-05-28.
