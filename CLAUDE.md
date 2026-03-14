# Thinkarr

Details of the build are in PLAN.MD - refer to this for details of file structure and what has been built.

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

**Never push directly to `main` or `dev`.** All changes must go through a PR.

### Branch naming
- All Claude branches must be named: `claude/<short-description>-<random-id>`
- Always branch off `dev`, not `main`

### Workflow for every task
1. `git checkout dev && git pull origin dev`
2. `git checkout -b claude/<description>-<id>`
3. Make changes, commit
4. `git push -u origin claude/<description>-<id>`
5. Open a PR targeting `dev` using `gh pr create --base dev`
6. Stop — do not merge the PR. Wait for CI to pass and the human to approve.

### Never do these
- `git push origin dev` or `git push origin main`
- `gh pr merge` without explicit human instruction
- Force push to any branch
- Bypass CI with `--no-verify`

### Releases (main → Docker)
Only the human merges `dev` → `main`. Docker deploys are triggered by git tags (`v*`) applied to `main` by the human.

## Rule: tests for every change

For every feature or bug fix, check whether a unit or E2E test already covers the changed behaviour.

- If no test exists, add one as part of the same PR — do not open a separate PR for tests.
- Unit tests live in `src/__tests__/` and use Vitest.
- E2E tests live in `tests/e2e/` and use Playwright.
- Prefer unit tests for logic/API behaviour; prefer E2E tests only for UI interactions that can't be covered at the unit level.
- If an existing test already covers the behaviour, no new test is needed — but do not remove or weaken existing tests.