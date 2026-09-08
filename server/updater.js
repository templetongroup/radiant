// Update checking against the project's GitHub Releases. Works unsigned:
// this only *detects* a newer release and points at the download. Silent
// apply-and-relaunch would additionally require a signed build.

const REPO = 'templetongroup/radiant'

// compare "1.2.0" style strings; returns true if b is strictly newer than a
export function isNewer (a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number)
  const pb = String(b).replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0
    if (y > x) return true
    if (y < x) return false
  }
  return false
}

// ⚠️ THE ASSET THAT RUNS ON THIS MACHINE, NOT THE FIRST ONE IN THE LIST. This
// matched /\.dmg$/ and nothing else, so anywhere but a Mac it found none and
// silently handed back the releases page instead — a wall of files to choose
// from, when the whole point of the check is that Radiant already knows which
// one is wanted. The fallback stays for the case that is genuinely unknown: a
// platform with no asset published yet, where a page you can read beats a link
// that is wrong.
const ASSET_FOR = {
  darwin: /\.dmg$/i,
  linux: /\.AppImage$/i,
  win32: /\.exe$/i
}

export function assetFor (assets, platform = process.platform) {
  const pattern = ASSET_FOR[platform]
  if (!pattern) return null
  return (assets || []).find(a => pattern.test(a?.name || '')) || null
}

export async function checkForUpdate (currentVersion) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'user-agent': 'Radiant-Updater', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(8000)
  })
  if (!res.ok) throw new Error(`GitHub ${res.status}`)
  const r = await res.json()
  const latest = String(r.tag_name || '').replace(/^v/, '')
  const asset = assetFor(r.assets)
  return {
    current: currentVersion,
    latest,
    hasUpdate: Boolean(latest) && isNewer(currentVersion, latest),
    htmlUrl: r.html_url,
    downloadUrl: asset?.browser_download_url || r.html_url,
    notes: r.body || '',
    publishedAt: r.published_at
  }
}
