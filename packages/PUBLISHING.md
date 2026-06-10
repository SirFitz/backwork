# Publishing the backwork SDKs

Both names are available and reserved by intent:
- **npm:** `@sirfitz/backwork` (Node + Bun)
- **Hex:** `backwork` (Elixir)

> These steps need credentials this repo doesn't carry. Run them from a machine
> logged in as **sirfitz** on each registry.

## npm — `@sirfitz/backwork`

```bash
cd packages/node
npm whoami                      # should print: sirfitz  (else: npm login)
npm publish --access public     # publishConfig.access=public is already set
npm view @sirfitz/backwork version   # verify
```

If `npm whoami` 401s, the `~/.npmrc` token is stale — `npm login` to refresh.

## Hex — `backwork`

Requires the Elixir toolchain (`elixir`, `mix`) — not present on the build Mac, so
run this where Elixir is installed:

```bash
cd packages/elixir
mix deps.get
mix hex.user auth               # or set HEX_API_KEY
mix hex.publish                 # builds docs + publishes; confirm the prompts
```
Verify at https://hex.pm/packages/backwork.

## After both are live

The dashboard `/docs` page should switch its primary instructions to the one-liner:

```
npm i @sirfitz/backwork
node --import @sirfitz/backwork/register server.js     # Node
bun  --preload @sirfitz/backwork/start  run server.ts  # Bun

{:backwork, "~> 0.1"}                                   # Elixir
```

(Ping Claude to flip the docs once published — held until then to avoid a broken
`npm i` window.)
