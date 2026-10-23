# @cca/dsh-web

Vendored DeepSeek Harness Web shell and CCA client UI plugins.

- `src/main.ts` boots the official `@deepseek-ai/dsh-client-web` entry. The page
  is served by CCA at `/dsh/`, which injects the per-user host's
  `window.__DSH_BOOT__`, plugin preloads, and theme bootstrap.
- `plugins/sidebar` is the vendored DSH sidebar source (same package name as
  the stock row so inject edges keep resolving) plus CCA's settings/logout
  footer actions.
- `plugins/brand` fills the sidebar brand slots with the CCA logo and name.
- `scripts/build-plugins.mjs` compiles each plugin to the DSH dynamic bundle
  format (`window.__ModuleLoader__.load({ id, factory })`) with esbuild and
  lightningcss. CSS Modules get the same `[hash]_[local]` class names DSH uses.

```bash
npm run build:plugins -w @cca/dsh-web   # plugins/*/lib
npm run build -w @cca/dsh-web           # plugins + dist
npm run typecheck -w @cca/dsh-web       # src + plugin sources
```

The built `dist/` and `plugins/*/lib/` are ignored; the root `npm run build`
and both Dockerfiles generate them. If they are absent, CCA falls back to the
DSH host's stock frontend/sidebar.
