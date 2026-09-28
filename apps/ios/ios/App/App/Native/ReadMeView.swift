import SwiftUI

/// The phone's Read me. It must only describe what is built: when a feature
/// lands, add it here in the same change. "\(d)" is iPhone or iPad.
enum ReadMe {
    static func sections(_ d: String) -> [(title: String, body: [String])] { [
        ("One design", [
            "Radiant now has a single design, built the way iOS apps are built. Your conversations, models, keys, skills and settings all carried over — nothing to move and nothing to set up again.",
            "“Use the current design” is gone, because there is no second design to go back to."
        ]),
        ("A model on your \(d)", [
            "Radiant downloads an open AI model onto this phone and runs it here. There is no account, and once a model has finished downloading it works with no signal at all — on a plane, underground, anywhere.",
            "A model running on the phone answers without a network, and nothing you send it leaves the device. If you add a cloud model in Settings → Cloud models, chats you send to THAT model go to that company — the name under every chat title tells you which of the two is answering."
        ]),
        ("An Uncensored shelf", [
            "The model list has a new shelf called Uncensored: eleven models with their refusals removed, from Dolphin 3 and Josiefied Qwen 3 to Hermes 3 and two Heretic builds. They answer questions other models turn down. Each one was downloaded and tested before it was added.",
            "You could always find models like these with the Hugging Face search. Now the best-tested ones are on the list itself, next to everything else."
        ]),
        ("Jev Router, at the top of OpenRouter", [
            "With an OpenRouter key, the first model in its list is now Jev Router. Choose it and each message goes to whichever model Jev judges best for it — a quick question to a fast one, a hard one to a strong one — so you do not have to pick."
        ]),
        ("Sign in with ChatGPT, Grok, Copilot, Qwen or Nous", [
            "Cloud models now opens with “Sign in with a subscription”: ChatGPT (Plus / Pro), Grok (SuperGrok / Premium+), GitHub Copilot, Qwen and Nous Portal. Sign in once and you can chat with that service’s models using the plan you already pay for — no API key. GitHub Copilot alone brings GPT, Claude and Gemini models.",
            "ChatGPT opens its own sign-in page and returns you to Radiant when you are done. The others open a page in Safari with a short code already filled in; confirm it there, then come back to Radiant and it finishes by itself — it keeps waiting even if the connection drops while you are away, which used to end Grok and Nous sign-ins with “The network connection was lost”. Your sign-in stays in this phone’s Keychain, and Sign out removes it.",
            "This uses the same sign-in as each company’s own command-line tools, not an official way in, so a company can change or stop it at any time. Claude subscriptions are not offered, because Anthropic only allows them in its own apps; a Claude API key still works."
        ]),
        ("Radiant follows your colors", [
            "Radiant follows the appearance you picked in Settings — dark, medium, light or system — and only follows the phone’s own light or dark mode when you choose System.",
            "Home has the Radiant logo and name at the top, with a greeting for the time of day, the model a new chat will use, and “Radiant is a Templeton Technologies product” at the foot of the list. The logo and name take the color you picked in Settings.",
            "While a model downloads, the Radiant logo turns beside its name, with a plain stop square on the right.",
            "Hugging Face search no longer says “Runs well” for draft models. A draft model is a small helper that speeds up a bigger one; it cannot hold a conversation, and downloading one ended in an error about a missing key. They are now marked “Won’t run” before you download anything."
        ]),
        ("Finding your way around", [
            "Home lists your conversations, which you can search and swipe left to archive or delete. A chat has the model’s name at the top — tap it to switch models.",
            "In a chat, the slash button picks a skill (or type / and its name), and the plus adds a photo when the model can see. The gear on Home opens Settings, Models, Skills, Cloud models and this Read me. Models shows what is on this \(d), every model by maker with whether it runs here, downloads you can stop, and Hugging Face search. Settings holds all thirteen colors, dark, medium, light or system, text size, and where Radiant opens — and a new color takes effect as you tap it."
        ]),
        ("Fourteen new models, listed A to Z", [
            "The list grew by fourteen: MiniCPM 5 in 1B and 2B, Qwen 3.5 0.8B, Qwen 2.5 Coder 7B for code, Granite 4.2 in 3B and 8B, LFM2.5 VL 3B (it reads photos), LFM2.5 8B, GLM 4 9B and Nanbeige 4.2 3B. Four more reason before they answer: Qwen 3 4B Thinking, DeepSeek R1 0528 8B, LFM2.5 1.2B Thinking and Jamba Reasoning 3B. Every one was downloaded and asked a question before it was added.",
            "Makers are now listed A to Z, and so are the models inside each one, so you can find a model by its name. Before, the makers with the most models came first, which was hard to follow.",
            "Nemotron 3 Nano 4B works now. It used to download all 2 GB and then fail with “Failed to parse config.json”, because the engine that runs models on the phone expected settings that only NVIDIA’s much larger Nemotron has. That is fixed in this version.",
            "Models that reason before they answer, like DeepSeek R1, used to show their reasoning and a stray “</think>” before the answer. Now you see “thinking…” by the name while they work, and then only the answer.",
            "The model list can now change without an App Store update, so a model that stops working can be taken off, and new ones added, within minutes."
        ]),
        ("Follow-ups start faster, and no thinking out loud", [
            "The model now keeps its memory of the conversation between messages instead of re-reading the whole chat before every reply. The first message in a chat takes what it always took; the ones after it start almost at once, however long the chat has grown. A stopped or failed reply, a change of model or a change of skill clears that memory, and the next message rebuilds it.",
            "Models that think before they answer used to show all of it — paragraphs of “the user wants… let me consider…” before one line of reply. Qwen 3 is now told not to, and any model that thinks anyway shows a small “thinking…” by its name until the answer starts. The deliberation is never shown or kept."
        ]),
        ("The icons are the ones iOS uses", [
            "The gear, the back arrow, the ⋯ menu, the download circle, the tick, the send arrow and the rest are now the same symbols iOS itself draws, at the same weights, so they sit next to the system’s own icons without looking a little off. They follow the text color, so they read correctly in light and dark."
        ]),
        ("Home", [
            "The first time you open Radiant, a welcome screen offers two ways in: start a chat, or choose a model.",
            "After that, Home is where the app opens: the logo, a greeting, the model a new chat will use, and the conversations you have had, newest first. Tap one to pick it up where you left off; the new-chat button starts another.",
            "If you would rather land straight back in the last thing you were saying, Settings → Open to will do that instead."
        ]),
        ("Your conversations", [
            "Every conversation is kept, named after the first thing you asked, and listed on Home. They stay on the phone — they are not synced anywhere and nobody else can read them.",
            "Inside a chat, the ⋯ menu deletes the one you are in."
        ]),
        ("Choosing a model", [
            "There are seventy-eight to choose from, grouped by who made them — Google, Meta, Mistral, Microsoft, IBM, Alibaba, Apple, NVIDIA and more. The makers are in alphabetical order, and so are the models inside each one. Tap a name to open that shelf; tap it again to close it. Eight of them can look at pictures, and one of those can watch a short clip.",
            "Every model is labeled for THIS \(d). Green runs well. Amber runs, but close to the limit — expect it to be slow, and to reload when you switch apps. Red is not expected to load at all. The label is guidance, not a lock: you can still download a red model and try it.",
            "That label is about memory, not storage, and they are different questions: a phone can easily have room for a file it cannot then run. Bigger models answer better and use more battery. Qwen 3 1.7B is a good place to start on any recent \(d).",
            "The bar at the top of Models shows how much storage your models take and how much is left on this \(d)."
        ]),
        ("Finding more on Hugging Face", [
            "Models has a Search Hugging Face row near the top. Type a name — “llama 3.2”, “qwen 4bit”, “gemma” — and Radiant searches Hugging Face for models in the format it runs. Each result is checked before you download it: whether the engine can load that kind of model, whether its weights are what its description says, and whether it fits the memory of this \(d). Then it gets the same green, amber or red label as the built-in list, or a plain reason it cannot run.",
            "Download shows the same turning logo and progress as the built-in list, and once it finishes the model sits under On this \(d) with the others, ready to chat with or remove. The search is not filtered: anything published in a format Radiant can run will show up, including uncensored and abliterated builds. These are models other people have made, and a model with its safety training removed will say anything — read its page on Hugging Face if you want to know what it is."
        ]),
        ("What you type is kept", [
            "Start writing a message, leave the chat to do something else, and it is still in the box when you come back. Nothing is sent until you tap the arrow.",
            "That matters most when there is no model yet. A conversation opens whether or not anything can answer it, and says so, with the model menu at the top to choose one. Write your message first if you like — go pick a model or start a download, and your sentence is waiting for you on this \(d) when you return."
        ]),
        ("Keeping a conversation", [
            "Swipe a conversation left on Home and you get two buttons: Archive and Delete. Nothing happens from the swipe alone; it is always a tap on one of them. Archive puts a conversation under an Archived heading at the foot of the list, folded away until you tap it. Swipe an archived one to restore it.",
            "That is worth knowing because the phone keeps the last forty conversations and quietly drops the oldest to make room. An archived one is never dropped, so archiving is how you keep something rather than just tidy it away."
        ]),
        ("Stopping a download", [
            "Tap the stop square beside a download to stop it. Whatever has already downloaded stays on the phone, so starting again picks up from there rather than beginning again.",
            "Downloads do not yet continue while the app is in the background — leave Radiant open until one finishes."
        ]),
        ("Freeing up space", [
            "Settings lists every model on this \(d) and how much space it takes, with the total at the top. Each one has its own Remove button, which asks before it deletes anything; Remove all models clears them at once. You can also swipe a model left in Models. Removing a model does not delete your conversations."
        ]),
        ("Models in the cloud", [
            "Settings → Cloud models connects Radiant to Anthropic, OpenAI, OpenRouter, xAI, Nous, DeepSeek, Kimi, GLM, MiniMax, Groq or Mistral with your own API key. That is how to reach the models too large to run on a phone.",
            "Add a key, search that provider's models, and tap one. It becomes the model answering your chats, and the top of Cloud models says so, with a Start chat button. The name at the top of every chat tells you which model is replying, and tapping that name switches between it and the models on your \(d). If a search finds nothing, it says so.",
            "Your key is held in the \(d) Keychain, kept apart from the rest of the app’s data, and never shown again after you enter it. These requests do go over the network, unlike a model running on the phone."
        ]),
        ("On an iPad", [
            "Radiant is one app for both. On an iPad it says iPad, sizes itself for the bigger screen instead of stretching the phone layout across it, and everything else — your models, your conversations, your colors — works exactly the same way."
        ]),
        ("Who makes this", [
            "Radiant is a Templeton Technologies product. That line sits at the foot of Home, of Settings and of this guide — tap it and it opens templetontech.com in Safari, so you can see whose app this is. Settings → About also opens the privacy policy in Safari."
        ]),
        ("How it looks", [
            "Settings → Appearance chooses Dark, Medium, Light, or System — Medium is dark without the true black, and System follows your phone. Radiant opens dark unless you change it.",
            "Settings → Color carries the same themes as the Mac app, including Templeton — the sage green and warm tan one. The color runs through everything: buttons, the logo and name on Home, and the logo that turns while a model downloads.",
            "Settings → Text size sets the size of everything on top of whatever you have chosen in iOS Settings, so you can make Radiant larger without changing every other app."
        ]),
    ] }
}

struct ReadMeView: View {
    @Environment(\.rx) private var rx
    private let device = Device.word

    var body: some View {
        List {
            ForEach(ReadMe.sections(device), id: \.title) { s in
                Section {
                    ForEach(s.body, id: \.self) { p in Text(p).font(.body).foregroundStyle(rx.label).padding(.vertical, 2) }
                } header: { Text(s.title).font(.headline).foregroundStyle(rx.label).textCase(nil) }
                .listRowBackground(rx.cell)
            }
            Section {
                Link(destination: URL(string: "https://templetontech.com")!) {
                    (Text("Radiant is a ").foregroundStyle(rx.label2) + Text("Templeton Technologies").foregroundStyle(rx.tintText) + Text(" product.").foregroundStyle(rx.label2))
                        .font(.caption2).frame(maxWidth: .infinity)
                }
                .accessibilityLabel("Radiant is a Templeton Technologies product. Opens templetontech.com.")
            }.listRowBackground(Color.clear)
        }
        .scrollContentBackground(.hidden).readingWidth().background(rx.grouped)
        .navigationTitle("Read me")
    }
}
