# Radiant iPhone App Web UI Feature Inventory

**App Structure**: React web UI running in Capacitor shell on iOS/iPadOS
**Entry Point**: `src/mobile/MobileShell.jsx` (router, navigation, shell chrome)
**Date**: 2026-09-25

---

## NAVIGATION STRUCTURE

All routes managed by `MobileShell.jsx:387-402` (`SCREENS` config):

- **home**: HomeScreen | large: false | bg: grouped
- **models**: ModelsScreen | large: true | bg: grouped
- **chat**: ChatScreen | large: false | bare: true | bg: plain (owns nav bar)
- **settings**: SettingsScreen | large: true | bg: grouped
- **readme**: ReadMeScreen | large: false | bg: grouped
- **providers**: ProvidersScreen | large: false | bg: grouped
- **skills**: SkillsScreen | large: false | bg: grouped

**Navigation Stack Features** (MobileShell.jsx:1024-1092):
- Interactive edge-swipe back gesture (left edge, 20pt inset)
- Velocity-based gesture completion (300pt/s threshold)
- Parallax dim on outgoing view (−30%, 0.12 opacity)
- Reduced-motion mode: cross-dissolve instead of slide
- Gesture cancellation with slop detection (10pt)

---

## SCREEN: HOME (HomeScreen.jsx)

**Route**: `home` | No large title | Greeting-based header

### Display Elements

1. **Radiant Lockup** (HomeScreen.jsx:121-135)
   - BrandMark (72pt) + Wordmark SVG masked to theme color
   - Dynamic greeting: "Still up" / "Good morning" / "Good afternoon" / "Good evening"
   - aria-label="Radiant"

2. **Model State Display** (HomeScreen.jsx:137-145)
   - If no activeModel:
     - "No model on this [iPhone/iPad] yet."
     - "Choose one and it runs here, offline."
   - If activeModel exists:
     - "Current model: [name]" (aria-hidden, below buttons for accessibility)

3. **Action Buttons** (HomeScreen.jsx:148-173)
   - "New chat" button (disabled if !activeModel) → `onStartChat()`
   - "Choose a model" / "Models" button → `onChooseModel()`
   - "Try the new design" (native preview link, if available) → `openNativePreview()` (nativePreview.js)

4. **Recent Sessions** (HomeScreen.jsx:175-225)
   - Section header: "Recent Sessions"
   - Chat rows (grouped list):
     - Each ChatRow shows:
       - Title (first user message, truncated to 60 chars)
       - Metadata: `whenLabel()` + model name if available
       - **Swipe gesture** (SwipeRow.jsx):
         - Swipe left reveals: **Archive** (toggle archived state) + **Delete** (removeChat)
         - Long-press in middle → haptic, reveal grows to fill drawer
         - Delete is tap-only (never auto-deletes on swipe)
       - Tap to open conversation → `onOpenChat(chat.id)`

5. **Archived Section** (HomeScreen.jsx:199-225)
   - Collapsible toggle: "▾ Archived (count)" / "▸ Archived (count)"
   - aria-expanded on toggle
   - Same ChatRow layout as recent, but filtered to archived chats only
   - Archiving is how conversations survive the 40-chat cap (unarchived cap only)

6. **Footer** (HomeScreen.jsx:230)
   - CompanyLine (Templeton Technologies attribution)

### State Management
- Chats list: `listChats()` on mount + subscribe to `rx:chats-changed` event
- Archived list: `listChats({ archived: true })`
- Open row tracker: one row open at a time (prevent duplicate delete buttons)
- Re-reads on `isTop` flip (when returning from chat) and on `visibilitychange`

### Interactions & Events
- **Delete chat**: `deleteChat(chat.id)` (no confirmation—swipe is confirmation)
- **Archive/unarchive**: `setArchived(chat.id, !archived)` 
- **Open chat**: Passes chatId to push('chat', { chatId })
- **Rating prompt**: Triggered after conversation with 6+ turns (rating.js)

---

## SCREEN: CHAT (ChatScreen.jsx + MobileChat.jsx)

**Route**: `chat` | bare: true (owns full layout) | No shell nav bar

### Display Architecture

**MobileChat owns**:
- Transcript scroller + large title crossfade
- Pinned composer at bottom
- Two-line nav bar (model name + origin/tok/s)
- Context menu (ellipsis in bar)

**ChatScreen wraps**:
- Persistence: conversation id, draft text, skill
- Navigation back to home
- Model switching
- Conversation deletion

### Display Elements (MobileChat.jsx)

1. **Nav Bar** (MobileChat-internal, not shell)
   - Title line 1: activeModel.name (or "Chat" if none)
   - Subtitle line 2: "On device" | "Cloud: [provider]" | "tok/s" readout while generating
   - Ellipsis menu button (trailing)

2. **Transcript Scroller**
   - Renders messages in order (user right-aligned, model left-aligned)
   - Each message shows:
     - Role badge or avatar
     - Text content
     - Images (if attached, handled by photo picker)
     - Errors as red text if generation failed
   - Large title "Chat" fades in as user scrolls (iOS-style crossfade)

3. **Composer (pinned to bottom)**
   - Text input field
   - "Send" button (arrow icon, disabled if empty or no model)
   - Model selector/switcher (tap model name to open ModelPicker)
   - Skill selector (shows which skill is active, if any)
   - **Slash command support**:
     - Type `/` to see matching skills
     - `/skill-name message` → uses skill for that message only
     - parseSlash() extracts skill and message text

4. **State Strips** (above composer)
   - If no model: "No model to answer yet" + "Choose model" button
   - If downloading: download progress
   - If waiting for response: loading indicator
   - Message count / token count (if displayed)

### Message Format (in chats.js)
```javascript
{
  id: string,
  role: 'user' | 'assistant',
  text: string,
  // Optional:
  photo: { base64, width, height },
  error: string,
  modelName: string  // tracked per-message
}
```

### State Management
- **Initial messages**: `loadChat(id)?.messages || []` (restored from chats.js)
- **Draft text**: `loadDraft(id)` (restored, orphan adoption from `adoptDraft()`)
- **Active skill**: `loadChat(id)?.skillId` (restored with chat)
- **Persist on change**:
  - `saveDraft(id, text)` as user types (debounced by component)
  - `saveChat({ id, messages, modelId, modelName, skillId })` after each message
  - Messages sliced to MAX_TURNS (200) to cap storage

### Native Calls (MobileChat.jsx)

**LocalModels plugin**:
- `LocalModels.generate({ modelId, prompt })` → stream tokens → rx:token event
- `LocalModels.stop()` → cancels active generation

**ProviderChat plugin**:
- `ProviderChat.send({ provider, model, messages, apiKey })` → stream tokens
- `ProviderChat.stop()` → cancels active generation

**AppleModel plugin**:
- `AppleModel.send({ prompt, instructions })` → returns full response (not streamed)
- `AppleModel.stop()` → cancels active generation

**Keyboard plugin**:
- `Keyboard.hide()` after selecting an image

**NativePreview plugin**:
- Conversations synced to native preview via `allChats()`

### Interactions & Events

- **Send message**: triggers generation via active model's plugin
- **Token stream**: listens to plugin events, appends to message.text
- **Model switch**: `onSwitchModel(id)` → clears cloud model (if local selected) or sets cloud model
- **Stop generation**: `LocalModels.stop()` and `ProviderChat.stop()` called
- **Menu (from ellipsis)**:
  - "New conversation" → `emitChatAction('new')` → ChatScreen deletes and remounts
  - "Model info" → `presentSheet(activeModel.id)` → GetModelSheet
  - "Delete conversation" → `emitChatAction('delete')` → ChatScreen deletes and goes home
- **Back button**: `nav.pop()` → returns to home (draft saved, conversation persisted)

### Accessibility

- Viewport meta for iOS device adaption
- usePress for consistent tap haptics
- Keyboard trap (focus wraps in sheet if one open)
- ARIA live region for token stream

---

## SCREEN: MODELS (ModelsScreen.jsx)

**Route**: `models` | large: true | bg: grouped | Root of nav stack

### Display Architecture

1. **Hero Section** (ModelsScreen.jsx:100-143)
   - **Resident mode** (model downloaded):
     - BrandMark (96pt) with negative margin for optical alignment
     - Title: activeModel.name
     - Subtitle: "[size] on this [device]" or "Built into iOS · nothing to download" (Apple)
     - Tap → opens chat with that model
     - aria-label includes full state
   
   - **Empty mode** (no model):
     - BrandMark (96pt)
     - Title: "No model yet"
     - Subtitle: "Choose a model to run..."
     - Tap → presentSheet(null) opens model picker
     - aria-label: "No model yet. Choose a model to download."

2. **Storage Gauge** (StorageLine.jsx)
   - Colored segments for each downloaded model (width = proportion of usage)
   - Free space remaining (percentage or GB)
   - Rendered even if nothing downloaded (shows free space)

3. **Grouped Lists by Maker** (MakerSection.jsx)

   **Installed Models Section**:
   - Header: "On this [device]" (if any models downloaded)
   - InstalledRow for each downloaded local model:
     - BrandMark (29pt) lead
     - Name + "Current" badge if active
     - Size subtitle
     - "Manage" button → `onInfo()` → GetModelSheet (detail mode)
     - Tap row → `onOpen()` → starts chat with model
     - aria-label: "Chat with [name]..."

   **Apple Row** (if iOS 26+, regardless of availability):
   - If available: shows "Apple Intelligence, Built into iOS"
     - Tap → chat with Apple model
   - If unavailable: dimmed, shows reason
     - "This iOS does not support Apple Intelligence" | "Apple Intelligence is off" | etc.
     - aria-disabled="true"

   **Catalog by Maker** (grouped alphabetically by maker.name):
   - Each maker is a collapsible section
   - Maker header (tap to toggle open/closed)
   - ModelRow for each model in catalog:
     - Name + blurb + size
     - Fit verdict: green/amber/red (memory fit label from fit.js)
     - Trailing control:
       - ✓ (Checkmark) if downloaded → tap to open chat
       - ↓ (ArrowDownCircle) if not downloaded:
         - Shows gauge (26pt) if downloading
         - Shows "Stop" if downloading
         - Shows download arrow if not started
       - Progress text: "2.4 GB / 4.2 GB" or "Preparing" or percentage
     - Tap row → `onTap(model)` → presentSheet(model.id)
     - aria-label includes fit verdict, progress, etc.

4. **Hugging Face Search** (HuggingFaceSearch.jsx)
   - Search box: "Search Hugging Face"
   - Type model name or pattern
   - Results show same fit verdicts
   - Results include "Download" action (adds to phone models)
   - Results include "Remove" (only for HF-added models)
   - Keyboard scrolls search box above itself

### State Management

- **Models list**: from useLocalModels() hook
- **Downloaded models**: filtered to model.downloaded === true
- **Apple model**: from appleModel.js (checkApple(), appleState(), availability reason)
- **Active model**: from MobileShell (used to highlight "Current")

### Native Calls (ModelsScreen.jsx → useLocalModels.js)

**LocalModels plugin**:
- `LocalModels.list()` → array of catalog models
- `LocalModels.downloaded()` → array of downloaded models with state
- `LocalModels.diskInfo()` → { usedBytes, freeBytes }
- `LocalModels.download({ id })` → emits download progress events
- `LocalModels.cancelDownload({ id })` → stops active download
- `LocalModels.remove({ id })` → deletes model from device
- `LocalModels.addCustom({ name, url })` → adds HF model (from HuggingFaceSearch)
- `LocalModels.diagnose()` → troubleshooting info
- Subscribe to `download-progress` events

**Device plugin**:
- `Device.getInfo()` → { platform, osVersion, memoryUsed, memoryAvailable }

### Interactions & Events

- **Download model**: `local.download(model.id)` → shows progress gauge
- **Stop download**: `local.cancelDownload(model.id)`
- **Remove model**: `local.remove(model.id)` (with confirmation)
- **Open model info**: `presentSheet(model.id)` → GetModelSheet detail view
- **Start chat**: `onOpenChat(model.id)` or open model → starts conversation
- **Tap model row**: pushes to GetModelSheet picker/details
- **Hugging Face search**: calls `hf.search(query)` → fetches from https://huggingface.co

---

## SCREEN: SETTINGS (SettingsScreen.jsx)

**Route**: `settings` | large: true | bg: grouped

### Sections

1. **Open to** (SettingsScreen.jsx:128-137)
   - Segmented control: "Home" | "Last chat"
   - Tap option → `setOpenTo(id)` → `applyAppearance()`
   - Stored in 'radiant.phone.appearance'
   - Footer text: "Whether Radiant opens on Home or straight back into the conversation you were last having."

2. **Appearance** (SettingsScreen.jsx:139-148)
   - Segmented control: "Dark" | "Medium" | "Light" | "System"
   - Tap option → `setMode(id)` → `applyAppearance()`
   - Footer: "Radiant opens dark unless you change this. The welcome screen stays dark either way — it is a branded moment, like the launch screen."

3. **Color** (SettingsScreen.jsx:150-159)
   - 12 color swatches (THEMES in theme.js):
     - radiant, ember, tokyonight, catppuccin, everforest, templeton, gruvbox, nord, dracula, rosepine, solarized, moss, graphite, nousclassic
   - Swatch component shows color dot + name
   - Tap swatch → `pick(theme.id)` → `applyAppearance()` → sets --rx-accent-h/c or pinned vars
   - Selected swatch has checkmark
   - Footer: "The color runs through the whole app — buttons, the glow behind the logo, and the ring while a model downloads."

4. **Text size** (SettingsScreen.jsx:161-171)
   - Segmented control: "Small" (0.92) | "Default" (1) | "Large" (1.1) | "Larger" (1.2)
   - Tap option → `size(id)` → `applyAppearance()` → sets --rx-user-scale
   - Rides on top of system text size (both are multiplied)
   - Footer: "Rides on top of the system text size rather than replacing it, so Accessibility settings still win."

5. **Models** (SettingsScreen.jsx:173-225)
   - Row: "On this [device]" with value "[count] · [total GB]"
   - List of ModelRow components:
     - Model name + size + "Remove" button
     - Tap Remove → `removeOne(model)` → window.confirm → `local.remove(model.id)`
   - Row: "Download a model" → `onGetModels()` → push('models')
   - Row: "Remove all models" (if any downloaded) → `clearAll()` → confirms + loops through local.remove()

6. **Read Me** (SettingsScreen.jsx:227-232)
   - Row: "Read me" → `onReadMe()` → push('readme')

7. **Providers** (SettingsScreen.jsx:233-238)
   - Row: "Providers" → `onProviders()` → push('providers')

8. **Skills** (SettingsScreen.jsx:239-244)
   - Row: "Skills" → `onSkills()` → push('skills')

9. **Storage** (SettingsScreen.jsx:245-252)
   - Row: "Clear all Radiant data" (if any data stored)
   - Deletes all chats, drafts, skills, appearance, cloud model choice
   - Confirmation: window.confirm()
   - Calls: deleteAllChats(), listSkills().map(deleteSkill), localStorage.clear()

10. **About** (SettingsScreen.jsx:253-262)
    - Version display: "[__APP_VERSION__] ([buildNumber()])"
    - "Radiant is a Templeton Technologies product"
    - CompanyLine (clickable to open templetontech.com)

### State Management

- **Appearance**: `loadAppearance()` on mount → state → `onAppearance(updated)`
- **Downloaded models**: from useLocalModels()
- **Storage used**: sum of model.sizeGB * 1e9

### Native Calls

**LocalModels.remove(id)** for each model deletion

---

## SCREEN: PROVIDERS (ProvidersScreen.jsx)

**Route**: `providers` | large: false | bg: grouped

### Display

1. **Provider List**
   - One Provider component per PROVIDER in providers.js:24-46
   - Providers: Anthropic, OpenAI, OpenRouter, xAI, Nous, DeepSeek, Kimi, GLM, MiniMax, Groq, Mistral

2. **Provider Row** (Provider.jsx:90-179)
   - **Collapsed state**:
     - Row with provider name + hint (e.g., "GPT models. Key from platform.openai.com.")
     - Connected badge: "Connected" if key stored
     - Tap to expand (aria-expanded)
     - aria-label: "[name], [connected status]"
   
   - **Expanded state** (if open):
     - **Models list** (if connected):
       - Search field: "Search [N] models"
       - Model chips (pills): tap to select, shows selected state
       - Shows 12 models by default (or 60 filtered if search active)
       - Note: "[N] more — keep typing to narrow it down"
       - Uses fetchModels() to get list from provider API
       - Loading state: "Asking [provider] what it can run…"
       - Error state: shows error message from provider
     
     - **Edit section** (if open):
       - Password input: "Paste your API key" / "Paste a new key to replace"
       - Error message if format wrong (looksWrong())
       - Buttons:
         - "Save key" (or "Replace key" if connected)
         - "Remove" (red, if connected)

### Interactions & Events

1. **Save Key**:
   - Validates format with looksWrong() (length, spaces, provider prefix)
   - Checks hasConsent() → if not, opens ConsentSheet
   - Calls `saveKey(provider.id, value)` → SecureStore.set()
   - Calls `grantConsent(provider.id)` → records consent timestamp
   - Refresh model list
   - Close expanded state

2. **Remove Key**:
   - Calls `removeKey(provider.id)` → SecureStore.remove()
   - Calls `revokeConsent(provider.id)` → deletes consent record
   - Clear model list
   - Close expanded state

3. **Model Selection**:
   - Tap model chip → `onChoose(provider.id, model)` → `saveChosen()`
   - Tapping selected model clears choice (toggles off)
   - Stores as { providerId, model } in 'radiant.phone.cloudModel'

4. **Fetch Models** (providers.js:92-96):
   - `ProviderChat.models({ provider: provider.id, baseUrl: provider.baseUrl })` → array of model IDs
   - Vendor error shown directly (more honest than generic message)

### State Management

- **Connected providers**: `connectedProviders()` → SecureStore.keys()
- **Chosen model**: `loadChosen()` from localStorage
- **Models list**: fetched on mount if connected
- **Edit state**: local per provider (open/closed)
- **Search filter**: local per provider

### Native Calls

**SecureStore plugin**:
- `SecureStore.keys()` → { keys: [provider.id, ...] }
- `SecureStore.set({ key: provider.id, value: apiKey })`
- `SecureStore.remove({ key: provider.id })`

**ProviderChat plugin**:
- `ProviderChat.models({ provider: string, baseUrl: string })` → { models: [string, ...] }

---

## SCREEN: SKILLS (SkillsScreen.jsx)

**Route**: `skills` | large: false | bg: grouped

### Display

1. **Bundled Skills** (skills.js:33-59)
   - 5 built-in skills on first run:
     - "Plain English": Answer in plain English that a smart person outside software would follow on the first read. No jargon unless you define it in the same sentence.
     - "Keep it short": Answer in at most three sentences. If the honest answer needs more room, give the short answer first and say what you left out.
     - "Step by step": Give the answer as numbered steps in the order I should do them. One action per step. Say what I should see after each one.
     - "Show your reasoning": Before the answer, state briefly what you are assuming and why you are taking this approach. If you are unsure, say which part you are unsure about rather than picking confidently.
     - "Argue the other side": Give the strongest case against what I just said before you agree with any of it. Be specific rather than balanced.

2. **Skill List** (SkillsScreen.jsx:250+)
   - List of SkillRow components:
     - Name (60 chars max)
     - Body preview (skill text)
     - "Delete" button (red)
     - Tap row → opens Editor for that skill
     - builtin: true for bundled skills

3. **Editor** (SkillsScreen.jsx:19-61)
   - Name input (max 60 chars)
   - Body textarea (max 900 chars)
   - Character counter:
     - If < 200 chars left: "[N] characters left — shorter instructions work better here" (warning)
     - Else: "[N] characters"
   - Buttons: Cancel, Save
   - Save disabled if name or body empty

4. **Import Tabs**
   - Three import methods:
     - **Paste SKILL.md**: textarea for markdown (parseSkillMarkdown)
       - Shows parsed name and character count
       - Refuses to add if too long (instead of truncating)
     - **Mac**: Connect to Mac via IP + token
       - Input: "Your Mac — 100.x.y.z:5834" + "Sharing token"
       - Fetches from Mac's /api/config endpoint
       - Shows skills with reason if they can't run on phone
       - "Take" button to import one skill
     - **New skill**: Inline editor (same as edit flow)

### State Management

- **Skills list**: `listSkills()` on mount + subscribe to `rx:skills-changed`
- **Seeded flag**: 'radiant.phone.skillsSeeded' (bundled skills added once)
- **Edit state**: which skill is open for editing

### Interactions & Events

1. **Create skill**:
   - Calls `saveSkill({ name, body })`
   - Generates random id if new

2. **Edit skill**:
   - Opens Editor with skill data
   - Calls `saveSkill({ id, name, body })` → updates existing

3. **Delete skill**:
   - Calls `deleteSkill(id)` → removes from list

4. **Import from Mac**:
   - Input: mac.base (IP:port or domain), mac.token
   - Calls `fetchMacSkills(base, token)` → GET [origin]/api/config
   - Shows error if: bad address, unauthorized (401/403), network error, no skills
   - Calls `saveMac(mac)` → SecureStore.set({ key: 'radiant.phone.mac', value: JSON.stringify({base, token}) })
   - Takes selected skills via saveSkill()

5. **Slash command usage** (skills.js:154-162):
   - In chat composer, `/skill-name message` 
   - parseSlash(body) extracts skill and remaining text
   - Model receives skill instruction at prompt head

### Native Calls

**SecureStore plugin**:
- `SecureStore.set({ key: 'radiant.phone.mac', value: JSON.stringify({base, token}) })`
- `SecureStore.get({ key: 'radiant.phone.mac' })` → { value: JSON.string }
- `SecureStore.remove({ key: 'radiant.phone.mac' })`

**Network**:
- fetch([mac.origin]/api/config, { headers: token ? {'x-radiant-token': token} : {} })

---

## SCREEN: READ ME (ReadMeScreen.jsx)

**Route**: `readme` | large: false | bg: grouped

Display: Static guide text in sections
- 17 sections describing features: onboarding, home, conversations, models, Hugging Face search, drafts, archiving, downloads, storage, cloud models, iPad layout, about, appearance, colors, text size, etc.
- Dynamically includes device name (iPhone vs iPad) via deviceWord()
- CompanyLine footer

---

## SHEET: FIRST RUN (FirstRun.jsx)

**Shown when**:
- !firstRunDone && catalogKnown && !downloaded.length && !cloudModel

**Controls**:
- "Start chat" button (enabled only if hasModel || appleReady)
- "Choose model" button
- Branding: BrandMark + Wordmark + CompanyLine + Templeton Technologies mark

**Actions**:
- "Start chat" → `onStartChat()` → openChat(activeModel?.id || downloaded[0]?.id || appleModel?.id)
- "Choose model" → `onChooseModel()` → presentSheet(null) then finishFirstRun()

**On dismiss**:
- Sets FIRSTRUN_KEY ('rx.firstRunDone') to '1'
- Navigates to home

---

## SHEET: GET MODEL (GetModelSheet.jsx)

**Triggered by**: Model list row tap or "Choose model" button

**Two Modes**:
1. **Picker** (model not downloaded) - large detent (92dvh):
   - ModelPicker component (full download flow)
   - Download progress gauge (26pt spinning)
   - Model details: name, size, speed category, memory requirement
   - "Download" button

2. **Detail** (model already downloaded) - medium detent (55dvh):
   - Gauge at rest (120pt)
   - NAME | SIZE / SPEED / NEEDS strip
   - "Start chatting" button → `onStartChat(model.id)`
   - "Remove" button (red) → `local.remove(model.id)` → close sheet

**Dragging Behavior**:
- Drag down to dismiss (velocity-based, 300pt/s or 40% of height)
- Drag release feedback: haptic("RIGID")
- ESscape key also dismisses

**Focus Management**:
- Focus enters sheet on next frame
- Tab wraps (first/last elements)
- Focus returns to opener on dismiss

---

## SHEET: CONSENT (ConsentSheet.jsx)

**Triggered by**: Saving first API key for a provider (if !hasConsent(provider.id))

**Content**:
- Title: "Send your messages to [Provider]?"
- Explanation: "You chose a model that runs on [Provider]'s servers, not on this device. To answer, Radiant has to send the conversation there."
- Three sections (rx-consent-list):
  - "What is sent": messages, images, replies
  - "Where it goes": [Provider]'s servers at [host], using your API key, under [Provider]'s policy (not Templeton)
  - "What is not sent": other chats, contacts, photos not attached, location

**Actions**:
- "Allow" button → `grantConsent(provider.id)` → saves timestamp → proceeds with key save
- "Not now" button → dismisses → key not saved
- Privacy policy link → opens PRIVACY_URL (https://www.templetongroup.dev/showcase/radiant/privacy.html)

**Stored**:
- Consent timestamp per provider in 'radiant.phone.cloudConsent': { [providerId]: ISO8601 timestamp }

---

## SHEET: CONTEXT MENU (ContextMenu in MobileShell.jsx)

**Chat Menu**:
1. "New conversation" → emitChatAction('new')
2. "Model info" → presentSheet(activeModel?.id)
3. "Delete conversation" (destructive) → emitChatAction('delete')

**Models Menu**:
1. "Remove all models · [used GB]" (if models downloaded, destructive) → loops through local.remove()

**Appearance**:
- Fullscreen scrim with tap-to-close
- Card at top-right (transformOrigin: 'top right')
- Blurred background (rx-shell-menu class)
- Animation: scale 0.92 in, ease-out 316ms, on prefers-reduced-motion: instant

---

## FIRST-RUN / ONBOARDING FLOW

**Entry**: App launch, check firstRunDone flag

1. **Resolve device**: Device plugin called to set device word (iPhone/iPad)
2. **Check Apple model**: AppleModel.availability()
3. **Load catalog**: LocalModels.list() → show models
4. **Show FirstRun cover** if:
   - !firstRunDone
   - catalogKnown (models.length > 0 || local.ready === true)
   - no models downloaded AND no cloud model chosen
5. **FirstRun actions**:
   - "Start chat" → open new conversation → mark firstRunDone
   - "Choose model" → show GetModelSheet picker → mark firstRunDone on close
6. **After FirstRun**: Navigate to home

---

## NAVIGATION SYSTEM (MobileShell.jsx:924-1093)

### Navigation API (passed to every screen)

```javascript
nav = {
  push(route, props)         // Add layer to stack
  pop()                      // Remove top layer
  replace(route, props)      // Replace top layer
  presentSheet(modelId)      // Show model sheet
  dismissSheet()             // Hide model sheet
  openChat(modelId, opts)    // Open/switch to chat (opts.fresh = new chat)
  depth: number              // Current stack depth
}
```

### Animation

- **Push**: Incoming from right (100% width), outgoing parallax left (−30%), dim 0.12 opacity
- **Pop**: Outgoing to right, incoming parallax to 0%, dim 0
- **Duration**: 350ms (reduced-motion: 200ms)
- **Easing**: cubic-bezier(.2,0,0,1) (iOS nav curve)

---

## STORAGE KEYS (localStorage)

All except 'radiant.phone.mac' stored in `localStorage`. Prefix 'radiant.phone.' groups all phone data for bulk operations.

| Key | Type | Format | Size Cap | Notes |
|-----|------|--------|----------|-------|
| `radiant.phone.chats` | JSON array | `[{ id, title, modelId, modelName, updatedAt, archived, messages: [] }]` | 40 chats (unarchived) + unlimited archived | Newest first, trimmed, archived exempt from cap |
| `radiant.phone.drafts` | JSON object | `{ [chatId]: { text, at: timestamp } }` | 40 drafts | Drafts of unsent messages, newest-first ordering |
| `radiant.phone.appearance` | JSON object | `{ themeId, textScale, mode, openTo }` | Single entry | Theme color, text multiplier, dark/medium/light/system, home/chat on launch |
| `radiant.phone.cloudModel` | JSON object | `{ providerId, model }` or null | Single entry | Last chosen cloud model |
| `radiant.phone.skills` | JSON array | `[{ id, name, body, builtin?: true }]` | Unlimited | User-created + bundled skills |
| `radiant.phone.skillsSeeded` | String '1' | '1' or undefined | Flag | Records that bundled skills have been installed |
| `radiant.phone.cloudConsent` | JSON object | `{ [providerId]: ISO8601 timestamp }` | Unlimited | Consent timestamp per provider (when key was first saved) |
| `radiant.phone.ratingAsked` | String '1' | '1' or undefined | Flag | Records that app rating was requested (once per app lifetime) |
| `rx.activeModel` | String (model id) | Model id or null | Single | Currently selected local model (persisted across launches) |
| `rx.firstRunDone` | String '1' | '1' or undefined | Flag | Marks first-run screen as shown |

**Also in SecureStore (Keychain)**:
| Key | Type | Format | Notes |
|-----|------|--------|-------|
| `radiant.phone.mac` | JSON string | `{ base: string, token: string }` | Mac connection credentials (legacy localStorage migration supported) |
| `[provider.id]` (per provider) | String | API key (never read back) | Anthropic, OpenAI, etc. keys stored in Keychain by SecureStore plugin |

---

## NATIVE PLUGIN CALLS

### LocalModels

Used in: **useLocalModels.js** (primary), ModelsScreen.jsx, SettingsScreen.jsx, ModelPicker.jsx, MobileChat.jsx, ChatScreen.jsx, device.js

| Method | Input | Output | Usage |
|--------|-------|--------|-------|
| `list()` | - | `{ id, name, maker, blurb, sizeGB, downloaded, apple }[]` | Catalog on mount (ModelsScreen, useLocalModels) |
| `downloaded()` | - | Same shape as list, only downloaded | Downloaded models with state info |
| `diskInfo()` | - | `{ usedBytes, freeBytes }` | Storage gauge (StorageLine.jsx) |
| `download({ id })` | `{ id: string }` | Emits events | Start download, subscribe to progress |
| `cancelDownload({ id })` | `{ id: string }` | Resolves | Stop active download |
| `remove({ id })` | `{ id: string }` | Resolves | Delete downloaded model |
| `addCustom({ name, url })` | `{ name, url }` | Resolves to new model | Add Hugging Face model from search |
| `removeCustom({ id })` | `{ id: string }` | Resolves | Remove HF-added model |
| `generate({ modelId, prompt })` | `{ modelId, prompt: string }` | Stream tokens, emit rx:token | Send message to local model (MobileChat.jsx) |
| `stop()` | - | Resolves | Stop active generation |
| `deviceInfo()` | - | `{ cores, memoryGB, platform }` | Device specs (DeviceSpecs.jsx, device.js) |
| `diagnose()` | - | Diagnostic info | Troubleshooting |

**Events**:
- `download-progress`: `{ id, pct: 0–1, state: 'downloading' | 'preparing' }`
- `rx:token`: Token stream from generation

### ProviderChat

Used in: **providers.js**, MobileChat.jsx, ProvidersScreen.jsx

| Method | Input | Output | Usage |
|--------|-------|--------|-------|
| `models({ provider, baseUrl })` | `{ provider: string, baseUrl: string }` | `{ models: string[] }` | Fetch model list from vendor API |
| `send({ provider, model, messages, apiKey })` | Full message object | Stream tokens, emit rx:token | Send to cloud model (MobileChat.jsx) |
| `stop()` | - | Resolves | Stop active generation |

**Events**:
- `rx:token`: Token stream from generation

### AppleModel

Used in: **appleModel.js**, MobileChat.jsx, ModelsScreen.jsx

| Method | Input | Output | Usage |
|--------|-------|--------|-------|
| `availability()` | - | `{ available: bool, reason: string }` | Check if Apple Intelligence available (called once per launch in MobileShell) |
| `send({ prompt, instructions })` | `{ prompt, instructions }` | Full response (not streamed) | Send message to Apple model |
| `stop()` | - | Resolves | Stop active generation |

### SecureStore

Used in: **providers.js**, skills.js, ProvidersScreen.jsx, SkillsScreen.jsx

| Method | Input | Output | Usage |
|--------|-------|--------|-------|
| `keys()` | - | `{ keys: string[] }` | List provider IDs that have keys stored |
| `set({ key, value })` | `{ key, value: string }` | Resolves | Save API key or Mac token |
| `get({ key })` | `{ key: string }` | `{ value: string }` | Retrieve stored value (only for Mac token in readMac) |
| `remove({ key })` | `{ key: string }` | Resolves | Delete stored key |

### Haptics

Used in: **haptics.js**, MobileShell.jsx, and component usePress helpers

| Method | Input | Output | Usage |
|--------|-------|--------|-------|
| `impact({ style })` | `{ style: 'LIGHT' | 'MEDIUM' | 'RIGID' }` | Resolves | Tap feedback (wrap with try/catch) |
| `notification({ type })` | `{ type: 'SUCCESS' | 'WARNING' | 'ERROR' }` | Resolves | Completion feedback |
| `selectionStart()` | - | Resolves | Haptic selection start |
| `selectionChanged()` | - | Resolves | Haptic selection mid-drag |
| `selectionEnd()` | - | Resolves | Haptic selection end |

### StatusBar

Used in: **theme.js** (syncNativeChrome)

| Method | Input | Output | Usage |
|--------|-------|--------|-------|
| `setStyle({ style })` | `{ style: 'DARK' | 'LIGHT' }` | Resolves | Set status bar text color (DARK = light text for dark bg) |

### Keyboard

Used in: **MobileShell.jsx** (keyboard metrics), HuggingFaceSearch.jsx

| Method | Input | Output | Usage |
|--------|-------|--------|-------|
| `hide()` | - | Resolves | Close keyboard (after image selection) |
| **Events** | - | - | - |
| `keyboardWillShow` | `{ keyboardHeight, duration }` | - | Lift focused field above keyboard (MobileShell) |
| `keyboardDidShow` | `{ keyboardHeight, duration }` | - | Same as above, for safety |
| `keyboardWillHide` | `{ duration }` | - | Restore layout when keyboard closes |

**Used in MobileShell.jsx:302-327** to set `--rx-kb` CSS variable (keyboard height) and `rx-kb-open` class for padding.

### Device

Used in: **device.js**

| Method | Input | Output | Usage |
|--------|-------|--------|-------|
| `getInfo()` | - | `{ platform, osVersion, osRelease, name, model, manufacturer, isVirtual, memoryUsed, memoryAvailable, diskFree, diskTotal }` | Device specs (shown in ModelsScreen hero, used for deviceWord) |

### Browser

Used in: **ConsentSheet.jsx**, SettingsScreen.jsx, CompanyLine.jsx

| Method | Input | Output | Usage |
|--------|-------|--------|-------|
| `open({ url })` | `{ url: string }` | Resolves | Open URL in system browser (fallback to window.open if unavailable) |

### NativePreview

Used in: **HomeScreen.jsx**, nativePreview.js

| Method | Input | Output | Usage |
|--------|-------|--------|-------|
| `available()` | - | `{ available: bool }` | Check if SwiftUI preview build is available |
| `open()` | - | Resolves | Launch native preview (shares chats and models via allChats()) |

### AppRating

Used in: **rating.js**

| Method | Input | Output | Usage |
|--------|-------|--------|-------|
| `request()` | - | Resolves or rejects | Trigger app store rating prompt (max once per app lifetime, configurable by OS) |

**Called conditionally**:
- After conversation with 6+ turns
- Only once app-wide (checked via 'radiant.phone.ratingAsked')
- Never blocks or branches if unavailable

---

## ACCESSIBILITY FEATURES

### Dynamic Type

**Implemented in MobileShell.jsx:184-235** (`useDynamicType` hook):
- Measures system text size at launch and on resize
- Probes `-apple-system-body` font size (17px baseline on this build)
- Calculates multiplier: `systemSize / 17 * userScale`
- Range: 0.82–2.0x
- Sets `--rx-dt` CSS variable (used in every hand-set size rule)
- Sets `data-ax="true"` on root if > 1.2x for accessibility reflow

### Keyboard Navigation

**usePress hook** (usePress.js) used throughout:
- All buttons/controls via `usePress()` with proper aria-label
- Label includes: action + current state + disabled reason
- Tap feedback: haptic on release (not press)
- Slop detection: 10pt threshold

### ARIA

- Section headers: `<h1>` / `<h2>` with class="rx-section-header"
- Section footers: `<p>` with class="rx-section-footer"
- Role="button" for styled controls
- aria-label on all icon buttons
- aria-hidden on decorative elements (glows, gauges)
- aria-expanded on collapsible toggles (archive section)
- aria-disabled on unavailable controls
- aria-modal="true" on sheets
- Focus management in sheets (wrap Tab, Escape closes)
- Live region for token stream in chat (implied via stream updates)

### iPad Layout

**MobileShell.jsx:110-121**:
- Breakpoint: 768px wide
- `--rx-measure: 700px` reading measure
- Shell scroller padded inline: `max(0, (100% - measure) / 2)`
- All content stays at same inset as on phone (20pt)
- No responsive breakpoints for individual screens—width handles it

---

## VISUAL DESIGN PATTERNS

### Theme System

**theme.js** defines:
- THEMES: 13 color themes (hue + chroma, or pinned palettes for everforest, templeton, nousclassic)
- TEXT_SIZES: 4 scale multipliers (0.92–1.2x)
- MODES: 4 mode options (dark, medium, light, system)
- OPEN_TO: launch target (home or last chat)

Applied via:
- CSS variables: `--rx-accent-h`, `--rx-accent-c`, `--rx-tint`, `--rx-bg`, etc.
- `data-rx-mode` attribute on root (dark|medium|light|system)
- `data-rx-system` attribute (dark|light) for system preference
- `data-rx-dark` attribute (true|false) computed for native status bar

### Press State

Inline styles in MobileShell.jsx:154-158:
- `.rx-shell-barbtn[data-pressed="true"]`: opacity 0.35
- `.rx-shell-row[data-pressed="true"]`: background-color fill 0.2
- Transition: 322ms ease-out on entry, none on exit (instant)

### Sheet Animation

MobileShell.jsx:1319-1326:
- Stack scales to 0.92, borderRadius 10
- Scrim dims to opacity 0.35
- Duration: 414ms, easing: ease-out
- Reduced-motion: no scale/radius change

### Large Title

MobileShell.jsx:563-586:
- Rendered by shell in scroller
- Opacity + transform: translateY continuously updated on scroll
- Parallax: (1 - progress) * 4px
- Crossfade with inline title in bar

### Gauge Component (Gauge.jsx)

- Three concentric rings (A, B, C strokes)
- Rotates while downloading (motion feedback)
- Static at rest (viewing completed download)
- Size: 26pt (downloading), 96pt (hero), 120pt (sheet), 128pt (first-run)
- Follows theme color via CSS filter

---

## NETWORK ACCESS

### Requests Made by App

1. **Hugging Face Search** (hf.js)
   - `https://huggingface.co/api/models?search=[query]&…`
   - Fetches model metadata from HF catalog

2. **Provider Model List** (providers.js:92-96)
   - Vendor API (e.g., https://api.openai.com/v1/models)
   - Sent via ProviderChat plugin (keys never touch web layer)

3. **Mac Skills** (skills.js:285-303)
   - `http://[mac.base]/api/config`
   - Header: `x-radiant-token: [token]` (if token provided)
   - Fetches skill list from paired Mac

4. **Privacy Policy** (ConsentSheet.jsx:10)
   - https://www.templetongroup.dev/showcase/radiant/privacy.html
   - Opened in system browser (not in-app)

5. **Company Website** (CompanyLine.jsx)
   - https://www.templetontech.com/
   - Opened in system browser (not in-app)

### All Generation Calls

- **Local models**: LocalModels plugin handles entirely on-device
- **Cloud models**: ProviderChat plugin sends to vendor server (using user's own API key)
- **Apple Intelligence**: AppleModel plugin handles entirely on-device

No telemetry, no analytics, no calls home to Templeton Technologies backend.

---

## BUILD & VERSION

**Version Info** (MobileShell.jsx:1216-1221):
- `__APP_VERSION__`: injected at build time (e.g., "0.6.177")
- `buildNumber()`: iOS build number, called via Device plugin info
- Displayed in Settings → About: "0.6.177 (3)"

---

## EDGE CASES & ERROR HANDLING

### No Model / No Connection

- Home offers "No model yet" with button to choose
- Chat shows message above composer: "No model to answer yet · Choose model"
- FirstRun shows "Choose model" button (primary if no model)

### Disk Full

- ModelRow shows FITS_NO verdict (red)
- aria-label: "not enough room"
- Download is still possible but will fail (honest about limits)

### Download Interrupted

- Partial download stays on device
- Restarting picks up from byte offset
- Stop button changes to download arrow until restarted

### Keychain Unavailable (before first unlock)

- `saveMac()` throws (not fallback to localStorage)
- SkillsScreen shows error: "Connected, but the token could not be stored securely"
- User must unlock and try again

### Provider Refused / Bad Key

- ProviderChat.models() error shown directly: "Could not reach this provider"
- User's error feedback loop (remove key, re-add, see real error)

### Conversation Cap Reached

- 40 unarchived chats max
- Oldest silently dropped on save of 41st
- Archived chats never dropped
- Archiving is the ONLY way to keep beyond 40

### Draft Orphan Adoption

- New chat gets fresh id every time
- Draft of abandoned new chat (typed, left to get model, never sent)
- adoptDraft() gives newest orphan to next new chat
- Non-abandoned chat drafts stay with their conversation

---

## TESTING SEAMS / CONSTANTS

**rating.js**:
- RATING_KEY = 'radiant.phone.ratingAsked' (export for test)
- RATING_MIN_TURNS = 6

**chats.js**:
- MAX = 40 chats
- MAX_TURNS = 200 messages per chat

**drafts.js**:
- MAX = 40 drafts

**skills.js**:
- MAX_SKILL_CHARS = 900
- BUNDLED = 5 seeded skills

**fit.js**:
- FIT_LABEL / FITS_* verdicts (green/amber/red)
- ramNeededGB calculations

---

## SUMMARY: EVERY STORAGE KEY

localStorage (phone-local, lost if app deleted):
- radiant.phone.chats
- radiant.phone.drafts
- radiant.phone.appearance
- radiant.phone.cloudModel
- radiant.phone.skills
- radiant.phone.skillsSeeded
- radiant.phone.cloudConsent
- radiant.phone.ratingAsked
- rx.activeModel
- rx.firstRunDone

SecureStore/Keychain (persists through backup, protected by device lock):
- radiant.phone.mac (shared Mac token)
- [provider.id] × N (one per connected provider: anthropic, openai, openrouter, xai, nousresearch, deepseek, moonshot, zai, minimax, groq, mistral)

---

## SUMMARY: EVERY CAPACITOR PLUGIN

Used:
- LocalModels (core download/generation)
- ProviderChat (cloud model inference)
- AppleModel (on-device Apple Intelligence)
- SecureStore (API keys in Keychain)
- Haptics (tap feedback)
- StatusBar (color bar text)
- Keyboard (metrics, hide on image select)
- Device (specs, device name)
- Browser (open external URLs)
- NativePreview (SwiftUI preview launch)
- AppRating (app store rating prompt)

