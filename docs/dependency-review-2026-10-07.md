# Production dependency review — 2026-10-07

The production audit reported 15 advisories, including one critical and five high.
Refresh Fastify, the MCP SDK and affected transitive packages within their existing
major versions. Update the existing Sharp override to 0.35.5. Narrow overrides for
gRPC 1.14.x and brace-expansion 5.x select their patched releases until upstream
dependency resolution does so without an override.

After resolution, `npx pnpm audit --prod --json` reports zero critical, high or low
advisories and one moderate advisory. The remaining advisory is not suppressed:
[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
affects sprintf-js 1.1.3 and has no published patched version as of this review.

The only production dependency path is
`@huggingface/transformers → onnxruntime-node → global-agent → roarr → sprintf-js`.
In the installed onnxruntime-node 1.24.3 package, global-agent is imported by
`script/install.js`, not its runtime modules. Autopod source does not import these
logging packages. The inspected global-agent 3.0.0 logging calls use literal format
strings and pass request URLs, headers and errors as structured context. They do
not pass those values as sprintf format strings, which is the advisory's trigger.

This source inspection found no reachable untrusted format-string path in the
current dependency chain. It is not a patch or a claim that the vulnerable package
has disappeared. Reassess this conclusion if the chain or its logging calls change,
and remove the dependency or adopt an upstream fix when one is available. Keep the
ordinary audit output visible; no blanket advisory waiver is added.

These package changes add no user state, prompt, approval or voice interruption.
They inherit the existing one-turn launch path and do not change worker authority.

## Follow-up — 2026-10-08

Remove the remaining vulnerable dependency through the narrow override
`onnxruntime-node@1.24.3>global-agent: 4.1.3`. The ONNX runtime and Transformers
versions remain unchanged. global-agent 4.1.3 no longer depends on roarr or
sprintf-js, so the vulnerable formatter and its logging chain leave the resolved
production dependency graph. `npx pnpm audit --prod --json` now reports zero
advisories of every severity. No advisory is ignored or suppressed.

This crosses a major version of an installer-only dependency. Upstream's
[4.0.0 release](https://github.com/gajus/global-agent/releases/tag/v4.0.0)
documents the Flow-to-TypeScript migration and TLS verification fixes. The
installer uses the retained `bootstrap()` API. A real loopback integration test
resolves the exact package used by ONNX and verifies its installer bootstrap, HTTP
proxy routing, NO_PROXY bypass, successful HTTPS CONNECT with a trusted CA, and
rejection of an untrusted certificate. Each bootstrap runs in a separate process;
no external network or persistent test certificates are used.

The override is restricted to ONNX 1.24.3. Remove it when Transformers adopts an
ONNX release that directly declares global-agent 4.1.3 or later, then rerun the
proxy test and dependency audit. This adds no voice turn, clarification, approval,
interruption, or spoken response, and changes no worker authority.
