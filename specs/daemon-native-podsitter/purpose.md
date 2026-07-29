# Daemon-native Podsitter

## Problem

Podsitter currently lives in a machine-local Pi extension. It can reason about pod failures and perform useful overnight interventions, but only while the operator's laptop and Pi session remain running. Its authorization and deduplication ledger are also local to that Pi session rather than durable control-plane state.

Moving the existing extension into the daemon verbatim would remove the laptop dependency but would violate Autopod's provider-auth boundary. Subscription OAuth credentials are designed to execute through provider CLIs inside pods or sandboxes, and an LLM with direct daemon credentials would have excessive operational agency.

## Outcome

Autopod has a daemon-native Podsitter that continuously reconciles pod attention states, uses a dedicated provider account in an isolated repo-free system sandbox to make evidence-based decisions, and executes only typed daemon-owned actions. It survives daemon restarts, honors always-on or recurring authorization windows, pauses cleanly when the decision provider is limited, and resumes pending work when capacity returns.

The decision model has the full intervention repertoire of the current Pi Podsitter, including evidence-backed waivers and last-resort recovery actions, but it never receives an Autopod API token, MCP control tools, repository mounts, or arbitrary action execution capability.

## Users

- Operators running Autopod on an always-on hosted daemon.
- Operators using subscription OAuth who cannot call the provider directly from the daemon process.
- Teams that need unattended tending with durable reasons, budgets, provenance, and a kill switch.
- Reviewers auditing why an autonomous waiver, approval, retry, or recovery occurred.

## Success signal

An operator configures a dedicated provider account and enables Podsitter either continuously or on a recurring schedule. After the laptop is offline, the daemon detects a new attention state, launches a restricted system decision sandbox, records one structured decision, validates the decision against current pod state and intervention budgets, and executes it with Podsitter provenance. If the provider reaches an API or subscription limit, pending attention remains durable without consuming intervention attempts; after the limit lifts, the daemon probes successfully, rebuilds current evidence, and continues without operator involvement.

## Non-goals

- Running the current Pi extension inside the daemon process.
- Reusing an agent-controlled target pod container for system decisions.
- Falling back to the target pod's provider account or quota.
- Mounting a repository, worktree, Docker socket, daemon token, MCP configuration, or git credentials into the decision sandbox.
- Giving the decision model generic shell, HTTP, SQL, or Autopod API tools.
- Replacing PodManager lifecycle invariants, readiness review, validation, or action audit.
- Exposing per-action policy customization in the first release; full-parity policy is versioned and daemon-owned.
- Adding a mobile-web configuration surface in the first release.
- Automatically migrating or enabling the existing Pi Podsitter configuration.

## Glossary

- **Podsitter service** — daemon control loop that detects attention, builds evidence, requests decisions, applies policy, and executes interventions.
- **System decision sandbox** — short-lived, daemon-owned container used only for one structured LLM decision.
- **Dedicated provider account** — the explicitly selected provider account used only by Podsitter; target pod credentials are never a fallback.
- **Attention signature** — stable hash of the pod state and evidence that justified reconsideration.
- **Decision** — one structured proposal for one pod attention signature. A decision proposes at most one intervention.
- **Action executor** — typed daemon-owned adapter from a validated decision to PodManager operations.
- **Activation window** — always-on authorization or a recurring cron start plus duration, optionally bounded by an absolute expiry.
- **Provider circuit** — durable availability state and next-probe time for the dedicated decision account.
- **Full parity** — the current Pi Podsitter repertoire, including approvals, messages, waivers, validation/PR retries, update-from-base, credential/tool recovery, worktree recovery, force approval, skip validation, force completion, and manual-fix spawning.

## Reversibility

The feature is additive and disabled by default. Disabling Podsitter atomically invalidates in-flight decision authorization and leaves normal pod lifecycle behavior unchanged. Rollback stops the service and retains audit rows for inspection. The dedicated provider account remains a normal provider account and can be reused or deleted after Podsitter configuration is removed. Existing Pi Podsitter behavior remains available during rollout.
