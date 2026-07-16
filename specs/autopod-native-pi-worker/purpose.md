# Autopod-native Pi worker

## Problem

Autopod can orchestrate multiple vendor agent CLIs, but it has no worker runtime owned and shaped by Autopod itself. This leaves provider-neutral execution and Autopod-specific runtime enforcement tied to vendor CLI adapters, while Pi cannot currently consume Autopod's MCP control plane or run under the pod lifecycle.

## Outcome

Users can select Pi in CLI or desktop profiles and run a fully managed Pi worker in local or Azure sandboxes, with the same MCP capabilities and lifecycle guarantees as existing runtimes, while Claude Code, Codex, and Copilot continue to work unchanged.

## Users

- Autopod operators who want a provider-neutral, Autopod-controlled worker.
- Existing Claude Code users who must retain subscription-backed Claude execution.
- Profile authors using the CLI or macOS desktop application.
- Pod workers requesting bounded control-plane capabilities through MCP.

## Success signal

A Pi-selected pod launches in the configured execution target, authenticates with its selected API-key or subscription provider, invokes pod-scoped MCP tools, survives a follow-up on the same session, and completes with normalized Autopod events; selecting any existing runtime still launches that runtime.

## Non-goals

- Removing, wrapping, or deprecating existing runtimes.
- Replacing MCP or changing control-plane policy.
- Changing Azure sandbox provisioning.
- Migrating existing profiles automatically.
- Granting pods complete multi-provider Pi credential bundles.
- Trusting executable Pi resources supplied by the checked-out repository.

## Glossary

- **Pi runtime** — the Autopod `Runtime` adapter controlling a Pi RPC subprocess inside a pod container.
- **Pi worker package** — the pinned, Autopod-owned Pi extension that bridges MCP and enforces managed-worker startup constraints.
- **Existing runtime** — Claude Code, Codex, or Copilot CLI adapters retained as siblings of Pi.
- **Control plane** — Autopod's existing authenticated MCP endpoint, `PodBridge`, and daemon services.
- **Pi OAuth entry** — one provider-specific credential object extracted from Pi's `auth.json`, encrypted under one profile or provider-account owner.
- **Managed worker** — an agent process provisioned and supervised by Autopod rather than an interactive local Pi session.

## Reversibility

The change is additive. Rollback removes `pi` from selectable runtime schemas and image generation while leaving existing profile values rejected with an explicit unsupported-runtime error. No existing credential format, runtime behavior, database column, or control-plane API is deleted or migrated.
