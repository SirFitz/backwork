# @backwork/node

One-line OpenTelemetry tracing for [backwork.dev](https://backwork.dev). Works with **Node** and **Bun** — it wires OpenTelemetry auto-instrumentation to your backwork project with sane defaults, so you don't touch raw OTel config.

> Logs and host/container metrics come from the backwork agent (`curl … install.sh`) with no code changes. This package is only for **distributed traces / APM** from inside your app.

## Install

```bash
npm i @backwork/node      # or:  pnpm add / yarn add
bun add @backwork/node    # Bun
```

## Use

1. In backwork, create a **Project** and copy its ingest token.
2. Set it as `BACKWORK_TOKEN`, then load the preload for your runtime:

**Node** — preload with `--import` (fullest coverage):
```bash
BACKWORK_TOKEN=bw_… BACKWORK_SERVICE=my-api \
  node --import @backwork/node/register server.js
```
…or make it the very first import in your entry file:
```js
import "@backwork/node/register";
```
…or, if your start command is fixed, use the env var:
```bash
NODE_OPTIONS="--import @backwork/node/register"
```

**Bun** — preload with `--preload`:
```bash
BACKWORK_TOKEN=bw_… BACKWORK_SERVICE=my-api \
  bun --preload @backwork/node/start run server.ts
```

**Programmatic** (if you'd rather call it yourself):
```js
import { start } from "@backwork/node";
await start({ service: "my-api" }); // before you import instrumented libs
```

## Configuration

| Env | Default | Notes |
|-----|---------|-------|
| `BACKWORK_TOKEN` | — | **required** — your project's ingest token |
| `BACKWORK_SERVICE` | package name | how the service appears in backwork |
| `BACKWORK_ENDPOINT` | `https://backwork.dev/otlp` | self-hosted? point at your own host |

Standard `OTEL_*` variables still work and take precedence if you set them. Without a token, the package no-ops with a warning (it won't crash your app).

Within ~30s of the first request your service shows up under **Traces**, **Requests**, and **Metrics → Application performance**.
