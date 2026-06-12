# backwork QA tooling

Checks that don't belong in the app. Kept in `qa/` (its own `package.json`) so it
stays **out of the dashboard's Docker build context** (`build: ./dashboard`) and never
ships in the production image.

## overflow-check

Deterministic horizontal-overflow guard. Loads every authed dashboard page with
deliberately-wide data (long routes, log lines, URLs, tokens) at desktop / laptop /
tablet / mobile widths and asserts the document never scrolls sideways
(`scrollWidth <= clientWidth`). On failure it names the offending element so the layer
that blew out is obvious.

It exists because the original audit signed off the UI by eye + screenshots, which
**mask** horizontal overflow — it scrolls off-frame, so a viewport capture looks clean.
This measures it instead. Run it before shipping any dashboard layout change.

```bash
cd qa
npm run setup                      # install deps + chromium (one time)
BW_BASE_URL=https://backwork.dev npm run overflow
```

Auth (pick one):

- **Existing account** — `BW_EMAIL=you@example.com BW_PASSWORD=… npm run overflow`
- **Self-register** — omit creds; it creates an isolated throwaway org
  (`qa2del-overflow-*@example.com`), seeds wide errors/logs/traces, and prints the
  email so you can delete it afterward. Prefer running against a staging instance, or
  clean up the throwaway (it's labeled `qa2del-*`).

`HEADED=1` to watch it run. Exit code is non-zero if any page overflows (CI-friendly).
