# Production release and upgrade acceptance

## Release scope

The core release covers the web app and the supported OpenClaw/WhatsApp companion: private Plex linking, scoped title facts, explicit movie/TV-season selection, native human confirmation, actor-attributed Seerr requests and truthful immediate outcomes. Seerr owns approval and completion notifications.

The stable release pair is app **1.1.9** with companion **1.0.0**, pinned to OpenClaw **2026.10.4**. The app patch adds an automatic forward migration for missing legacy MCP channel tables; existing production volumes, login state, conversations and companion enrollment are retained. The companion retains the 0.3.11 runtime/configuration contract without a configuration migration. Beta execution logs verify an acknowledged request and exact-turn duplicate-reply cancellation on 0.3.11; the stable artifacts still require their own version/checksum and startup verification. Managed hot-upgrade behavior remains an accepted limitation below. IMDb/artwork cards (#533) and thumbs-up reaction confirmation (#539) are subsequent feature upgrades; quoted-text confirmation remains the supported flow.

## Automated gates

All required PR gates must pass on the reviewed release tree: lint, type-check, unit tests, SDK compatibility, production audits, SAST, E2E, CodeQL and Gitleaks. App CI runs Node 26, matching the Docker runtime.

CodeQL's saved SARIF is checked explicitly for error-level findings (including query-default levels). Missing/corrupt reports or failed analysis block the gate. PR checks run full-tree queries rather than diff-informed queries, so unchanged findings cannot disappear behind a promotion baseline. The required job keeps `upload: false`; GitHub's default main-branch scanning still uploads to the Security tab.

Five administrator-selected connection-probe false positives have existing owner dismissals in GitHub (alerts 22, 28, 7, 8 and 9). `.github/codeql-reviewed-findings.json` maps only those exact rule/location pairs to those alerts. Acceptance requires a live GitHub `false positive` dismissal and the reviewed source digest: all non-test files under `src/`, plus `package.json` and `package-lock.json`. A changed runtime/dependency snapshot, new finding, reopened/non-false-positive alert, missing token or failed API request blocks the gate. This is an explicit reviewed disposition, not a rule/file exclusion; full-tree analysis still emits the findings and the gate reports how many reviews it verified.

When runtime or dependency code changes, re-review the affected trust boundaries and GitHub dispositions before updating the digest. Compute it with `node --input-type=module -e 'import {sourceDigest} from "./scripts/codeql-reviewed-findings.mjs"; console.log(await sourceDigest(process.cwd()));'`. A digest refresh is a reviewed code change, not an automatic workflow repair. CI grants only `security-events: read` and uses its job-scoped token to verify reviews; it cannot create or dismiss alerts.

`npm run pack:openclaw` validates the distributable rather than only source files. It checks archive contents, installs and audits production dependencies in a clean consumer with engine checks, imports the packed runtime, and verifies synchronous registration, lifecycle version, hooks, skill roots, admitted tool descriptors and rejection of context-free identities. The smoke uses placeholder configuration and prohibits registration-time network I/O; it is not a live host/provider test.

The beta/tag image pipeline first runs its own full-tree CodeQL release gate on the exact checkout. Tests and companion packaging depend on that gate; Docker schema recovery/smoke, image scanning, both architecture builds/digest pushes and manifest/release publication follow transitively. A green PR scan is not a substitute for this in-workflow publication gate. Local Docker unavailability must remain explicitly recorded; a local exception does not waive those CI gates.

The public health endpoint probes all exported schema tables/columns, including delegated MCP tables, without reading rows. A missing table/column returns 503 with a fixed response; database details stay out of the public response.

## Candidate artifacts

Download the companion workflow artifact from the exact passing PR/beta run. It contains:

- `thinkarr-openclaw-<companion-version>.tgz`
- The matching `.tgz.sha256`
- `thinkarr-openclaw-release.json`: app/companion/host versions, archive hash, build runtime and CI source commit

Verify the checksum in that directory:

```bash
sha256sum -c thinkarr-openclaw-1.0.0.tgz.sha256
```

Use the validated archive for acceptance and distribution; do not substitute an unrelated local build with the same version label. `npm run pack:openclaw -- --output <fresh-directory>` supports a local reproduction and refuses to overwrite existing output.

The image UI reports the actual package version, including the beta iteration. Compare it with artifact metadata and the companion's **full runtime** `registration.ready` / `lifecycle.ready` version; a saved package, context-free catalog or discovery instance alone is not activation proof.

Binary promotion does not move integration state between instances. Verify the companion targets the intended production endpoint and its public `/api/mcp/info` audience. Preserve each instance's own `/config` and native enrollment during upgrades. A separate production instance uses the existing owner-authorized setup procedure for that instance; beta credentials/bindings are not a substitute, and a beta database must not overwrite an existing production database merely to reuse them.

## Owner-operated beta acceptance

Record pass/fail evidence against the release commit, image digest and companion checksum. Keep participant identifiers, credentials, private URLs/codes and raw chat out of public release records. Existing bindings, keys, SecretRefs, unrelated tools and finance routing are retained during upgrades.

| Acceptance | Required evidence |
| --- | --- |
| Startup/schema | Deployed image reports the candidate version and `/api/health` returns 200 after startup/migrations. Existing login/conversations remain usable. |
| Existing deployment fixes | Record beta verification of #457 (Plex reconnect/recovery, reporting errors and server discovery). Resolve the applicable production-ingress TRACE check from #403, or record that the original affected ingress has been retired. Infrastructure changes stay operator-owned. |
| Group media boundary | Media runs use the scoped Thinkarr tools and cannot route around a denial with a legacy/admin MCP credential. Review the operator-owned group tool policy while preserving unrelated finance tools. No additional participant allowlist is introduced. |
| Linking/recovery | One authorized participant can finish private linking; an existing binding still works. A missing linking grant gives operation-allowlist guidance; correcting it needs no reenrollment or key rotation. Unconfirmed private delivery remains described as unconfirmed. |
| Isolation | A second admitted participant resolves to their own Plex/Seerr account. Forwarded codes, another participant's prompt and unsupported sender identities cannot authorize their request. |
| Movie and TV | Owner-initiated movie and explicit-season TV flows preserve the exact title/season choice and Seerr permissions/quota/approval. Returned attribution matches the linked participant. |
| One prompt/result | One selection gives one native prompt; attempted redundant model output is blocked/cancelled. Logs show `presentation.guard_armed`, native confirmation outcome and receipt-checked result. Finance/unrelated quotes and later turns remain unmuted. |
| Uncertain writes | A lost/unknown outcome is inspected before another attempt; no blind retry or duplicate request. A successful request need not be repeated merely to test prompt presentation. |
| Upgrade/rollback | Preserve backup/prior artifacts and verify the full executing version, existing binding/config and channel connection after installation or recovery. Managed hot replacement is an owner-accepted exception for this release (#527); retain the reproduction/rollback work for a future release. |

**Accepted release limitation — #527:** the owner accepts managed hot-replacement drain timeouts/saved-versus-executing version mismatches for app 1.1.8 / companion 1.0.0 and defers diagnosis and repair to a future release because reproductions require time-consuming upgrade attempts. This exception permits stable promotion; it does not establish successful managed-upgrade acceptance or waive automated/security gates. Idle companion work counts are not the host's retained-lease counts. Capture host drain/apply/saved-versus-active facts and old/new instance logs when troubleshooting. Preserve evidence and follow the host's explicit recovery receipt, using an owner-operated external-supervisor/container restart when needed. Do not delete a live connection lock. Repeated reloads, a longer timeout, forced cancellation or automatic restart do not establish a fix. The diagnostic connection remains read-only; live installation/recovery is an owner-operated step.

Before updating, take a consistent backup of `/config` and the protected host configuration/secret store using the deployment's normal backup procedure. Retain the prior image digest and companion archive/checksum. Roll back the matched code artifacts if needed; do not replay successful Seerr writes or restore credentials blindly as a conversation repair. Resolve any unknown write outcome before a new request.

## Promotion

1. Record beta acceptance and the owner-accepted #527 exception in the release PR; keep unresolved feature work in separate issues. Do not mark unperformed acceptance checks as passed.
2. Through a feature PR to `dev`, strip the beta suffix for the full app release (`1.1.9-beta.N` → `1.1.9`). The unchanged companion remains `1.0.0`.
3. Promote `dev → beta → main` through reviewed PRs with required checks. The human controls merges and release timing.
4. The human or explicitly authorized release agent tags the stable `main` commit as `v1.1.9`. The pipeline verifies tag/package parity and main ancestry before publication.
5. After image/security gates pass, the pipeline publishes the image and the exact validated companion/checksum/compatibility metadata as GitHub Release assets. Existing different release assets are not overwritten; identical assets are safe on rerun.
6. Confirm the production image and executing companion version, then turn detailed debug logging off after acceptance evidence is captured.

## Existing-agent production MCP setup

Helga is an existing OpenClaw agent that will use the production Thinkarr MCP instance. After the stable image/artifacts are published and deployed, use the packaged [agent setup guide](connectors/openclaw/SETUP.md) with the production MCP endpoint and its discovered `/api/mcp/info` audience. Reuse a valid enrollment for that same production instance; if Helga is not enrolled there, obtain an owner-authorized production setup grant and create its scoped integration/key/credential through the existing helper. A beta enrollment or participant binding does not transfer to production.

Preserve Helga's unrelated tools, routing and native secret store. Configure the production integration's allowed group, receiving bot identity, public linking origin and operation grants; keep service authentication separate from each participant's Plex/Seerr link. Verify the full companion version and channel connection, then let participants complete private account linking against production. Deployment, secret input, enrollment and an actual request remain owner-authorized rollout actions, not consequences of a version bump.

## Periodic upgrades

Use small, reviewable batches: urgent correctness/security fixes as needed, and a monthly feature release when ready. Each batch repeats the beta acceptance for changed behavior and upgrade compatibility. Keep the prior release installable, publish app/companion/host compatibility and notable operator actions, and pin the supported host until its SDK/runtime compatibility has been verified. Changes such as IMDb/poster cards should extend the stable request contract with optional metadata and graceful fallback in a later feature batch.
