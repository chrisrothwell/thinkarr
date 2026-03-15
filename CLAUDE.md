# Thinkarr

Details of the build are in PLAN.MD - refer to this for details of file structure and what has been built.

## Project context

Thinkarr is a **publicly shipped, self-hostable application** distributed to end users via Docker Hub. Users pull and run the image themselves — treat it like a public product, not an internal or personal tool. This affects decisions around:

- **Versioning** — semver matters; bump patch for bug fixes, minor for new features, major for breaking changes
- **Release notes** — changes visible to users should be documented
- **Breaking changes** — DB migrations must be safe for existing installs; config/env var changes need backward compat or a clear migration path
- **Docker image quality** — entrypoint, env vars, volume mounts, and default config are all user-facing interfaces

## Rule: always use qmd before reading files

Before reading files or exploring directories, always use qmd to search for information in local projects.

Available tools:

- `qmd search “query” -c "collection"` — fast keyword search (BM25)

- `qmd query “query” -c "collection"` — hybrid search with reranking (best quality)

- `qmd vsearch “query” -c "collection"` — semantic vector search

- `qmd get <file> -c "collection"` — retrieve a specific document

Use qmd search for quick lookups and qmd query for complex questions.

Use Read/Glob only if qmd doesn’t return enough results.

The collection name for this project is "thinkarr".  Example command: qmd get PLAN.MD -c thinkarr

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
Only the human manages the release flow:
1. Merge `dev` → `beta` to publish a `:beta` Docker image for testing
2. If stable, bump version in `package.json` on `dev`, merge `dev` → `beta` → `main`
3. Apply a `v*` tag to `main` to trigger the `:latest` Docker publish

## Rule: keep PLAN.md up to date

For every PR, update `PLAN.md` to reflect what was built or changed:

- Add a new phase section (or append to the current one) documenting features and bug fixes
- Update the **file structure** if new files were added
- Update the **config keys table** if new `app_config` keys were introduced
- Update the **API routes table** if new routes were added or existing ones changed

Do this as a separate commit on the same branch before pushing, so the PR includes the documentation alongside the code.

## Rule: tests for every change

For every feature or bug fix, check whether a unit or E2E test already covers the changed behaviour.

- If no test exists, add one as part of the same PR — do not open a separate PR for tests.
- Unit tests live in `src/__tests__/` and use Vitest.
- E2E tests live in `tests/e2e/` and use Playwright.
- Prefer unit tests for logic/API behaviour; prefer E2E tests only for UI interactions that can't be covered at the unit level.
- If an existing test already covers the behaviour, no new test is needed — but do not remove or weaken existing tests.