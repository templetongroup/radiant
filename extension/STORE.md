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
