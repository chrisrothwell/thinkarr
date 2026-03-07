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

The collection name for this project is "thinkarr".  Example command: qmd get todo.md -c thinkarr