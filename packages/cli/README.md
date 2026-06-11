# @sirfitz/backwork-cli

Command-line client for the [backwork.dev](https://backwork.dev) observability read
API — pull your org's **errors**, **incidents**, and **service health** straight into
your terminal or scripts.

```bash
npm i -g @sirfitz/backwork-cli
# or run without installing:
npx @sirfitz/backwork-cli errors
```

## Authentication

Create a read-only API key in the dashboard (org dropdown → **API keys**), then:

```bash
export BACKWORK_API_KEY=bwk_xxxxxxxx
bw me            # → ✓ key valid — org Acme (acme)
```

Keys are org-scoped: the CLI only ever sees your own organization's data.

## Commands

```
bw me                      Verify the key and show its organization
bw errors                  List error groups          (--status, --service, --limit)
bw incidents               List current incidents
bw services                Per-service health
bw help | bw version
```

### Options

| Flag | Description |
|------|-------------|
| `--status <s>` | `errors`: `open` (default) · `resolved` · `ignored` · `all` |
| `--service <name>` | `errors`: filter to one service |
| `--limit <n>` | `errors`: max groups (default 100) |
| `--json` | Raw JSON output — pipe to `jq` |
| `--key <bwk_…>` | API key (overrides `BACKWORK_API_KEY`) |
| `--url <url>` | API base URL (overrides `BACKWORK_API_URL`; default `https://backwork.dev`) |
| `--no-color` | Disable ANSI colors |

## Examples

```bash
bw errors --status open --limit 20
bw errors --service checkout-api
bw errors --json | jq '.errors[] | {type, count, message}'
bw incidents
bw services
```

Self-hosting backwork on your own domain? Point the CLI at it:

```bash
export BACKWORK_API_URL=https://backwork.example.com
```

## API

The CLI is a thin wrapper over the public read API (bearer-authed, JSON, org-scoped):

```
GET /api/v1/me
GET /api/v1/errors?status=&service=&limit=
GET /api/v1/incidents
GET /api/v1/services
```

MIT © SirFitz
