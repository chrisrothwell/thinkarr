# Thinkarr

Details of the build are in PLAN.MD - refer to this for details of file structure and what has been built.

## Rule: always use qmd before reading files

Before reading files or exploring directories, always use qmd to search for information in local projects.

Available tools:

- `qmd search “query”` — fast keyword search (BM25)

- `qmd query “query”` — hybrid search with reranking (best quality)

- `qmd vsearch “query”` — semantic vector search

- `qmd get <file>` — retrieve a specific document

Use qmd search for quick lookups and qmd query for complex questions.

Use Read/Glob only if qmd doesn’t return enough results.