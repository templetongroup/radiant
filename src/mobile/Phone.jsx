/**
 * Phone — the phone app's entry point, and the only module App.jsx knows about.
 *
 * It exists to keep two things out of the desktop build: mobile.css (imported
 * here, so it lands in the phone chunk and never in the Mac bundle) and the
 * whole src/mobile tree behind it. App.jsx reaches this through a lazy import
 * that only runs inside the native shell.
 */
import React, { useEffect } from 'react'
import './mobile.css'
import installBridge from './bridge.js'
import { resolveDevice } from './device.js'
import MobileShell from './MobileShell.jsx'

// Before anything renders: the injected native bridge does not populate
// Capacitor.Plugins by itself, and every screen reads plugins off that object.
installBridge()
// ⚠️ ASK BEFORE THE FIRST RENDER. Every screen says "this iPhone" or "this
// iPad" somewhere; resolving it after paint would flash the wrong word.
resolveDevice()

export default function Phone () {
  // Dynamic Type: mobile.css cannot test a custom property in a media query, so
  // the AX reflow (catalog rows go to two lines rather than truncating the model
  // name) is gated on a data attribute measured here. The shell measures the
  // same scale for --rx-dt; this is the one bit that has to live on the root.
  // ⚠️ NO TYPE PROBE HERE. There used to be one, writing --rx-dt on the root
  // while MobileShell wrote its own on the shell element — two writers, the
  // same events, and only one of them folding in the user's Text size. That is
  // why Text size in Settings moved nothing. useDynamicType() in MobileShell is
  // the single writer of --rx-dt AND of data-ax; this file only marks the tree
  // as native.
  useEffect(() => {
    document.documentElement.classList.add('is-native')
  }, [])

  return <MobileShell />
}

export { Phone }
