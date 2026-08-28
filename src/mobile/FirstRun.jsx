/**
 * FirstRun — the first five seconds of Radiant, and the only screen that is
 * allowed to be a piece of design rather than a piece of iOS.
 *
 * THE HANDOFF IS THE TRICK. The launch image (Splash.imageset, built by
 * scripts/make-ios-splash.py) is frame one of this screen: same ground, same two
 * glows, same lockup at the same size. iOS shows the
 * PNG, this mounts underneath it, and the entrance plays from exactly where the
 * static image left off. There is no seam, so the app looks alive from the
 * instant the icon is tapped.
 *
 * NOTHING LOOPS. Tony: "no animation should run continually." Every animation
 * here runs once and holds its final frame; the glows settle and the halo does
 * not breathe. A phone about to run a language model gets no permanent rAF.
 */
import React from 'react'
import usePress from './usePress.js'
import { BrandMark } from './BrandSpinner.jsx'
import wordUrl from '../assets/brand/radiant-wordmark.png'
import ttUrl from '../assets/brand/templeton-tech-mark.png'

export default function FirstRun ({ onChooseModel, onStartChat, hasModel, appleReady }) {
  // Start Chat leads, but only when there is something to chat WITH. With an
  // empty phone and no Apple Intelligence it would open a conversation with
  // nothing behind it, so it steps aside and Choose Model takes the primary
  // slot — the screen offers the action that can actually be completed.
  //
  // ⚠️ RENDERING THE BUTTON IS NOT ENABLING IT. Apple's model was added to the
  // render condition and left out of this one, so the button appeared, looked
  // fine, and swallowed every press. Both conditions or neither.
  const canStart = hasModel || appleReady
  const start = usePress(() => onStartChat?.(), { label: 'Start chat', disabled: !canStart })
  const choose = usePress(() => onChooseModel?.(), { label: 'Choose model' })

  return (
    <div className="rx-cover rx-intro">
      {/* Ground, in layers. Three glows, aria-hidden: this is
          atmosphere, and a screen reader announcing it would be noise. */}
      <div className="rx-intro-sky" aria-hidden="true">
        <span className="rx-intro-glow rx-intro-glow-a" />
        <span className="rx-intro-glow rx-intro-glow-b" />
        <span className="rx-intro-glow rx-intro-glow-c" />
      </div>

      <div className="rx-intro-stage">
        <span className="rx-intro-mark">
          {/* No halo. Tony: "remove the glow from the splash screen
              completely." The launch image has none either, and these two are
              the same frame — a glow on one and not the other would show as a
              flash at the handoff. */}
          {/* masked, so it follows the theme like every other mark */}
          <BrandMark size={132} className="rx-intro-mark-img" />
        </span>

        {/* Artwork, not type — the wordmark is the logo, not a font choice. But
            masked rather than drawn, so it takes the theme color the way the
            Mac's .wordmark does. Its alpha IS the letterforms, so the shapes
            are still exactly the brand's. */}
        <span
          className="rx-intro-word"
          role="img"
          aria-label="Radiant"
          style={{
            WebkitMask: `url(${wordUrl}) center / contain no-repeat`,
            mask: `url(${wordUrl}) center / contain no-repeat`
          }}
        />

        {/* Say what the product IS, first. The old line ("A model that lives on
            your iPhone. No account. No network once it's here.") described a
            single model as if the app were one, and led with what it does not
            do — no account, no network — which tells a first-time reader
            nothing about what they are holding. */}
        <p className="rx-intro-line">
          Open AI models, running on your iPhone.
        </p>
        {/* ⚠️ THE PROMISE HAS TO MATCH THE BUTTON. "Download one" was the only
            thing this screen offered, and on a phone with Apple Intelligence
            that is a toll gate in front of an app that could already answer.
            Tony: "could be a good option to default to before anyone downloads
            a model on first chat." */}
        <p className="rx-intro-sub">
          {appleReady
            ? <>Start now with Apple Intelligence, already on this iPhone. Download a model when you want one of your own — it keeps working with no signal, and nothing you send it leaves this device.</>
            : <>Download one and talk to it anywhere. It keeps working with no signal, and nothing you send it leaves this device.</>}
        </p>
      </div>

      <div className="rx-intro-actions">
        {canStart && (
          <button type="button" className={'rx-intro-cta' + start.className} {...start.handlers}>
            Start chat
          </button>
        )}
        <button
          type="button"
          className={(canStart ? 'rx-intro-second' : 'rx-intro-cta') + choose.className}
          {...choose.handlers}
        >
          Choose model
        </button>
      </div>

      {/* The site's footer, on the app's first screen.
          radiant-site/index.html `.footer-fine`: the line, then the Templeton
          Technologies mark under it, centered. Tony asked for this screen to
          carry what the web splash carries.

          ⚠️ THE MARK KEEPS ITS OWN COLORS. Every other brand element here is
          masked so it follows the user's accent — that is right for Radiant's
          own swirl, and wrong for this: it is a different company's logo, and
          recoloring it green-to-whatever is exactly the thing you do not do to
          someone's mark. It is an <img>, composited as drawn.

          It works on this ground because it is the SAME ground: the site sets
          oklch(0.15 0.018 262) behind it and so does this screen, so the mark
          is being used in the condition it was approved in. */}
      <div className="rx-intro-footer">
        <p className="rx-intro-byline">
          Radiant is a Templeton&nbsp;Technologies product.
        </p>
        <img
          className="rx-intro-tt"
          src={ttUrl}
          alt="Templeton Technologies"
          width="844"
          height="180"
        />
      </div>
    </div>
  )
}

export { FirstRun }
