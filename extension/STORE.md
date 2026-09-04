# Chrome Web Store listing

**Name:** Radiant Browser Bridge

**Summary (132 max):**
Lets the Radiant coding app work in the Chrome you are already signed into — your tabs, your logins, on your own Mac.

**Description:**
Radiant is a local coding assistant that runs on your Mac. This extension is the
bridge between it and your browser.

With it installed, Radiant's agent can list your open tabs, read and screenshot the
page you are looking at, click things by name, and fill in fields — as you, in the
browser where you are already signed in, instead of a fresh empty browser with none
of your sessions.

**Privacy — why the permissions are what they are:**
- The extension talks to one address and no other: 127.0.0.1, on your own machine.
  It has no server, sends no analytics, and makes no outbound request to anything
  on the internet.
- Host access to all sites is required because the agent works on whatever page you
  ask it about. Nothing is read unless Radiant, running on your Mac, asks for it.
- Nothing is stored by the extension. It holds no page content, no history and no
  credentials.
- Quitting Chrome, quitting Radiant, or removing the extension unplugs it
  completely. There is nothing to revoke.

**Single purpose:** connect the locally-running Radiant app to the user's browser so
it can act on pages at the user's request.


---

# Submission walkthrough

Everything below is prepared. The account and the Submit button are Tony's.

## Assets (built by `node scripts/pack-extension.mjs`)

- Package:    release/radiant-extension-<version>.zip
- Screenshot: release/store-screenshot-1280x800.png   (1280x800 — the store's required size)
- Icon:       already inside the package at 16/32/48/128

## 1. Register — one time, $5

chrome.google.com/webstore/devconsole. Sign in with the Google account that should
own the listing forever; it cannot be moved to another account later. Pay the $5
one-time registration. Set the publisher display name to **Templeton Technologies**
and verify the contact email — an unverified email blocks publishing.

## 2. New item

"Add new item" -> upload the zip. It reads the manifest and creates the draft.

## 3. Store listing tab

- Name:        Radiant Browser Bridge
- Summary:     the one-line summary above (132 char limit)
- Description: the description above
- Category:    Developer Tools
- Language:    English (United States)
- Screenshot:  release/store-screenshot-1280x800.png
- Homepage:    https://www.templetongroup.dev/showcase/radiant/

## 4. Privacy tab — where extensions get held up

- Single purpose: the sentence above.
- Justify each permission, in these words:
  - tabs           — to list the user's open tabs and act on the one they name.
  - scripting      — to read the page's text and click or fill a field, on request.
  - activeTab      — to act on the tab the user is looking at.
  - alarms         — to reconnect the service worker, which Chrome stops when idle.
  - host <all_urls>— the agent works on whatever page the user asks about, which
                     could be any site, so it cannot be narrowed in advance.
                     Nothing is read unless the locally-running Radiant app asks.
- Data usage: tick NOTHING. It collects no personally identifiable information, no
  health, financial, authentication, personal communications, location, history or
  activity data. Then tick the three certification boxes.
- Privacy policy URL:
  https://www.templetongroup.dev/showcase/radiant/extension-privacy.html

## 5. Distribution

Visibility **Public**, all regions. Not "unlisted" — an unlisted item cannot be
found by anyone who has not been sent the link, which defeats the point.

## 6. Submit

Review is usually a day or two; <all_urls> draws a closer read, which is what the
privacy answers above are for. If it is rejected, the reason names a specific
policy — send it over and it is usually a wording fix, not a code change.

## 7. After it goes live

Give me the published URL. Settings then loses the four steps and gains one
"Add to Chrome" link, and every later version ships by re-running
`scripts/pack-extension.mjs` and uploading the new zip.
