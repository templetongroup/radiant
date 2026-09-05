import type { CapacitorConfig } from '@capacitor/cli';

// ⚠️ THIS IS NOT SHAPED LIKE THE MeOS APP, ON PURPOSE.
//
// MeOS sets `server.url` to a hosted address, so its shell is a window onto one
// known site. Radiant has no such address: the server is the user's own Mac, a
// different host for every person, unknown at build time. So the shell BUNDLES
// the built UI (webDir) and the UI connects outward — Radiant's client already
// supports a remote base + access token (see setServer/apiUrl in src/api.js),
// which is the same path the phone browser already uses.
//
// ⚠️ THE MAC MUST BE REACHED OVER HTTPS. WKWebView blocks a plain-http request
// from a secure app origin, and Radiant's server speaks http. Tailscale Serve
// fronts it with a real certificate on the tailnet — that is why TG-219 blocks
// this. Do not "fix" it by loosening App Transport Security; that ships a
// weaker app to everyone to work around one machine's setup.
const config: CapacitorConfig = {
  appId: 'com.templetongroup.radiant',
  appName: 'Radiant',
  webDir: '../../dist',
  ios: {
    // the page owns scrolling; the shell should not add its own bounce
    contentInset: 'never',
    // true black, not the Mac app's tinted #121417: on an OLED iPhone a tinted
    // near-black is exactly what makes a dark UI read as a web page
    // the site's ground, so the launch screen, the native window and the web
    // layer are all the same colour and nothing flashes between them
    backgroundColor: '#000000',
    // only tailnet hosts — the app never needs the open web
    limitsNavigationsToAppBoundDomains: false
  },
  plugins: {
    // ⚠️ WITHOUT THIS PLUGIN THERE IS NO SPLASH TO SEE. Capacitor shows the
    // launch storyboard only until the web view paints its first frame, which
    // for a bundled app on a fast phone is a flicker — Tony reported "not
    // seeing the splash page" three times while the storyboard, the imageset and
    // the Info.plist key were all correct. They were: it was on screen for
    // roughly a tenth of a second.
    //
    // Held for 900ms, then faded over 250ms into the first-run screen it is
    // frame one of, so the handoff still reads as one continuous moment.
    SplashScreen: {
      // 900ms still read as a flash. Long enough to actually see and read.
      launchShowDuration: 1800,
      launchFadeOutDuration: 320,
      launchAutoHide: true,
      backgroundColor: '#000000',
      showSpinner: false
    },
    // the composer rides visualViewport itself; the web view must not resize
    Keyboard: {
      resize: 'none',
      // Without this WKWebView floats its own form-assistant bar — up
      // chevron, down chevron, Done — above the keyboard. Nothing else in
      // the app announces "this is a web view" as loudly.
      hideFormAccessoryBar: true
    }
  },
  server: {
    // no `url`: the bundled UI loads first and asks which Mac to connect to
    iosScheme: 'radiant'
  }
};

export default config;
