/**
 * Read me — the phone's, not the Mac's.
 *
 * The Mac app's guide (the GUIDE constant in src/components/Settings.jsx)
 * describes agents, MCP servers, model providers and a terminal, none of which
 * exist here. Tony: "About/Read Me obviously need to reference features in
 * this, not the mac app." So this is written from scratch against what the
 * iPhone app actually does today.
 *
 * ⚠️ IT MUST ONLY DESCRIBE WHAT IS BUILT. A guide that promises a feature the
 * app does not have is worse than no guide — that mistake has already been made
 * once in this project and had to be unshipped. When something lands, add it
 * here in the same change.
 */
import React from 'react'
import { deviceWord } from './device.js'

const SECTIONS = [
  {
    title: `A model on your ${deviceWord()}`,
    body: [
      'Radiant downloads an open AI model onto this phone and runs it here. There is no account, and once a model has finished downloading it works with no signal at all — on a plane, underground, anywhere.',
      'A model running on the phone answers without a network, and nothing you send it leaves the device. If you add a cloud provider in Settings, chats you send to THAT model go to that company — the name under every chat title tells you which of the two is answering.'
    ]
  },
  {
    title: 'Home',
    body: [
      'Home is where the app opens: the logo, a greeting, and one button to start talking. Under it, Recent lists the conversations you have had, newest first — tap one to pick it up where you left off, or Delete to remove it.',
      'If you would rather land straight back in the last thing you were saying, Settings → Open to will do that instead.'
    ]
  },
  {
    title: 'Your conversations',
    body: [
      'Every conversation is kept, named after the first thing you asked, and listed on Home. They stay on the phone — they are not synced anywhere and nobody else can read them.',
      'Inside a chat, the ⋯ menu deletes the one you are in.'
    ]
  },
  {
    title: 'Choosing a model',
    body: [
      'There are forty-nine to choose from, grouped by who made them — Google, Meta, Mistral, Microsoft, IBM, Alibaba, Apple, NVIDIA and more. Tap a name to open that shelf; tap it again to close it. Five of them can look at pictures, and one of those can watch a short clip.',
      `Every model is labeled for THIS ${deviceWord()}. Green runs well. Amber runs, but close to the limit — expect it to be slow, and to reload when you switch apps. Red is not expected to load at all. The label is guidance, not a lock: you can still download a red model and try it.`,
      `That label is about memory, not storage, and they are different questions: a phone can easily have room for a file it cannot then run. Bigger models answer better and use more battery. Qwen 3 1.7B is a good place to start on any recent ${deviceWord()}.`,
      'The panel above the list shows what this {deviceWord()} gives Radiant to work with. It is less than the phone\'s total memory, because iOS limits how much any single app may use.'
    ]
  },
  {
    title: 'Stopping a download',
    body: [
      'Tap the turning logo to stop. Whatever has already downloaded stays on the phone, so starting again picks up from there rather than beginning again.',
      'Downloads do not yet continue while the app is in the background — leave Radiant open until one finishes.'
    ]
  },
  {
    title: 'Freeing up space',
    body: [
      'Settings → Models lists everything on the phone and what it weighs. Tap a model to remove it, or Remove all models to clear them at once. Removing a model does not delete your conversations.'
    ]
  },
  {
    title: 'Models in the cloud',
    body: [
      'Settings → Providers connects Radiant to Anthropic, OpenAI, OpenRouter, xAI, Nous, DeepSeek, Kimi, GLM, Groq or Mistral with your own API key. That is how to reach the models too large to run on a phone.',
      'Add a key, search that provider\'s models, and tap one. It becomes the model answering your chats — the name at the top of every chat tells you which model is replying, and tapping that name switches between it and the models on your phone.',
      `Your key is held in the ${deviceWord()} Keychain and used by the app itself — it is never stored in the web layer, and never shown again after you enter it. These requests do go over the network, unlike a model running on the phone.`
    ]
  },
  {
    title: 'How it looks',
    body: [
      'Settings → Appearance chooses Dark, Medium, Light, or System — Medium is dark without the true black, and System follows your phone. Radiant opens dark unless you change it.',
      'Settings → Color carries the same themes as the Mac app. The color runs through everything: buttons, the glow behind the logo, and the ring while a model downloads. The welcome screen stays dark whichever you pick, because it is built against black.',
      'Settings → Text size sets the size of everything on top of whatever you have chosen in iOS Settings, so you can make Radiant larger without changing every other app.'
    ]
  }
]

export default function ReadMeScreen () {
  return (
    <>
      {SECTIONS.map(s => (
        <section key={s.title} className="rx-readme">
          <h2 className="rx-readme-title">{s.title}</h2>
          {s.body.map((p, i) => <p key={i} className="rx-readme-body">{p}</p>)}
        </section>
      ))}
      <p className="rx-section-footer">
        Radiant is a Templeton&nbsp;Technologies product.
      </p>
    </>
  )
}

export { ReadMeScreen }
