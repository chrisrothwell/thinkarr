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

## Rule: CodeQL false positives

When GitHub Code Scanning raises a `js/ssrf` (or other) alert that is a confirmed false positive — i.e. the code has explicit URL validation that CodeQL cannot trace through — **dismiss the alert via the GitHub API**. Do not:

- Add `// lgtm[...]` comments — ignored by GitHub Code Scanning (only worked on the legacy lgtm.com product)
- Create `.github/codeql/codeql-config.yml` alone — GitHub's auto-setup ignores this file unless a custom workflow explicitly references it via `config-file:`
- Create `.github/workflows/codeql.yml` to replace GitHub's built-in scanning — this repo uses GitHub's auto-setup intentionally

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