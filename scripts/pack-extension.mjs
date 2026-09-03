/**
 * Builds the Chrome Web Store upload, because a one-click "Add to Chrome" button is
 * a STORE LISTING, not a feature of the extension.
 *
 * ⚠️ CHROME REMOVED IN-APP INSTALLS IN 2018. There is no API that lets Radiant
 * install an extension from inside itself — inline installation was killed because
 * it was used to trick people into sideloading. What Claude and ChatGPT have is a
 * Web Store page: their button opens it, and the person clicks "Add to Chrome"
 * there. That is the whole difference, and it costs a $5 one-time developer
 * registration plus a review.
 *
 * Until that listing exists, "Load unpacked" is the only route, and it is four
 * steps because Chrome 137 removed the flag that used to make it one.
 */
import { createWriteStream, readFileSync, readdirSync, statSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'))

// The store rejects an upload whose version has already been used, exactly like
// App Store Connect. Keep it in step with the app so there is one number to reason
// about.
if (manifest.version !== pkg.version) {
  manifest.version = pkg.version
  const out = JSON.stringify(manifest, null, 2) + '\n'
  execFileSync('/bin/sh', ['-c', `cat > extension/manifest.json`], { input: out })
  console.log(`  manifest version → ${pkg.version}`)
}

// ⚠️ ONLY WHAT THE EXTENSION RUNS. STORE.md is the listing copy for a human and
// has no business inside the uploaded package — the store flags files it cannot
// account for, and shipping notes-to-self to every user is sloppy besides.
const files = readdirSync('extension').filter(f => !f.startsWith('.') && !f.endsWith('.md'))
const zip = `release/radiant-extension-${pkg.version}.zip`
execFileSync('/bin/sh', ['-c', `mkdir -p release && rm -f ${zip} && cd extension && zip -q -r ../${zip} ${files.join(' ')}`])
const kb = Math.round(statSync(zip).size / 1024)
console.log(`  ${zip} — ${kb} KB, ${files.length} files`)
console.log(`
  To turn the four steps into one button:
    1. chrome.google.com/webstore/devconsole — one-time $5 registration (Tony only)
    2. New item → upload ${zip}
    3. Listing: the copy is in extension/STORE.md
    4. Submit. Review is usually a day or two; <all_urls> draws a closer look,
       which is why STORE.md explains that it talks only to 127.0.0.1.
    5. Put the published URL in ChromeAttachBlock and the panel becomes one link.
`)
