import React from 'react'

// Minimal line icons (Lucide-style): 24×24, currentColor stroke, round caps.
function Svg ({ children, size = 16, fill = 'none' }) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' fill={fill} stroke='currentColor'
      strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden focusable='false'>
      {children}
    </svg>
  )
}

export const Icon = {
  download: p => <Svg {...p}><path d='M12 3v12M7 10l5 5 5-5M5 21h14' /></Svg>,
  panel: p => <Svg {...p}><rect x='3' y='4' width='18' height='16' rx='2' /><path d='M15 4v16' /></Svg>,
  settings: p => <Svg {...p}><circle cx='12' cy='12' r='3' /><path d='M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7.7 1.6 1.6 0 0 0-1 1.5V22a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1.1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-.3-2.7 1.6 1.6 0 0 0-1.5-1H2a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1.1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H8a1.6 1.6 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V8a1.6 1.6 0 0 0 1.5 1H22a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z' /></Svg>,
  sun: p => <Svg {...p}><circle cx='12' cy='12' r='4' /><path d='M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' /></Svg>,
  moon: p => <Svg {...p}><path d='M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z' /></Svg>,
  contrast: p => <Svg {...p}><circle cx='12' cy='12' r='9' /><path d='M12 3a9 9 0 0 0 0 18z' fill='currentColor' /></Svg>,
  plus: p => <Svg {...p}><path d='M12 5v14M5 12h14' /></Svg>,
  arrowUp: p => <Svg {...p}><path d='M12 19V5M5 12l7-7 7 7' /></Svg>,
  sparkle: p => <Svg {...p}><path d='M12 5.3l1.8 4.9L18.7 12l-4.9 1.8L12 18.7l-1.8-4.9L5.3 12l4.9-1.8z' /></Svg>,
  stop: p => <Svg {...p}><rect x='6' y='6' width='12' height='12' rx='2' /></Svg>,
  close: p => <Svg {...p}><path d='M18 6 6 18M6 6l12 12' /></Svg>,
  // ⚠️ EMOJI ARE NOT AN ICON SET. The composer toggles used 🖥 📋 🔓 ⚡ ✋ and the
  // transcript used 🔧 👥 📄 — colour glyphs that render differently per OS
  // version, ignore currentColor, and sit beside the line icons everywhere else
  // looking like a different app. Tony: "i dont like thee skewmorphic icons for
  // tools, computer off, plan off etc." These match the rest: 24×24, stroked in
  // currentColor, so they inherit state colour on a pill the way text does.
  monitor: p => <Svg {...p}><rect x='2' y='4' width='20' height='13' rx='2' /><path d='M8 21h8M12 17v4' /></Svg>,
  clipboard: p => <Svg {...p}><rect x='9' y='2' width='6' height='4' rx='1' /><path d='M15 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 12h6M9 16h4' /></Svg>,
  unlock: p => <Svg {...p}><rect x='4' y='11' width='16' height='10' rx='2' /><path d='M8 11V7a4 4 0 0 1 7.5-2' /></Svg>,
  zap: p => <Svg {...p}><path d='M13 2 4 14h7l-1 8 9-12h-7z' /></Svg>,
  hand: p => <Svg {...p}><path d='M9 11V4.5a1.5 1.5 0 0 1 3 0V11m0-.5V3.5a1.5 1.5 0 0 1 3 0V11m0-.5V5.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a7 7 0 0 1-7-7v-2a1.5 1.5 0 0 1 3 0' /></Svg>,
  wrench: p => <Svg {...p}><path d='M14.7 6.3a4 4 0 0 0 5 5l-9 9a2.8 2.8 0 0 1-4-4z' /><path d='M14.7 6.3 18 3l3 3-3.3 3.3' /></Svg>,
  users: p => <Svg {...p}><circle cx='9' cy='8' r='3.2' /><path d='M2.5 20a6.5 6.5 0 0 1 13 0' /><path d='M16.5 5.4a3.2 3.2 0 0 1 0 5.2M18 14.6a6.5 6.5 0 0 1 3.5 5.4' /></Svg>,
  file: p => <Svg {...p}><path d='M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' /><path d='M14 3v5h5M9 13h6M9 17h4' /></Svg>,
  bot: p => <Svg {...p}><rect x='4' y='8' width='16' height='12' rx='3' /><path d='M12 4v4M8.5 13.5h.01M15.5 13.5h.01M9.5 17h5' /></Svg>,
  branch: p => <Svg {...p}><circle cx='6' cy='6' r='2.5' /><circle cx='6' cy='18' r='2.5' /><circle cx='18' cy='8' r='2.5' /><path d='M6 8.5v7M8.5 6.6c5 .6 6.5 2 7 4.4' /></Svg>,
  folder: p => <Svg {...p}><path d='M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' /></Svg>,
  // Lid, box, arrow in — the shape everyone reads as "archive". Paired with
  // trash below: ✕ used to do the archiving, and ✕ means delete. Tony: "To me
  // an X means delete."
  archive: p => <Svg {...p}><rect x='3' y='4' width='18' height='4' rx='1' /><path d='M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M12 11v6M9 14l3 3 3-3' /></Svg>,
  // Out of the box again.
  unarchive: p => <Svg {...p}><rect x='3' y='4' width='18' height='4' rx='1' /><path d='M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M12 18v-6M9 15l3-3 3 3' /></Svg>,
  trash: p => <Svg {...p}><path d='M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14' /></Svg>,
  mic: p => <Svg {...p}><rect x='9' y='2' width='6' height='12' rx='3' /><path d='M5 11a7 7 0 0 0 14 0M12 18v4' /></Svg>,
  target: p => <Svg {...p}><circle cx='12' cy='12' r='7' /><path d='M12 2v3M12 19v3M2 12h3M19 12h3' /><circle cx='12' cy='12' r='1.5' /></Svg>
}
