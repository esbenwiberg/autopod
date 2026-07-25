# Provider failover desktop handoff

Brief 03 owns the desktop layers deliberately omitted from the profile failover backend change.
Its implementation should consume the following wire contract without changing the precedence
semantics.

## Profile fields

- `providerFailover: ProviderFailoverPolicy | null`
  - `null` means inherit through the profile family, then use the linked provider-account default.
  - A non-null policy replaces the account default completely; target lists are never merged.
  - `{ "targets": [] }` is an owned override that disables automatic failover.
- The profile editor payload optionally includes
  `providerFailoverResolution: { policy, source }`.
  - `source` is `profile`, `account-default`, or `none`.
  - `profile` includes policies inherited from a parent profile; it distinguishes the profile
    family from the provider-account default.

Older daemon responses may omit the new fields, so native decoding must remain optional.

## Editor behavior

Map the profile override control directly to nullability:

- override off: send `providerFailover: null`;
- override on with no rows: send `providerFailover: { targets: [] }`;
- override on with rows: send the complete ordered policy.

Each target contains `providerAccountId`, `runtime`, and `model`; the policy may also contain
`maxHops`. Use the raw profile value to initialize the override control and the resolved value and
source for inherited/default presentation. Do not write a resolved inherited value back during a
no-op save.

The TypeScript CLI's `getProfileEditor(name)` and raw-value editing path are the reference consumer.
The daemon rejects missing, unauthenticated, incompatible, self-referential, cyclic, or
family-invalid targets and preserves the prior configuration on failure.

## Desktop checklist ownership

Brief 03 must complete the deferred `add-profile-field` consumers:

- optional response decoding and request encoding;
- UI profile model and response-to-model mapping;
- derived-profile field catalog and override card;
- base profile Providers card and ordered target editor;
- provider-account default-chain editor, including loading and inline save/validation errors.

No desktop files were changed by brief 02.
