# Radiant — App Store Connect fields

Everything below is drafted to Apple's character limits and checked against what
the app actually does. Counts are in brackets.

---

## App information

**Bundle ID** — `com.templetongroup.radiant`
**SKU** — `radiant-ios-1`
**Primary language** — English (U.S.)
**Category** — Primary: **Productivity**. Secondary: **Developer Tools**.

> Not "Utilities": the app's job is getting work done in a conversation.
> Developer Tools as secondary because the provider/API-key audience lives there.

---

## Name and subtitle

**App name** (30 max)
```
Radiant - Local AI Chat
```
*(23)*

> "Radiant — Local AI" was already taken — App Store names are globally unique
> and a name can be held by a record that never shipped, so it is invisible.
> This one is accurate, which matters more than it sounds: guideline 2.3 rejects
> a name that promises something the app does not do. It is a local AI chat app,
> and that is what it now says.
>
> ⚠️ THE NAME ON THE PHONE IS UNAFFECTED. The Home screen icon reads **Radiant**,
> from CFBundleDisplayName in the app bundle. Only the store listing changed.

**Subtitle** (30 max)
```
Open AI models, on your iPhone
```
*(30 — exactly at the limit)*

---

## Promotional text (170 max — editable without a new build)

```
Download an open model and talk to it anywhere — on a plane, underground, with
no signal. Nothing you send it leaves your phone.
```
*(129)*

---

## Description (4000 max)

```
Radiant runs open AI models directly on your iPhone.

Download a model once and it works anywhere — on a plane, underground, with no
signal at all. Nothing you send it leaves the device, because there is nowhere
for it to go: no account, no sign-in, and no server of ours in between.

CHOOSE FROM 44 MODELS

Models from Google, Meta, Mistral, Microsoft, IBM, Alibaba, NVIDIA, DeepSeek,
Liquid AI, Hugging Face and more — grouped by who made them, from 0.2 GB up.

Every model is labeled for YOUR iPhone before you download it: Runs well, Runs
tight, or Won't run. That verdict is measured against the memory iOS actually
grants an app on your specific device, not a guess from the spec sheet — so you
know before you spend the download.

BUILT FOR THE PHONE

· Conversations are kept and named, so you can pick one up later
· Switch models mid-conversation without losing what you were saying
· Twelve color themes, four appearance modes, and your own text size
· Full Dynamic Type and VoiceOver support

BRING YOUR OWN KEY, OPTIONALLY

If you want a model too large for any phone, add your own API key for Anthropic,
OpenAI, OpenRouter, xAI, Nous, DeepSeek, Kimi, GLM, Groq or Mistral. Keys are
held in the iOS Keychain. The line under every chat title tells you which model
is answering and where it runs, so you always know whether you are on-device or
online.

Radiant is a Templeton Technologies product.
```

---

## Keywords (100 max, comma-separated, no spaces after commas)

```
offline,private,llm,assistant,coding,code,gemma,qwen,llama,mistral,on-device,gpt
```
*(79)*

> ⚠️ "local", "AI" and "chat" were REMOVED because they are now in the app name,
> and Apple already indexes every word of the name — repeating them wastes
> characters that could buy another search term.
>
> "coding" and "code" earn the developer search traffic WITHOUT claiming it in
> the name. Keywords are search intent; the name is a claim about the app, and
> only one of those is held to guideline 2.3. The iPhone app is not a coding
> assistant — that is the Mac app.

---

## URLs

**Support URL** — `https://www.templetongroup.dev/showcase/radiant/`
**Marketing URL** — `https://www.templetongroup.dev/showcase/radiant/`
**Privacy Policy URL** —
```
https://www.templetongroup.dev/showcase/radiant/privacy.html
```

> ⚠️ **The `.html` is load-bearing.** `templetongroup.dev` answers 200 for unknown
> paths and serves the homepage — the extensionless `/privacy` returns 327 KB of
> homepage while the `.html` returns the real policy. Verified by content.

---

## Privacy nutrition label

**Answer: "Data Not Collected" for every category.**

There is no analytics SDK, no advertising identifier, and no Templeton server
that receives anything. Two flows send data off-device, both user-initiated and
both going to the user's own service, not to us:

| Flow | Goes to | Ours? |
|---|---|---|
| Messages to a cloud model the user configured | That provider, under their policy | No |
| Model weight downloads | Hugging Face | No |

Apple does not count either as collection by the developer.

---

## Submission status — 2026-08-24

**REPLIED 2026-08-25 21:45.** All seven answers sent in App Review with two
screen recordings attached, and the same answers saved in the Notes field.
"Resubmit to App Review" stays greyed out after replying — for a 2.1
information request the reply itself is what goes back to the reviewer, so do
not go looking for a button to press. If the status has not moved in a couple
of days, that button is the fallback. **No new build is needed; the binary was
never at fault.**

⚠️ THE VIDEO TOOK THREE TAKES, AND THE FIRST TWO WERE UNUSABLE FOR THE REASON
THAT MATTERED. Take 1: Airplane Mode on but Wi-Fi re-enabled — the status bar
showed a live Wi-Fi fan, so it proved nothing about offline use. Take 2:
genuinely offline, but the 350M model invented Civil War history ("General Andy
Schmitt", "the Confederate city of App pressed"), which is not something to put
in front of a reviewer of an AI app. Take 3: Wi-Fi off but cellular still up —
"5G+" in the status bar. Take 4 is the one: Airplane Mode itself on, iOS showing
"Disconnecting Nearby Wi-Fi", no Wi-Fi and no cellular in the status bar, and a
clean haiku. **Check the status bar of any offline demo before believing it.**

**REJECTED 2026-08-25 20:59 — Guideline 2.1, Information Needed.** Not a
guideline violation and no code change required: Apple's standard request for
more detail on a new app. They asked for seven things; six are now answered in
the App Review Notes field (capped at 4,000 characters — a 4,151-character
draft was refused). The seventh is a **screen recording made on a physical
device**, which only Tony can produce, and it must be attached to the reply in
App Review.

⚠️ The prediction in this file was wrong. It said the likeliest ground was
guideline 1.2 (AI-generated content with no filter or report path). Apple did
not raise 1.2 at all. Do not treat that prediction as settled — it has not been
tested, because review never got that far.

**SUBMITTED. Status: "1.0 Waiting for Review" as of 2026-08-24 ~23:20.**
Build 1.0 (2) uploaded at 22:59. App ID 6804891721,
bundle `com.templetongroup.radiant`, arm64, iPhone only (device family 1).

Done and verified by reload:

| Item | State |
|---|---|
| Name / subtitle | Radiant - Local AI Chat / "Open AI models, on your iPhone" (30 chars, at the cap) |
| Category | Productivity, secondary Developer Tools |
| Description, keywords, URLs, copyright, review notes | filled |
| Screenshots | 4 on the 6.9" slot, RGB, no alpha |
| Sign-in required | unchecked — the app has no login |
| App Privacy | Data Not Collected |
| Privacy policy | https://www.templetongroup.dev/showcase/radiant/privacy.html |
| Content rights | yes, third-party content with rights (the 44 open-weight models) |
| Age rating | 13+ — see below |
| Price / availability | free, all 175 countries |
| DSA trader | declared as a trader; NY Certificate of Assumed Name uploaded; **In Review** |
| Export compliance | no prompt — `ITSAppUsesNonExemptEncryption` is false in Info.plist (HTTPS only) |

**Nothing left to do.** Wait for Apple.

### ⚠️ APP PRIVACY HAS A PUBLISH STEP, AND SAVING IS NOT PUBLISHING

This blocked the submission and cost a round trip. The App Privacy answers
were entered and verified-by-reload early in the evening, and the section still
read "Data Not Collected" on screen — but a **Publish** button sat unpressed in
the corner, so the answers were a draft. "Add for Review" refused with *"an
Admin must provide information about the app's privacy practices"*, which
does not sound like "you forgot to publish".

**The lesson generalizes: verifying a value persisted is not verifying the
section is complete.** Reloading proved the draft saved. It could not prove the
draft had been published, because a saved draft and a published label look
identical on that page apart from one button.

### If Apple rejects

Most likely ground is guideline 1.2 — apps surfacing AI-generated content are
sometimes asked for a content filter, a report mechanism and a way to block
abusive users. Radiant has none; the counter-argument, already in the review
notes, is that it runs models on-device with no accounts and no other users to
report or block. If it comes back, the cheap fix is a first-run content
disclaimer plus a report control, not a rebuild.

### ⚠️ The seller name is "Anthony Ricciardi", not Templeton Technologies

The Apple Developer account is an **Individual** enrollment, so App Store
Connect renders Name and Type read-only — this cannot be fixed in ASC. Tony
wants Templeton Technologies. The path is a D-U-N-S number for TEMPLETON
TECHNOLOGIES, INC. (a real NY domestic business corporation, DOS ID 7877951)
plus an individual-to-organization conversion request to Apple Developer
Support. **Converting later updates the seller name on apps already shipped —
no resubmission**, which is why the release did not wait for it.

### ⚠️ What has never been tested

MLX cannot initialize in the iOS Simulator, so until 2026-08-24 the
model-loading and generation path had never run in a Release build. It was
installed to Tony's iPhone 17 Pro Max via devicectl and exercised by hand
before the upload. There is still no automated coverage of it — the 31 runtime
assertions drive the phone UI in Chrome against a stubbed bridge.

---

## Age rating

**Submitted 2026-08-24. Result: 13+** in 172 countries, 12+ in Vietnam and
Korea, A14 in Brazil. On iOS versions earlier than 26 it maps to a global 12+.

### How the answers were chosen

The benchmark is **Locally AI** (by LM Studio) — the closest peer to Radiant on
the store, rated **12+** with four descriptors: Mature/Suggestive Themes,
Horror/Fear, Alcohol-Tobacco-Drugs, and Medical/Treatment, all Infrequent/Mild.
Private LLM sits at 12+, LLM Studio at 9+, Enclave and MLC Chat at 17+.

Radiant differs from Locally in one way that matters: it also reaches cloud
models through OpenRouter, which carries unfiltered models. So the declaration
is Locally's, plus profanity and plus the two lightest violence rows.

⚠️ **DO NOT answer "None" down the content steps to chase a 4+.** The app ships
no content of its own, but it generates text from a model with no content
filter. A reviewer who types a rude question and gets a rude answer has caught
an inaccurate declaration — guideline 2.3, and a rejection costs more than the
rating ever would.

### Step 1 — Features. All eight NO, each verified against the code.

| Question | Answer | Why |
|---|---|---|
| Parental Controls | No | none exist |
| Age Assurance | No | none exists |
| Unrestricted Web Access | No | the only external link is the privacy page, and it opens in Safari |
| User-Generated Content | No | chats are local and never distributed |
| Social Media | No | — |
| Social Media Disabled for Users Under 13 | No | — |
| Messaging and Chat | No | this asks whether users can talk to *each other*. They cannot |
| Advertising | No | — |

### Steps 2–6 — Content

| Item | Answer |
|---|---|
| Profanity or Crude Humor | Infrequent |
| Horror/Fear Themes | Infrequent |
| Alcohol, Tobacco, or Drug Use or References | Infrequent |
| Medical or Treatment Information | Infrequent |
| Health or Wellness Topics | Yes |
| Mature or Suggestive Themes | Infrequent |
| Sexual Content or Nudity | None |
| Graphic Sexual Content and Nudity | None |
| Cartoon or Fantasy Violence | Infrequent |
| Realistic Violence | None |
| Prolonged Graphic or Sadistic Realistic Violence | None |
| Guns or Other Weapons | Infrequent |
| Simulated Gambling · Contests · Gambling · Loot Boxes | None / No |

Step 7 override: **Not Applicable**. No EULA age requirement, no age category.

### Two things that make the low rows defensible

All 44 catalogue models are mainstream instruction-tuned releases from Google,
Meta, Mistral, Microsoft, Alibaba, IBM, Nvidia, Liquid, Allen AI and Hugging
Face — nothing abliterated or uncensored. And there is no field anywhere in the
phone UI for pasting an arbitrary Hugging Face repo, so the list is closed.
**If either of those changes, this questionnaire has to be answered again.**

---

## Review notes

```
Radiant runs open language models entirely on the iPhone using Apple's MLX
framework. No account is required and there is nothing to sign in to — open the
app, choose a model, download it, and it works offline from then on.

TO TEST: tap "Choose a model", open any maker section, and pick Qwen 3 1.7B
(about 1 GB). Please use Wi-Fi. When it finishes, tap New chat. A model must
finish downloading before a conversation is possible; there is no cloud
fallback.

Models are labeled "Runs well", "Runs tight" or "Won't run" against the memory
iOS grants this app on the specific device. On a review device with less memory,
fewer models will be available — this is intentional and honest, not an error.

The interface is a WKWebView, but the app is not a web wrapper: it bundles MLX
Swift, downloads multi-gigabyte model weights, and performs inference on-device.
Enabling Airplane Mode after a download demonstrates this — the app keeps working
with no network at all.

Settings > Providers optionally accepts the user's own API key for a cloud
provider. This is not required, and no key is supplied for review. Keys are
stored in the iOS Keychain.

The app uses the Increased Memory Limit entitlement because model weights must be
resident in memory to run.
```

**Demo account** — not applicable; the app has no login.
**Contact** — a real phone number and email that will be answered.

---

## Screenshots

Required: **6.9"** iPhone. 6.5" is accepted if provided. iPad is NOT required —
the app is iPhone-only (`TARGETED_DEVICE_FAMILY = 1`).

Suggested five, in order:

1. **Home** — the lockup, greeting, New chat
2. **Models** — a maker shelf open, showing the Runs well / Runs tight labels
3. **A chat** — a real reply, with the model name and origin in the title
4. **Settings** — themes and text size
5. **Device panel** — the memory readout above the model list

⚠️ Real app, real data. No mockups, no invented UI, no pricing claims or
"#1 app" captions.

---

## Pricing

Decide: free, or paid. Territories: all, unless there is a reason not to.
