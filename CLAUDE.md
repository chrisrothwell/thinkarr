# Thinkarr

Details of the build are in PLAN.MD - refer to this for details of file structure and what has been built.

## Rule: branch and merge strategy

**Never push directly to `main`, `beta`, or `dev`.** All changes must go through a PR.

### Branch model

```
feature branches → dev → beta → main
```

| Branch | Purpose |
|--------|---------|
| `dev` | Integration — all PRs target here |
| `beta` | Staging — merged from `dev` when ready to test a release; triggers `:beta` Docker image |
| `main` | Production — merged from `beta` only when stable; `v*` tag triggers `:latest` Docker image |

### Docker tags produced

| Git event | Docker tags |
|-----------|-------------|
| Push to `beta` | `:beta` |
| `v*` tag on `main` | `:latest`, `:1.2.3`, `:1.2` |

### Branch naming (Claude branches)
- All Claude branches must be named: `claude/<short-description>-<random-id>`
- Always branch off `dev`, not `main` or `beta`

### Workflow for every task
1. `git checkout dev && git pull origin dev`
2. `git checkout -b claude/<description>-<id>`
3. Make changes, commit
4. `git push -u origin claude/<description>-<id>`
5. Open a PR targeting `dev` using `gh pr create --base dev`
6. Stop — do not merge the PR. Wait for CI to pass and the human to approve.

### Never do these
- `git push origin dev`, `git push origin beta`, or `git push origin main`
- `gh pr merge` without explicit human instruction
- Force push to any branch
- Bypass CI with `--no-verify`

### Releases
Only the human manages the release flow. All version bumps go through PRs — never commit directly to `dev`, `beta`, or `main`.

1. Open a PR from a `claude/bump-version-*` branch into `dev` bumping `package.json` to `1.1.0-beta.1`
2. **Run local security checks** (see Rule below) — must pass before opening `dev → beta` PR
3. Merge `dev` → `beta` via PR → CI publishes `:beta` Docker image
4. Test the `:beta` image
5. If fixes needed: more feature PRs → `dev`, then another `dev` → `beta` PR
6. When stable: open a PR bumping `package.json` to `1.1.0` into `dev`
7. Merge `dev` → `beta` → `main` via PRs
8. Apply `v1.1.0` tag to `main` → CI publishes `:latest` Docker image

## Rule: version bump on every release PR

**Always check and bump `package.json` before opening a `dev → beta` or `beta → main` PR.**

### Version bump logic

| Situation | Example current | Bump to |
|-----------|----------------|---------|
| Starting a new beta cycle | `1.1.3` | `1.1.4-beta.1` |
| Additional beta iteration | `1.1.4-beta.1` | `1.1.4-beta.2` |
| Full release (beta → main) | `1.1.4-beta.2` | `1.1.4` |

### Workflow

1. Compare `package.json` on `dev` vs `beta` (or `beta` vs `main` for a full release).
2. If the versions match, raise a `claude/bump-version-*` PR to `dev` first and wait for it to be merged before opening the release PR.
3. When raising the `dev → beta` PR, use `?template=dev-to-beta.md` so the checklist pre-fills.

### Rules
- Never open a `dev → beta` PR if `package.json` on `dev` still matches `beta`.
- For a full release: strip the `-beta.x` suffix (e.g. `1.1.4-beta.2` → `1.1.4`) — do not just bump the patch number independently.
- The bump always goes through a PR — never commit directly to `dev`, `beta`, or `main`.

## Rule: run local security checks before dev → beta

Before opening a `dev → beta` PR, run all three checks locally and confirm they pass. This avoids wasted CI cycles on the beta pipeline.

### 1. npm audit
```bash
npm run security:audit
# Must exit 0 (no HIGH/CRITICAL vulnerabilities)
```

### 2. Semgrep SAST (requires semgrep installed via pipx in WSL2)
```bash
# Run from WSL2 terminal:
cd /mnt/c/Users/me/Documents/git/thinkarr
semgrep --config=p/typescript --config=p/nextjs --config=p/owasp-top-ten src/ --error
# Must report 0 findings
```

### 3. Trivy Docker image scan (requires Docker running in WSL2)
```bash
# Build the image first:
docker build -t thinkarr:local-test .

# Run Trivy scan (from WSL2):
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/.trivyignore:/.trivyignore \
  aquasec/trivy:latest image thinkarr:local-test \
  --exit-code 1 --severity CRITICAL,HIGH --ignore-unfixed --ignorefile /.trivyignore

# Must exit 0 (no unfixed CRITICAL/HIGH findings outside .trivyignore)
```

Only open the `dev → beta` PR once all three pass locally.

## Rule: keep PLAN.md up to date

For every PR, update `PLAN.md` to reflect what was built or changed:

- Add a new phase section (or append to the current one) documenting features and bug fixes
- Update the **file structure** if new files were added
- Update the **config keys table** if new `app_config` keys were introduced
- Update the **API routes table** if new routes were added or existing ones changed

Do this as a separate commit on the same branch before pushing, so the PR includes the documentation alongside the code.

## Rule: CodeQL is a required gate on dev, beta, and main

CodeQL runs as the `codeql` job in `.github/workflows/ci.yml` and is included in the `CI Complete` gate. This means CodeQL must pass on every PR to `dev`, `beta`, and `main`.

**Rationale:** `:beta` is a deployable Docker image with the same network attack surface as `:latest`. Security vulnerabilities must be caught before the image ships, not only on the `beta → main` PR.

The `codeql` job uses `upload: false` on the `analyze` step to avoid the "advanced configuration cannot be processed when default setup is enabled" conflict. GitHub's default setup continues to upload results to the Security tab for `main`; the `ci.yml` job acts as a local gate on `dev` and `beta` PRs, failing CI on `error`-level findings and saving the SARIF as a downloadable artifact. Do not remove the `codeql` job from `ci.yml` and do not change `upload: false` to `true`.

## Rule: CodeQL false positives

When GitHub Code Scanning raises a `js/ssrf` (or other) alert that is a confirmed false positive — i.e. the code has explicit URL validation that CodeQL cannot trace through — **dismiss the alert via the GitHub API**. Do not:

- Add `// lgtm[...]` comments — ignored by GitHub Code Scanning (only worked on the legacy lgtm.com product)
- Create `.github/codeql/codeql-config.yml` alone — GitHub's auto-setup ignores this file unless a custom workflow explicitly references it via `config-file:`
- Create `.github/workflows/codeql.yml` to replace GitHub's built-in scanning — this repo uses GitHub's auto-setup intentionally; the `codeql` job in `ci.yml` supplements it, it does not replace it

### How to dismiss via `gh` CLI

```bash
# 1. Find the alert numbers
gh api repos/chrisrothwell/thinkarr/code-scanning/alerts \
  --jq '.[] | select(.state=="open") | "\(.number) \(.rule.id) \(.most_recent_instance.location.path)"'

# 2. Dismiss each false positive (replace 14 with the actual alert number)
gh api --method PATCH \
  repos/chrisrothwell/thinkarr/code-scanning/alerts/14 \
  -f state=dismissed \
  -f dismissed_reason=false_positive \
  -f dismissed_comment="<one-line explanation of why the validation makes this safe>"
```

### Accepted dismissed_reason values
- `false_positive` — CodeQL cannot trace through a custom validation function
- `won't fix` — risk accepted and documented
- `used in tests` — alert is in test-only code

## Rule: tests for every change

For every feature or bug fix, check whether a unit or E2E test already covers the changed behaviour.

- If no test exists, add one as part of the same PR — do not open a separate PR for tests.
- Unit tests live in `src/__tests__/` and use Vitest.
- E2E tests live in `tests/e2e/` and use Playwright.
- Prefer unit tests for logic/API behaviour; prefer E2E tests only for UI interactions that can't be covered at the unit level.
- If an existing test already covers the behaviour, no new test is needed — but do not remove or weaken existing tests.

## Rule: two E2E tiers — full suite vs. Docker smoke

The E2E suite is split into two tiers with distinct purposes:

| Tier | Config | Spec files | When it runs |
|------|--------|-----------|--------------|
| Full suite | `playwright.config.ts` | All `*.spec.ts` files | Every PR — fast dev-server feedback on all features |
| Docker smoke | `playwright.docker.config.ts` | `smoke-docker.spec.ts` only | Beta CI — verifies the built image boots and infrastructure is wired correctly |

### What the Docker smoke covers (and why)

The smoke suite exists to catch Docker-specific failure modes that the dev server can't surface:

- Container boots and serves requests (routing/redirects work)
- `next build` standalone output is intact (pages render)
- Env vars are injected correctly (`PLEX_API_BASE`, `SECURE_COOKIES`, `API_RATE_LIMIT_MAX`)
- Plex OAuth completes and a session cookie is issued
- A chat round-trip succeeds (LLM `baseUrl` reaches the app)

Application-logic coverage (title cards, rate-limit UI, conversation history, etc.) is **not** repeated in the smoke suite — the same JS runs in both environments, so there is no additional signal in duplicating those tests against Docker.

### Adding new E2E tests

- New feature tests → add to the appropriate `*.spec.ts` file; they run in the full suite only.
- If a new test exercises a Docker-specific infrastructure concern (new env var, new mount, new entrypoint behaviour), add it to `smoke-docker.spec.ts`.
- Do **not** add feature/logic tests to `smoke-docker.spec.ts`.
## Rule: use /beta-logs before diagnosing runtime issues

When investigating a bug reported against beta (unexpected behaviour,
missing data, wrong API response), run /beta-logs first to pull the last
300 log lines from the live container before forming a hypothesis.

- The command requires `THINKARR_INTERNAL_KEY` to be set in `.claude/settings.json` under `env`
- Retrieve the key from **Settings → Logs → Internal API Key** in the beta admin UI
- Do not commit or log the key value
