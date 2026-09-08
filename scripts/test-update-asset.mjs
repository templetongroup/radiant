/**
 * Does the update check point at a file this machine can actually open?
 *
 * ⚠️ THE MATCH USED TO BE /\.dmg$/ AND NOTHING ELSE, so anywhere but a Mac it
 * found no asset and silently handed back the releases page — a wall of files
 * to choose from, when the entire point of the check is that Radiant already
 * knows which one is wanted. It degraded quietly enough that nothing ever said
 * so out loud.
 *
 * The macOS answer must not move: it picks the versioned dmg, exactly the asset
 * the old regex found, out of a real release that also contains a zip, two
 * blockmaps, latest-mac.yml and the stable radiant.dmg.
 */
import { assetFor } from '../server/updater.js'

let pass = 0, fail = 0
const results = []
const ok = (what, cond) => { cond ? pass++ : fail++; results.push(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`) }

// The asset list of a real release (v0.7.8), in the order GitHub returns it.
const macRelease = [
  { name: 'latest-mac.yml' },
  { name: 'Radiant-0.7.8-arm64-mac.zip' },
  { name: 'Radiant-0.7.8-arm64-mac.zip.blockmap' },
  { name: 'Radiant-0.7.8-arm64.dmg' },
  { name: 'Radiant-0.7.8-arm64.dmg.blockmap' },
  { name: 'radiant.dmg' }
]

// The same release once a Linux artefact is published alongside it.
const withLinux = [...macRelease, { name: 'latest-linux.yml' }, { name: 'Radiant-0.7.8.AppImage' }]

ok('a Mac still gets the versioned dmg', assetFor(macRelease, 'darwin')?.name === 'Radiant-0.7.8-arm64.dmg')
ok('a blockmap is never offered as the download', !/blockmap/.test(assetFor(macRelease, 'darwin')?.name || ''))
ok('latest-mac.yml is never offered as the download', !/\.yml$/.test(assetFor(macRelease, 'darwin')?.name || ''))

ok('Linux gets nothing while no Linux asset is published', assetFor(macRelease, 'linux') === null)
ok('Linux gets the AppImage once one is', assetFor(withLinux, 'linux')?.name === 'Radiant-0.7.8.AppImage')
ok('latest-linux.yml is never offered as the download', !/\.yml$/.test(assetFor(withLinux, 'linux')?.name || ''))
ok('publishing a Linux asset does not change the Mac answer', assetFor(withLinux, 'darwin')?.name === 'Radiant-0.7.8-arm64.dmg')

ok('a platform we ship nothing for asks for nothing', assetFor(withLinux, 'freebsd') === null)
ok('an empty release is not a crash', assetFor([], 'darwin') === null)
ok('a missing asset list is not a crash', assetFor(undefined, 'darwin') === null)
ok('an asset with no name is not a crash', assetFor([{}], 'darwin') === null)

console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  the update points at a file this machine can open`)
process.exit(fail ? 1 : 0)
