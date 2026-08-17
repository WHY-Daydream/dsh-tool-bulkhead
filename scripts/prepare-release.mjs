#!/usr/bin/env node
/**
 * prepare-release.mjs — build a publish-ready tarball WITHOUT touching the
 * working tree or leaking local `link:` devDependencies into the published
 * manifest.
 *
 * Why: the repo's devDependencies use `link:../deepseek-harness/...` for
 * local development. A published manifest must never carry machine-local
 * `link:` specs (a stranger's `npm install` would choke on them), so this
 * script stages a cleaned package.json — every `link:` devDependency is
 * replaced by the exact published version that passed out-of-tree validation
 * (2026-08-17, npmmirror) — then packs from a temp dir.
 *
 * Usage:
 *   node scripts/prepare-release.mjs            # build + pack, prints tarball
 *   node scripts/prepare-release.mjs --no-pack  # print the staging manifest only
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '..')
const noPack = process.argv.includes('--no-pack')

/** Published replacements for every local `link:` devDependency. */
const LINK_REPLACEMENTS = {
  '@deepseek-ai/cordis': '^4.0.1',
  '@deepseek-ai/dsh-invariants': '0.0.1-rc.1',
  '@deepseek-ai/dsh-llm': '0.0.1-rc.1',
  '@deepseek-ai/dsh-scope': '0.0.1-rc.1',
  '@deepseek-ai/dsh-session': '0.0.1-rc.1',
  '@deepseek-ai/dsh-system-prompt': '0.0.1-rc.1',
  '@deepseek-ai/dsh-timeout': '0.0.1-rc.1',
  '@deepseek-ai/dsh-tools': '0.0.1-rc.1',
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** Staging manifest: swap every `link:` devDep for its published version. */
const staging = structuredClone(pkg)
staging.devDependencies = Object.fromEntries(
  Object.entries(pkg.devDependencies ?? {}).map(([name, spec]) => {
    const replacement = typeof spec === 'string' && spec.startsWith('link:') ? LINK_REPLACEMENTS[name] : undefined
    return [name, replacement ?? spec]
  }),
)

const leaked = Object.entries(staging.devDependencies ?? {}).filter(([, spec]) => String(spec).startsWith('link:'))
if (leaked.length > 0) {
  console.error(`prepare-release: unresolved link: devDependencies — ${leaked.map(([n]) => n).join(', ')}`)
  console.error('add their published versions to LINK_REPLACEMENTS in this script')
  process.exit(1)
}

if (noPack) {
  process.stdout.write(`${JSON.stringify(staging, null, 2)}\n`)
  process.exit(0)
}

const stagingDir = mkdtempSync(join(tmpdir(), 'bulkhead-release-'))
try {
  // Copy the publish surface: `files` globs are relative to the package root,
  // plus the always-included README/LICENSE that npm pack adds by convention.
  const copyTargets = [
    ...(pkg.files ?? []).filter((entry) => !entry.includes('*')), // literal dirs/files
    'README.md',
    'LICENSE',
  ]
  for (const target of copyTargets) {
    cpSync(join(ROOT, target), join(stagingDir, target), { recursive: true })
  }
  // Copy the glob-expanded `lib/**/*.d.ts` and `lib/*.js` surface wholesale.
  if (pkg.files?.some((entry) => entry.includes('*'))) {
    cpSync(join(ROOT, 'lib'), join(stagingDir, 'lib'), { recursive: true })
  }
  writeFileSync(join(stagingDir, 'package.json'), `${JSON.stringify(staging, null, 2)}\n`)

  const packOutput = execFileSync('npm', ['pack', '--json'], {
    cwd: stagingDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const report = JSON.parse(packOutput)
  const tarball = report[0]?.filename
  if (!tarball) {
    console.error('prepare-release: npm pack produced no tarball')
    process.exit(1)
  }
  const destination = join(ROOT, tarball)
  cpSync(join(stagingDir, tarball), destination)
  process.stdout.write(`${JSON.stringify({
    tarball: destination,
    files: report[0]?.files?.length ?? 0,
    unpackedSize: report[0]?.unpackedSize ?? 0,
    leakedLinkDevDeps: 0,
  }, null, 2)}\n`)
} finally {
  rmSync(stagingDir, { recursive: true, force: true })
}
