# Package feeds

Package feeds are reusable installation integrations, not agent tool packs. A feed
contains an npm or NuGet HTTPS URL, optional npm scope, a shared credential
reference and an optional expiry reminder. Repository setups select feeds; the
resolved registry settings are frozen into each launch. Editing a feed affects
future launches, not the destinations or scope of existing pods.

## Desktop setup

1. Open **Profiles → Building blocks → Package feeds** and create a named feed.
2. Enter the HTTPS registry URL, package type and optional npm scope. For Azure
   Artifacts, use the URL from **Connect to feed** and a PAT restricted to
   **Packaging: Read** whose account has access to the feed.
3. Select an existing registry credential, or enter a new PAT in the secure field
   and choose **Store PAT securely**. The daemon encrypts the PAT; the editor only
   retains its credential ID in the feed draft. Tokens are never returned by reads.
4. Set the expiry reminder and **Save** the feed. Reopen it and select
   **Test saved connection**. Unsaved settings cannot be tested as if saved.
5. In each repository, open **Project setups → PR & registries** and select the
   shared feed. Save the repository. One unscoped npm feed is the default registry;
   different npm scopes can use different feeds. Conflicting defaults/scopes or
   generated NuGet source names are rejected at launch preview.

PAT storage/rotation is an immediate credential operation, separate from saving
feed metadata. Cancelling the feed editor does not undo a successful rotation or
delete a newly enrolled credential. After an ambiguous save error, reload metadata
before retrying. Unused enrolled credentials can be reused from the picker.

## Existing repositories and PAT rotation

Legacy inline registries remain supported and existing snapshots remain valid.
To adopt a shared feed, create it using the existing credential from the picker,
then select it on the repository and remove the equivalent inline registry entry.
Do not select both copies: a duplicate npm default or NuGet source is a conflict.
No production configuration is automatically migrated.

For an expired PAT, select its existing credential in the feed editor and enter a
replacement. **Rotate shared PAT** requires confirmation and an observed credential
revision; stale edits are rejected. Rotation affects *all* references to that
credential, including other feeds and legacy inline registries. Update expiry
reminders where applicable; expiry metadata is not a provider validity check.
An archived feed cannot be selected for new launches. Remove repository references
before archiving. Credential revocation is independent and fails closed at refresh.

Rotation alone never resumes a pod. For a pod awaiting a credential-blocker reply,
rotate the same credential identity, then explicitly reply to the blocker using
the existing pod controls. The existing continuation path
`getResumeEnv → validationEnvironmentForPod` resolves the current secret under the
frozen identity and rewrites protected npm/NuGet execution material before starting
the runtime. A failed write or revoked credential stops continuation. This retains
pod identity, work and budget; it does not select a new feed URL or bypass retry
admission. Use the appropriate existing recovery control for failed pods, not a
new launch. No separate auto-resume action is introduced by Package Feeds.

An in-flight install may still use the old credential: do not rotate and assume
already running processes have reloaded it. Refresh occurs on the next supported
execution/continuation. Deployment approval's credential-version binding is unchanged.

## Connection test semantics

Tests perform bounded read-only HTTP requests, never install or publish packages.
The npm test uses `/-/whoami`; the NuGet test reads the service index. A successful
authentication result requires the endpoint to deny anonymous access and accept
the credential with the expected JSON shape. It does **not** prove permission to
every package. Public endpoints and providers without a compatible probe return
**unverified**, not a green credential check. In particular, an Azure Artifacts npm
endpoint that does not support `whoami` cannot be conclusively tested by this probe;
validate it through the normal package installation after credential rotation.

401 and 403 are distinguished. Destination-policy refusals, redirects, timeouts,
network failures and invalid/oversized bodies produce a safe unavailable result,
not a claim that the PAT is invalid. Tests use public-IP DNS validation with pinned
transport, a total ten-second deadline and a 2 MiB body bound. Redirect credentials
are never forwarded. Upstream bodies, authenticated identity and secrets are not
returned in diagnostic results. Credential identity/revision and feed revision are
checked again after the probe.

## CLI

```sh
ap package-feed list --json
ap package-feed credential list
ap package-feed credential create --name 'Company packages' --origin https://pkgs.dev.azure.com
ap package-feed credential rotate CREDENTIAL_ID --expected-revision 1
ap package-feed create --name 'Company npm' --file feed.json
ap package-feed test 'Company npm'
```

Credential create/rotate require an interactive terminal and a hidden PAT prompt.
Never put a PAT in command arguments, a feed JSON file, chat or shell history.
The normal entity update/archive commands use `--expected-revision`.

Example `feed.json` (references only):

```json
{
  "type": "npm",
  "url": "https://pkgs.dev.azure.com/ORG/_packaging/FEED/npm/registry/",
  "credential": { "secretId": "ENROLLED_CREDENTIAL_ID" },
  "expiresAt": "2027-01-31"
}
```

Set `integrations.packageFeedIds` on repository setups using the repository editor
or its ordinary revision-checked CLI/API update. Generic preset APIs expose the
`packageFeed` kind. `POST /configuration/package-feeds/:id/test` takes
`expectedRevision`; existing operator-only credential APIs handle enrollment and
rotation. Feed payloads reject inline secrets. Credentials remain restricted to
`registry-read` and enrolled origins; source-control credentials are not reused.
