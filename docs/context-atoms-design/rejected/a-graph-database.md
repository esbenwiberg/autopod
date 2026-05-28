# Rejected: Graph database (Neo4j et al.)

## What it was
Store atoms as nodes, links as edges, in a real graph database. Query via Cypher or similar.

## Why it looked attractive
- Industry pattern (Mem0, Cognee, Zep) uses graph layers.
- "Who depends on what" and "what was superseded when" queries map naturally to graph traversal.
- 13 agent frameworks supported graph memory integrations as of early 2026.

## Why we rejected
- **Scale is small.** Thousands of atoms per repo, not millions. Indexed SQL joins are faster than graph DB query planning at this size.
- **Operational cost.** A second store to back up, migrate, version, and reason about.
- **The graph queries we actually want are 1–2 hop traversals** — trivial in SQL with explicit `memory_links(from_id, to_id, kind)` rows.
- **Files-as-canonical works without ANY runtime store.** A graph DB violates that property and ties consumers to a service.
- A relational schema with explicit link rows gives ~80% of graph benefits at ~5% of cost.

## What would change our mind
- Corpus grows past ~100k atoms with frequent deep traversal queries (>3 hops, ad hoc).
- A graph-native UX feature (path queries, subgraph patterns) becomes load-bearing in product.

## Provenance
Chat with Esben, 2026-05-28. Web research turn on Mem0 / Letta / Zep / Cognee.
