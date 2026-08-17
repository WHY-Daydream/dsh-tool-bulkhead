# Upstream issue draft: `@deepseek-ai/dsh-session@0.0.1-rc.1` declares an unpublished peer dependency

> Draft for a DeepSeek Harness GitHub issue. Filed separately from the
> Show Your Plugins post — this is an upstream packaging bug, not a feature
> request.

## Summary

`@deepseek-ai/dsh-session@0.0.1-rc.1` (and `dsh-agent`, `dsh-typert-registry`)
declare `peerDependencies["@deepseek-ai/dsh-type-meta"]`, but
`@deepseek-ai/dsh-type-meta` is **not published to the npm registry** at any
version.

## Impact

Any consumer whose package manager auto-installs peers (pnpm ≥ 8 default,
npm ≥ 7 default) fails to resolve the dependency tree when installing
anything that transitively pulls `dsh-session`:

```text
$ pnpm add @deepseek-ai/dsh-session@0.0.1-rc.1
→ tries to resolve peer @deepseek-ai/dsh-type-meta
→ 404 from registry
→ install fails / retries against the wrong registry
```

Verified 2026-08-17:

- `npm view @deepseek-ai/dsh-type-meta` → not found on registry.npmjs.org
- npmmirror on-demand sync of the package returns:
  `{"error":"Package not exists, response data: {\"error\":\"Not found\"}"}`

## Minimal repro

```sh
mkdir /tmp/repro && cd /tmp/repro && npm init -y
npm install @deepseek-ai/dsh-session@0.0.1-rc.1
# fails resolving peer @deepseek-ai/dsh-type-meta
```

## Expected

Either publish `@deepseek-ai/dsh-type-meta` (matching the declared `^0.0.1-rc.1`
range), or drop the peer from the published manifests of `dsh-session` /
`dsh-agent` / `dsh-typert-registry`.

## Workaround used by consumers today

`auto-install-peers=false` in the consuming project's `.npmrc` plus explicit
devDependencies for the packages actually imported at runtime
(`dsh-scope`, `dsh-session`, `dsh-timeout`).
