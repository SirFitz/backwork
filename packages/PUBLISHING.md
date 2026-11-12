# Publishing

The span SDKs `@sirfitz/backwork` (Node and Bun) and `backwork` (Elixir) are
retired (BAC-49): backwork no longer stores spans, and services reach it through
Correlator hop records and the agent. Their READMEs in `packages/node` and
`packages/elixir` say so. Only the CLI below is publishable.

## npm — `@sirfitz/backwork-cli` (the `bw` read-API CLI)

```bash
cd packages/cli
npm whoami                      # should print: sirfitz  (else: npm login)
npm publish --access public     # publishConfig.access=public is already set
npm view @sirfitz/backwork-cli version
npx @sirfitz/backwork-cli version    # smoke
```

Zero runtime deps; nothing to build. Wraps the public read API
(`GET /api/v1/me|errors|services`, bearer `bwk_` key). If `npm whoami`
401s, the `~/.npmrc` token is stale — `npm login` to refresh, then publish.
