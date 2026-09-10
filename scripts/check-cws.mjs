#!/usr/bin/env node
/**
 * Is the Chrome extension published yet?
 *
 * ⚠️ THERE IS NO UNAUTHENTICATED WAY TO ASK THIS. The Web Store is entirely
 * client-rendered: chromewebstore.google.com returns the same generic shell,
 * the same <title>, and HTTP 200 for a published extension, for an unpublished
 * draft, and for an item id that does not exist at all. That was measured, not
 * assumed — uBlock Origin, this item, and thirty-two random characters were
 * indistinguishable. So scraping cannot work, and neither can Claude's browser
 * tools: Chrome forbids every extension from scripting chrome.google.com, which
 * includes the developer dashboard.
 *
 * The only real check is the Chrome Web Store API, which needs OAuth
 * credentials. Set these and this script answers for itself:
 *
 *   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN
 *
 * Getting them, once, in Google Cloud Console:
 *   1. Create (or pick) a project, enable the "Chrome Web Store API"
 *   2. OAuth consent screen -> External -> add yourself as a test user
 *   3. Credentials -> Create OAuth client ID -> Desktop app
 *   4. Authorise scope https://www.googleapis.com/auth/chromewebstore.readonly
 *      and exchange the code for a refresh token
 *
 * Until then this exits 2 and says what it needs, rather than guessing.
 */

// ⚠️ THIS WAS 31 CHARACTERS FOR WEEKS AND NOBODY COULD TELL. A Chrome extension
// id is exactly 32 letters a–p; the one here had lost a character somewhere
// between the dashboard and this file, so every check against it answered
// "unknown application" — which is the same thing an unpublished item says.
// Checked against the live store on 2026-09-10: this id downloads a CRX whose
// manifest is Radiant Browser Bridge 0.6.231, byte-for-byte what extension/
// holds.
const ITEM = process.env.CWS_ITEM_ID || 'jhljglakgocklinpblgcoppljflnacfk'
if (!/^[a-p]{32}$/.test(ITEM)) {
  console.log(`  "${ITEM}" is not a Chrome extension id (need 32 letters a-p, got ${ITEM.length}).`)
  process.exit(2)
}
const { CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN } = process.env

// ⚠️ THERE IS AN UNAUTHENTICATED ANSWER AFTER ALL, and the header above was
// wrong to say otherwise. The store PAGE cannot be scraped — but Chrome's own
// update service answers for any published item, and only for a published one:
//   status="ok"                  published
//   status="error-unknownApplication"  unpublished, or an id that does not exist
// It is what every installed copy of Chrome asks every few hours, so it cannot
// lag the way search indexing does.
const upd = await fetch(`https://clients2.google.com/service/update2/crx?response=updatecheck&prodversion=131&x=id%3D${ITEM}%26uc`).then(r => r.text()).catch(() => '')
const st = (upd.match(/status="([^"]+)"/) || [])[1]
if (st === 'ok') console.log(`  PUBLISHED — Chrome's update service serves ${ITEM}\n  https://chromewebstore.google.com/detail/${ITEM}`)
else if (st) console.log(`  not published — update service says ${st}`)
else console.log('  update service did not answer')

if (!CWS_CLIENT_ID || !CWS_CLIENT_SECRET || !CWS_REFRESH_TOKEN) {
  console.log('  Cannot check the Chrome Web Store: no API credentials.')
  console.log('  The store cannot be scraped — a published item, a draft and a')
  console.log('  nonexistent id all return HTTP 200 and the same page.')
  console.log('  Set CWS_CLIENT_ID, CWS_CLIENT_SECRET and CWS_REFRESH_TOKEN (see the')
  console.log('  header of this file), or read it at:')
  console.log('    https://chrome.google.com/webstore/devconsole')
  process.exit(2)
}

async function accessToken () {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CWS_CLIENT_ID,
      client_secret: CWS_CLIENT_SECRET,
      refresh_token: CWS_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  })
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`)
  return (await res.json()).access_token
}

try {
  const token = await accessToken()
  const res = await fetch(
    `https://www.googleapis.com/chromewebstore/v1.1/items/${ITEM}?projection=DRAFT`,
    { headers: { authorization: `Bearer ${token}`, 'x-goog-api-version': '2' } }
  )
  const body = await res.json()
  if (!res.ok) {
    console.log(`  Chrome Web Store API said HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
    process.exit(1)
  }
  // uploadState: SUCCESS | IN_PROGRESS | FAILURE. itemError carries review notes.
  console.log(`  item ${ITEM}`)
  console.log(`  uploadState: ${body.uploadState || '(none)'}`)
  if (body.itemError?.length) {
    for (const e of body.itemError) console.log(`  error: ${e.error_detail || JSON.stringify(e)}`)
  }
  console.log(body.uploadState === 'SUCCESS'
    ? '  → published or ready; check the dashboard for review state'
    : '  → not yet published')
} catch (e) {
  console.log('  check failed: ' + e.message)
  process.exit(1)
}
