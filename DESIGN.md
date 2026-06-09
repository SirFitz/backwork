# backwork.dev — Design System

## Theme decision (the scene)

"An inkress developer, mid-workday in a well-lit office, glancing at ~80
production containers on a 1440p monitor to confirm nothing's broken, and
occasionally on-call at night triaging an incident."

The dominant moment is a daytime glance in bright ambient light → **light is the
default**. Night on-call is real but secondary → **dark is a first-class toggle**
(remix-themes, cookie-persisted, respects `prefers-color-scheme` only on first
visit). Default when no preference and no system signal: light.

## Color (OKLCH, never #000/#fff)

Strategy: **Restrained** — warm-neutral (stone) surfaces + coral brand accent
used ≤10%. Status triad is separate and sacred.

### Light (default)
- `--bg`            oklch(0.99 0.004 60)    near-white, warm
- `--surface`       oklch(0.985 0.004 60)   panels/tables
- `--surface-2`     oklch(0.965 0.005 60)   hover, headers
- `--border`        oklch(0.9 0.006 60)
- `--border-strong` oklch(0.84 0.008 60)
- `--fg`            oklch(0.26 0.01 60)     primary text (not black)
- `--muted`         oklch(0.52 0.01 60)     secondary text
- `--faint`         oklch(0.66 0.008 60)    tertiary / axis

### Dark (toggle)
- `--bg`            oklch(0.19 0.008 265)   warm-cool near-black, never #000
- `--surface`       oklch(0.22 0.009 265)
- `--surface-2`     oklch(0.26 0.01 265)
- `--border`        oklch(0.3 0.012 265)
- `--border-strong` oklch(0.38 0.014 265)
- `--fg`            oklch(0.93 0.008 265)
- `--muted`         oklch(0.7 0.01 265)
- `--faint`         oklch(0.55 0.01 265)

### Brand (identity only, never status)
- `--brand`        oklch(0.66 0.17 16)      coral
- `--brand-fg`     white-on-coral text
- `--ring`         brand at lower chroma for focus

### Status (sacred triad + info)
- `--ok`     oklch(0.62 0.15 150)  green   operational
- `--warn`   oklch(0.74 0.14 75)   amber   degraded
- `--err`    oklch(0.58 0.20 25)   red     down / error  (distinct from coral: redder hue, higher chroma)
- `--info`   oklch(0.60 0.12 240)  blue    informational only (links handled by brand)
- chart series palette: coral, blue, green, amber, violet, teal, orange — assigned by service, stable.

## Typography

- UI sans: Inter (variable) with system fallback. Mono: "JetBrains Mono" /
  ui-monospace for all telemetry values, log lines, IDs, query strings.
- Scale (1.25 ratio): 12 / 13 / 15 / 18 / 22 / 28. Body 13–15. Numbers tabular.
- Hierarchy by weight: 600 for headings/key numbers, 500 for labels, 400 body.
- Log/metric values are always mono + tabular-nums with units.

## Layout & rhythm

- App shell: fixed left rail (220px) nav + top bar (theme toggle, live status,
  time range). Content max ~1400px, generous gutters.
- NOT a grid of identical cards. Use a primary focal region (what's broken) +
  supporting tables and inline sparklines. Vary section spacing (24/16/12).
- Tables are the primary affordance for container/health/log data. Row hover,
  zebra off, 1px full borders only (NEVER side-stripe borders).
- Sparklines inline in table rows; full charts only where trend matters.
- Whitespace separates sections; avoid wrapping everything in a box. No nested
  cards.

## Components (shadcn, CSS-var theme)

Button, Badge (status variants), Card (used sparingly), Table, Input, Select,
Tabs, Tooltip, Switch (theme + alert enable), Skeleton (loading), plus a
StatusDot and Sparkline. All driven by the CSS vars above so the theme toggle is
a class swap.

## States (required on every data surface)

- Loading: skeleton rows/shimmer, never layout shift.
- Empty: plain sentence + the reason (e.g. "No traces. Apps must emit OTLP spans
  with correlation IDs.").
- Error: inline note "data source unavailable — <reason>", panel degrades alone.

## Motion

Subtle, ease-out only (no bounce). Live updates fade/diff, never re-flash the
whole table. Don't animate layout properties.

## Bans (enforced)

No side-stripe accent borders. No gradient text. No glassmorphism by default. No
hero-metric template. No identical card grids. No em dashes in copy.
