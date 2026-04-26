# PolyLingo Translate — GitHub Action

Official GitHub Action for [PolyLingo](https://usepolylingo.com): translate **flat JSON** locale files (next-intl, i18next-style bundles) and **Markdown** documentation in CI using the [`polylingo`](https://www.npmjs.com/package/polylingo) Node.js SDK.

**Highlights**

- **Delta mode** — when enabled (default), only changed top-level namespaces are re-translated vs a committed baseline file, saving tokens on routine edits.
- **Docs** — optional Markdown pass via the async jobs API (large files, no HTTP timeout issues).
- **Outputs** — `locales_translated`, `files_changed`, `tokens_used` for downstream steps.

## Usage

Store your API key as a secret (e.g. `POLYLINGO_API_KEY`), then:

```yaml
name: i18n
on:
  push:
    branches: [main]
    paths:
      - 'frontend/messages/en.json'
      - 'docs/**/*.md'

permissions:
  contents: write

jobs:
  translate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: UsePolyLingo/translate-action@v1
        with:
          api_key: ${{ secrets.POLYLINGO_API_KEY }}
          locale_concurrency: 3
          delta: true
          with_docs: true
          commit: true
          commit_message: 'chore(i18n): sync translations'
          commit_add_paths: frontend/messages docs
```

See [`examples/`](examples/) for more workflows (messages-only, docs-only, Next.js paths).

## Inputs

| Input | Description |
| --- | --- |
| `api_key` | **Required.** PolyLingo API key. |
| `api_url` | Optional. Default `https://api.usepolylingo.com/v1`. |
| `messages_dir` | Default `frontend/messages`. |
| `source_file` | Optional. Path to English JSON relative to repo root; default `<messages_dir>/en.json`. |
| `locales` | Optional. Comma-separated codes; default is PolyLingo’s built-in marketing set (29 locales). |
| `locale_concurrency` | Default `3`. |
| `delta` | Default `true`. Set `false` for a full refresh (also refreshes the baseline snapshot). |
| `with_messages` | Default `true`. Set `false` for Markdown-only runs. |
| `with_docs` | Default `true`. Set `false` to skip Markdown translation. |
| `docs_dir` | Default `docs`. |
| `docs_source_files` | Optional. Comma-separated filenames or `*.md` for all `.md` in `docs_dir`. |
| `commit` | Default `false`. Commit and push using `github.token`. |
| `commit_message` | Default `chore(i18n): sync translations`. |
| `commit_add_paths` | Arguments to `git add`. Default `frontend/messages docs`. |

## Repository layout

The action assumes English JSON at `messages_dir/en.json` and (optionally) English Markdown at `docs_dir`. Adjust `messages_dir`, `source_file`, and `docs_dir` to match your repo.

You can also commit a **`.polylingo.json`** at the repository root; see the [PolyLingo monorepo roadmap](https://github.com/UsePolyLingo/PolyLingo/blob/main/.github/ACTION_ROADMAP.md) for the evolving schema (paths, locales, API URL).

## Local dry run

From this repository:

```bash
POLYLINGO_ROOT=/path/to/your/repo POLYLINGO_DRY_RUN=1 POLYLINGO_LOCALES=es,fr node src/run-all.mjs
```

## License

MIT — see [LICENSE](LICENSE).
