#!/usr/bin/env node
// Publish a release and prove the public download works before saying it shipped.
//
// ⚠️ THE WEBSITE'S DOWNLOAD BUTTON POINTS AT A FIXED FILENAME.
// templetongroup.dev links to /releases/latest/download/radiant.dmg — a stable
// name, not the versioned one electron-builder produces. Uploading only
// Radiant-<version>-arm64.dmg leaves that button returning 404, which is what
// every release on 2026-08-26 did until Tony clicked it on a Mac with no copy
// of Radiant left: "your sloppiness is now unacceptable."
//
// So: upload the stable name too, then actually fetch the public URL. Note that
// HEAD returns 404 on GitHub's asset CDN even for a healthy asset — the check
// has to be a GET.
import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync, statSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version
const tag = `v${version}`
const rel = new URL('../release/', import.meta.url).pathname
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })

const versioned = `Radiant-${version}-arm64.dmg`
const stable = path.join(tmpdir(), 'radiant.dmg')

// ⚠️ BUILD HERE, OR SHIP THE LAST BUILD BY ACCIDENT. This script used to assume
// someone had already run `npm run dist`. On 2026-08-27 they had not: every gate
// below went green — including the smoke test, which booted the PREVIOUS
// binary — and a release went out containing none of the changes it was named
// for. A gate that passes against a stale artefact is worse than no gate.
console.log('[release] building the app')
execFileSync('npm', ['run', 'dist'], { stdio: 'inherit' })
copyFileSync(path.join(rel, versioned), stable)

const assets = [
  path.join(rel, versioned),
  path.join(rel, `${versioned}.blockmap`),
  path.join(rel, `Radiant-${version}-arm64-mac.zip`),
  path.join(rel, `Radiant-${version}-arm64-mac.zip.blockmap`),
  path.join(rel, 'latest-mac.yml'),
  stable
]

// ⚠️ NOTHING SHIPS ON SOMEBODY'S OPINION THAT IT WORKS. Around twenty releases
// went out on 2026-08-26, many of them fixing a regression in the one before,
// and each had been "verified" by looking at something adjacent to the part
// that broke. These two gates run every time and a failure stops the release.
// ⚠️ THE DEPENDENCY CHECKS RUN FIRST, BEFORE ANYTHING IS BUILT. Radiant is
// signed with Tony's Developer ID and runs shell commands; a compromised
// dependency executes on his Mac with his permissions inside an app macOS has
// been told to trust. Finding that out after notarising is too late.
console.log('[release] supply chain')
execFileSync('node', ['scripts/test-supply-chain.mjs'], { stdio: 'inherit' })
console.log('[release] npm audit (runtime deps)')
try {
  execFileSync('npm', ['audit', '--omit=dev'], { stdio: 'inherit' })
} catch {
  console.error('\n[release] npm audit reported vulnerabilities in runtime dependencies. Fix or accept them deliberately before shipping.')
  process.exit(1)
}
try {
  execFileSync('npm', ['audit', 'signatures', '--omit=dev'], { stdio: 'inherit' })
} catch {
  console.error('\n[release] npm could not verify registry signatures for the runtime dependencies.')
  process.exit(1)
}
console.log('[release] theme contrast')
execFileSync('node', ['scripts/test-contrast.mjs'], { stdio: 'inherit' })
// ⚠️ THE PHONE'S MODEL LIST IS SHIPPED SIZES. If a repo moved or a size changed,
// the picker offers a download that fails or a fit badge that lies.
console.log('[release] phone catalogue vs Hugging Face')
execFileSync('node', ['scripts/test-catalog-live.mjs'], { stdio: 'inherit' })
console.log('[release] end-to-end API checks')
execFileSync('node', ['scripts/test-api.mjs'], { stdio: 'inherit' })
console.log('[release] smoke testing the built app')
execFileSync('node', ['scripts/test-smoke.mjs'], { stdio: 'inherit' })

const notes = process.argv[2] || `Radiant ${version}`
try {
  sh('gh', ['release', 'create', tag, ...assets, '--title', tag, '--notes', notes])
} catch {
  console.log('[release] release exists — uploading assets')
  sh('gh', ['release', 'upload', tag, ...assets, '--clobber'])
}

// The check that matters: can a stranger with no credentials download it?
const url = 'https://github.com/templetongroup/radiant/releases/latest/download/radiant.dmg'
let ok = false
for (let i = 0; i < 6 && !ok; i++) {
  const res = await fetch(url, { headers: { range: 'bytes=0-99' } })
  ok = res.status === 200 || res.status === 206
  if (!ok) await new Promise(r => setTimeout(r, 5000))
}
if (!ok) {
  console.error(`\n✗ ${tag} published but ${url} does not download. The website's button is broken.`)
  process.exit(1)
}
console.log(`\n✓ ${tag} published and the public download works`)

// ⚠️ THE DOWNLOAD PAGE SHOWS A VERSION, AND IT WAS FOUR RELEASES BEHIND. The
// button always worked — it points at /releases/latest/download/radiant.dmg —
// but the page read "Version 0.6.162 · 156 MB" while serving 0.6.166, and set
// the save-as filename to Radiant-0.6.162.dmg. A page that misreports what it
// is handing you is its own kind of broken, and nothing updated it because
// version.json was maintained by hand. Same shape as the version bump this
// script did not do either.
const site = path.join(path.dirname(rel.replace(/\/$/, '')), '..', 'templeton-group-dev-website')
const vfile = path.join(site, 'showcase', 'radiant', 'version.json')
const sizeMB = `${Math.round(statSync(path.join(rel, versioned)).size / 1048576)} MB`
if (!existsSync(vfile)) {
  console.error(`\n✗ ${tag} is live, but the website repo is not at ${site}, so its version label still says the old one. Clone it beside radiant and re-run, or edit showcase/radiant/version.json by hand.`)
  process.exit(1)
}
const current = JSON.parse(readFileSync(vfile, 'utf8'))
if (current.version === version && current.size === sizeMB) {
  console.log(`✓ the download page already says ${version} · ${sizeMB}`)
} else {
  writeFileSync(vfile, JSON.stringify({ version, size: sizeMB }, null, 2) + '\n')
  try {
    // Only this file — the site repo may have other work in progress.
    execFileSync('git', ['-C', site, 'commit', '-m', `Radiant ${version}`, '--', 'showcase/radiant/version.json'], { stdio: 'inherit' })
    execFileSync('git', ['-C', site, 'push', '-q'], { stdio: 'inherit' })
    console.log(`✓ download page updated to ${version} · ${sizeMB} (deploys in about a minute)`)
  } catch (e) {
    console.error(`\n✗ ${tag} is live, but the download page still says ${current.version}. version.json was written; commit and push the website repo.`)
    process.exit(1)
  }
}
