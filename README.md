# pi-arxiv

One Pi extension for arXiv discovery, exact lookup, and full-paper Markdown fetching.

## Tools

- `arxiv_search` — search arXiv by query/category with sorting and pagination.
- `arxiv_paper` — exact metadata lookup by arXiv ID or URL.
- `arxiv_fetch2md` — fetch a paper body as Markdown via [arxiv2md](https://arxiv2md.org/) and save it locally.

`arxiv_fetch2md` uses arxiv2md instead of PDF scraping. arxiv2md parses arXiv's structured HTML when available, which generally preserves sections and math better than PDF extraction.

## Library folder setup

Fetched Markdown papers are saved to a local library folder.

On first fetch, if no folder is configured, the extension searches for likely paper/library folders such as `~/Documents/Papers`, `~/Papers`, `~/Research`, `~/Documents/Arxiv`, and Obsidian vaults. In interactive Pi it asks which one to use, offers a recommended `~/Documents/Arxiv` folder when none exists, and saves the choice in:

```text
~/.pi/agent/pi-arxiv/config.json
```

You can reconfigure any time:

```text
/arxiv-library
```

For non-interactive runs, set:

```bash
export PI_ARXIV_LIBRARY="$HOME/Documents/Arxiv"
```

or let the extension create/use `~/Documents/Arxiv`.

## Install

After publishing:

```bash
pi install npm:@wienerberliner/pi-arxiv
```

## Install while developing

From this package directory:

```bash
npm install
pi -e .
```

Or add this local package to project/user Pi settings.

## Notes

- arXiv API calls are throttled with a 3 second delay between requests, following arXiv's guidance for repeated API calls.
- `arxiv_fetch2md` depends on arxiv2md's public API and its rate limits.
- PDF-only arXiv papers may not have structured HTML; in that case arxiv2md may fail and a dedicated PDF extraction fallback would be needed.
