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
import React, { useEffect, useState } from 'react'
import { deviceWord, onDeviceResolved } from './device.js'
import CompanyLine from './CompanyLine.jsx'

// ⚠️ BUILT PER RENDER, NOT AT IMPORT. This was a module-level const, so every
// deviceWord() in it was resolved once — while the answer was still the default
// "iPhone", because resolveDevice() is async and Phone.jsx does not await it.
// Nothing subscribed to onDeviceResolved either, so it never corrected: on an
// iPad the Read me said "A model on your iPhone" and "your iPhone Keychain",
// in the very release that added a section promising it says iPad.
const sections = () => [
  {
    title: `A model on your ${deviceWord()}`,
    body: [
      'Radiant downloads an open AI model onto this phone and runs it here. There is no account, and once a model has finished downloading it works with no signal at all — on a plane, underground, anywhere.',
      'A model running on the phone answers without a network, and nothing you send it leaves the device. If you add a cloud provider in Settings, chats you send to THAT model go to that company — the name under every chat title tells you which of the two is answering.'
    ]
  },
  {
    title: 'An Uncensored shelf',
    body: [
      'The model list has a new shelf called Uncensored: eleven models with their refusals removed, from Dolphin 3 and Josiefied Qwen 3 to Hermes 3 and two Heretic builds. They answer questions other models turn down. Each one was downloaded and tested before it was added.',
      'You could always find models like these with the Hugging Face search. Now the best-tested ones are on the list itself, next to everything else.'
    ]
  },
  {
    title: 'Try the new design',
    body: [
      'Home has a \u201cTry the new design\u201d link under the current model. It opens Radiant\u2019s new native look: your conversations as a list you can search and swipe (left to archive or delete), and a chat screen with the model\u2019s name at the top \u2014 tap it to switch models. Once you have opened it, Radiant starts there.',
      'It uses the same conversations, models, skills and color theme as before. In a chat, the slash button picks a skill (or type / and its name), the plus adds a photo when the model can see, and cloud models work as they always have. The gear opens Models in the new design too: what is on this phone, every model by maker with whether it runs here, downloads you can stop, and Hugging Face search. Settings, Skills and the rest still use the current design for now; coming back to Home returns to the new one. \u201cUse the current design\u201d in that menu switches back.'
    ]
  },
  {
    title: 'Fourteen new models, listed A to Z',
    body: [
      'The list grew by fourteen: MiniCPM 5 in 1B and 2B, Qwen 3.5 0.8B, Qwen 2.5 Coder 7B for code, Granite 4.2 in 3B and 8B, LFM2.5 VL 3B (it reads photos), LFM2.5 8B, GLM 4 9B and Nanbeige 4.2 3B. Four more reason before they answer: Qwen 3 4B Thinking, DeepSeek R1 0528 8B, LFM2.5 1.2B Thinking and Jamba Reasoning 3B. Every one was downloaded and asked a question before it was added.',
      'Makers are now listed A to Z, and so are the models inside each one, so you can find a model by its name. Before, the makers with the most models came first, which was hard to follow.',
      'Nemotron 3 Nano 4B works now. It used to download all 2 GB and then fail with \u201cFailed to parse config.json\u201d, because the engine that runs models on the phone expected settings that only NVIDIA\u2019s much larger Nemotron has. That is fixed in this version.',
      'Models that reason before they answer, like DeepSeek R1, used to show their reasoning and a stray \u201c</think>\u201d before the answer. Now you see \u201cthinking\u2026\u201d by the name while they work, and then only the answer.',
      'The model list can now change without an App Store update, so a model that stops working can be taken off, and new ones added, within minutes.'
    ]
  },
  {
    title: 'Follow-ups start faster, and no thinking out loud',
    body: [
      'The model now keeps its memory of the conversation between messages instead of re-reading the whole chat before every reply. The first message in a chat takes what it always took; the ones after it start almost at once, however long the chat has grown. A stopped or failed reply, a change of model or a change of skill clears that memory, and the next message rebuilds it.',
      'Models that think before they answer used to show all of it \u2014 paragraphs of \u201cthe user wants\u2026 let me consider\u2026\u201d before one line of reply. Qwen 3 is now told not to, and any model that thinks anyway shows a small \u201cthinking\u2026\u201d by its name until the answer starts. The deliberation is never shown or kept.'
    ]
  },
  {
    title: 'The icons are the ones iOS uses',
    body: [
      'The gear, the back arrow, the ⋯ menu, the download circle, the tick, the send arrow and the rest are now the same symbols iOS itself draws, at the same weights, so they sit next to the system\u2019s own icons without looking a little off. They follow the text color, so they read correctly in light and dark.'
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
      'There are seventy-eight to choose from, grouped by who made them — Google, Meta, Mistral, Microsoft, IBM, Alibaba, Apple, NVIDIA and more. The makers are in alphabetical order, and so are the models inside each one. Tap a name to open that shelf; tap it again to close it. Eight of them can look at pictures, and one of those can watch a short clip.',
      `Every model is labeled for THIS ${deviceWord()}. Green runs well. Amber runs, but close to the limit — expect it to be slow, and to reload when you switch apps. Red is not expected to load at all. The label is guidance, not a lock: you can still download a red model and try it.`,
      `That label is about memory, not storage, and they are different questions: a phone can easily have room for a file it cannot then run. Bigger models answer better and use more battery. Qwen 3 1.7B is a good place to start on any recent ${deviceWord()}.`,
      `The panel above the list shows what this ${deviceWord()} gives Radiant to work with. It is less than the phone's total memory, because iOS limits how much any single app may use.`
    ]
  },
  {
    title: 'Finding more on Hugging Face',
    body: [
      `The Models page ends with a search box. Type a name — “llama 3.2”, “qwen 4bit”, “gemma” — and Radiant searches Hugging Face for models in the format it runs. Each result is checked before you download it: whether the engine can load that kind of model, whether its weights are what its description says, and whether it fits the memory of this ${deviceWord()}. Then it gets the same green, amber or red label as the built-in list, or a plain reason it cannot run. The keyboard scrolls the search box up clear of itself, so you can see what you are typing and the Search button.`,
      'Download puts it beside the built-in models with the same turning swirl, byte count, stop, chat and remove. Remove only appears on a model the search added; a result that is already in the built-in list is managed from its own shelf. The search is not filtered: anything published in a format Radiant can run will show up, including uncensored and abliterated builds. These are models other people have made, and a model with its safety training removed will say anything — read its page on Hugging Face if you want to know what it is.'
    ]
  },
  {
    title: 'What you type is kept',
    body: [
      'Start writing a message, leave the chat to do something else, and it is still in the box when you come back. Nothing is sent until you tap the arrow.',
      `That matters most when there is no model yet. A conversation opens whether or not anything can answer it, and it now says so above the box, with a button to go and choose one. Write your message first if you like — go pick a model or start a download, and your sentence is waiting for you on this ${deviceWord()} when you return.`
    ]
  },
  {
    title: 'Keeping a conversation',
    body: [
      'Swipe a row left in Recent Sessions and you get two things: Archive and Delete, each an icon over its word. A quick flick opens or closes the drawer. Keep swiping past the middle of the screen and Archive grows to fill the drawer with a small tap of feedback \u2014 let go there and the chat is archived and the row folds away, the way Mail does it. Delete never happens from a swipe alone; it is always a tap on the open drawer. Archive puts a conversation under an Archived heading at the foot of the list, folded away until you tap it.',
      'That is worth knowing because the phone keeps the last forty conversations and quietly drops the oldest to make room. An archived one is never dropped, so archiving is how you keep something rather than just tidy it away.'
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
      'Settings → Providers connects Radiant to Anthropic, OpenAI, OpenRouter, xAI, Nous, DeepSeek, Kimi, GLM, MiniMax, Groq or Mistral with your own API key. That is how to reach the models too large to run on a phone.',
      'Add a key, search that provider\'s models, and tap one. It becomes the model answering your chats — the name at the top of every chat tells you which model is replying, and tapping that name switches between it and the models on your phone.',
      `Your key is held in the ${deviceWord()} Keychain and used by the app itself — it is never stored in the web layer, and never shown again after you enter it. These requests do go over the network, unlike a model running on the phone.`
    ]
  },
  {
    title: 'On an iPad',
    body: [
      'Radiant is one app for both. On an iPad it says iPad, sizes itself for the bigger screen instead of stretching the phone layout across it, and everything else — your models, your conversations, your colors — works exactly the same way.'
    ]
  },
  {
    title: 'Who makes this',
    body: [
      'Radiant is a Templeton Technologies product. That line sits at the foot of the welcome screen, of Home, of this guide and of About — tap it anywhere it appears and it opens templetontech.com in Safari, so you can see whose app this is.'
    ]
  },
  {
    title: 'How it looks',
    body: [
      'Settings → Appearance chooses Dark, Medium, Light, or System — Medium is dark without the true black, and System follows your phone. Radiant opens dark unless you change it.',
      'Settings → Color carries the same themes as the Mac app, including Templeton — the sage green and warm tan one. The color runs through everything: buttons, the glow behind the logo, and the ring while a model downloads. The welcome screen stays dark whichever you pick, because it is built against black, but its glow now follows the theme: pick a quiet color like Templeton or Graphite and the welcome screen is quiet too, instead of arriving fully saturated.',
      'Settings → Text size sets the size of everything on top of whatever you have chosen in iOS Settings, so you can make Radiant larger without changing every other app.'
    ]
  }
]

export default function ReadMeScreen () {
  // Re-render when the device finally names itself, so an iPad that resolved
  // after this mounted stops reading "iPhone".
  const [, bump] = useState(0)
  useEffect(() => onDeviceResolved(() => bump(n => n + 1)), [])
  return (
    <>
      {sections().map(s => (
        <section key={s.title} className="rx-readme">
          <h2 className="rx-readme-title">{s.title}</h2>
          {s.body.map((p, i) => <p key={i} className="rx-readme-body">{p}</p>)}
        </section>
      ))}
      <CompanyLine className="rx-section-footer" />
    </>
  )
}

export { ReadMeScreen }
