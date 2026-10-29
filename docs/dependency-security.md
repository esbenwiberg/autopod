# Dependency security compatibility

Security updates must pass the normal lint/build/declaration/test/secret-scan gates and an
unwaived dependency audit. A clean audit does not prove runtime behavior, cloud access,
current-source validation, execution settlement, or report preservation.

## Azure Identity / MSAL

Azure Identity 4.14 requests MSAL 6, but the relevant confidential-client authorization-response
security fix requires MSAL 7.1 or later. The narrowly scoped
`@azure/identity>@azure/msal-node` compatibility pin selects 7.1.2. It deliberately does not
change the CLI's independent MSAL 2 authentication/account/cache.

The MSAL 6/7 interactive changes remove deprecated custom loopback/response-mode options.
The reviewed Identity integration does not supply those options. Tests exercise the actual
Identity/MSAL confidential-client HTTP protocol and token cache, plus refusal of an unapproved
tenant, with all HTTP intercepted in memory. They are not real Azure/managed-identity
qualification. Review this pin again when updating Identity or changing credential flows;
do not generalize it to every MSAL consumer.

## Zod 4

First-party schemas use the patched v4 implementation, not the vulnerable `zod/v3`
compatibility import. Bounded collection regressions cover child/refinement work and primitive
array issue generation inside object validation. Oversized inputs must fail before parsing
all their elements. Schemas without a collection bound still require appropriate application
input limits; upgrading Zod alone does not create those limits.

Compatibility is behavioral, not just a successful package install:

- Records declare string keys explicitly. The merge-strategy enum record remains partial,
  while unknown keys and invalid merge modes remain rejected.
- Nested creation defaults that need parsing use `prefault`, not an unchecked object default.
- PATCH and launch override schemas use `partialWithoutDefaults`. Missing **and explicit
  undefined** fields cannot invoke creation defaults or reset unmentioned settings. The helper
  retains field validators, strict/catchall policy and precise field types; it refuses to
  discard root-object refinements. Its single mapped-shape assertion restores the key/value
  correlation erased by `Object.fromEntries`, not the validity of untrusted input.
- Contract-facing diagnostics are normalized from typed issues instead of depending on
  vendor prose. Existing contract assertions remain in place.
- Actual MCP client/server in-memory protocol tests cover JSON-schema publication and
  argument rejection before handler dispatch, not merely a mocked registration API.

Canonical tsup declarations must cover changed private production modules explicitly when
ordinary entry-point declaration generation does not check them. Route qualification needs
the application's real Fastify auth augmentation, not a fabricated test declaration.
