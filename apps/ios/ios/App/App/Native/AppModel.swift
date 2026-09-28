import SwiftUI
import UIKit

/// The native app's state: the store, the models you can talk to, and the reply
/// in flight. Every screen reads from this one object.
@MainActor
final class AppModel: ObservableObject {
    let kv: KV
    let engine: LocalModels

    @Published private(set) var chats: [Chat] = []
    @Published private(set) var localModels: [LocalModels.OnDevice] = []
    @Published var streaming: String? = nil      // chat id with a reply in flight
    @Published var live = ""                     // raw text of that reply
    @Published var tokensPerSecond: Int? = nil
    @Published var pendingConsent: Provider? = nil
    /// A chat whose held message went out when consent was given, so its screen clears the composer.
    @Published var sentFromHold: String? = nil

    private var appleTask: Task<Void, Never>?
    private var cloudTask: Task<Void, Never>?
    private var session: (chatId: String, modelId: String, skill: String, count: Int)?
    private var stopped = false
    private var firstAt: Date?, chunks = 0
    /// The message a consent sheet is holding back (MobileChat.jsx consentAsk).
    private var held: (provider: String, chatId: String, raw: String, photo: Data?)?

    init(kv: KV, engine: LocalModels) {
        self.kv = kv
        self.engine = engine
        Self.migrateLegacy(kv)
        reload()
    }

    /// The one transcript the old build kept, `rx.chat.transcript`, brought across once (ChatScreen.jsx).
    private static func migrateLegacy(_ kv: KV) {
        let legacy = "rx.chat.transcript"
        guard kv.string(legacy) != nil else { return }
        let msgs = (kv.json(legacy) as? [[String: Any]] ?? []).enumerated().compactMap { Msg($1, index: $0) }
        if !msgs.isEmpty {
            ChatStore.save(kv, Chat(id: ChatStore.newId(), title: ChatStore.title(msgs), modelId: nil, modelName: nil, skillId: nil,
                                    archived: false, updatedAt: Date().timeIntervalSince1970 * 1000, messages: msgs))
        }
        kv.set(legacy, string: nil)
    }

    func reload() {
        // a new chat lives only here until its first message; a reload must not drop the one on screen
        let unsaved = chats.filter { $0.messages.isEmpty }
        let saved = ChatStore.all(kv)
        chats = saved + unsaved.filter { u in !saved.contains { $0.id == u.id } }
        localModels = engine.downloadedOnDevice()
    }

    var appearance: Appearance { Appearance(kv.json(Appearance.key)) }
    var skills: [Skill] { Skills.all(kv) }

    // MARK: models

    /// Everything a chat can switch to: the downloaded models, Apple's, and the chosen cloud model.
    var options: [ModelOption] {
        var out = localModels.map { ModelOption(id: $0.id, name: $0.name, maker: $0.maker, thinks: $0.thinks, vision: $0.vision) }
        if let a = AppleLM.option { out.insert(a, at: 0) }
        if let c = Providers.chosen(kv) {
            out.insert(ModelOption(id: "cloud:\(c.providerId):\(c.model)", name: Providers.shortName(c.model),
                                   maker: Providers.byId(c.providerId)?.name ?? c.providerId), at: 0)
        }
        return out
    }

    func option(_ id: String?) -> ModelOption? { options.first { $0.id == id } }

    /// The model a new chat uses. A chosen cloud model wins over the on-device
    /// one, exactly as MobileChat decides.
    var currentModelId: String? {
        if let c = Providers.chosen(kv) { return "cloud:\(c.providerId):\(c.model)" }
        if let a = kv.string("rx.activeModel"), option(a) != nil { return a }
        return options.first?.id
    }

    /// Pick a model. Choosing a phone model clears the cloud choice (onSwitchModel).
    func choose(_ id: String) {
        switch ModelRef(id: id) {
        case .cloud(let p, let m): Providers.setChosen(kv, (p, m))
        default:
            Providers.setChosen(kv, nil)
            kv.set("rx.activeModel", string: id)
        }
        objectWillChange.send()
    }

    // MARK: chats

    func chat(_ id: String) -> Chat? { chats.first { $0.id == id } }

    /// A conversation with no messages is never saved (chats.js) and Home never
    /// lists it; older empty ones are dropped so they do not pile up in memory.
    func newChat() -> String {
        let id = ChatStore.newId()
        let m = option(currentModelId)
        chats.removeAll { $0.messages.isEmpty && $0.id != streaming }
        chats.insert(Chat(id: id, title: "New chat", modelId: m?.id, modelName: m?.name, skillId: nil,
                          archived: false, updatedAt: Date().timeIntervalSince1970 * 1000, messages: []), at: 0)
        return id
    }

    /// Opening a model from Models reopens the most recent conversation with it,
    /// or starts one if there is none (MobileShell.jsx openChat, ChatScreen.jsx).
    func openChat(forModel modelId: String) -> String {
        localModels = engine.downloadedOnDevice()   // it may have just finished downloading
        choose(modelId)
        guard let c = chats.first(where: { !$0.archived && !$0.messages.isEmpty }) else { return newChat() }
        setModel(c.id, modelId)
        return c.id
    }

    func delete(_ id: String) { ChatStore.delete(kv, id); chats.removeAll { $0.id == id } }

    func setArchived(_ id: String, _ archived: Bool) {
        ChatStore.setArchived(kv, id, archived)
        if let i = chats.firstIndex(where: { $0.id == id }) { chats[i].archived = archived }
    }

    func setModel(_ chatId: String, _ modelId: String) {
        guard let i = chats.firstIndex(where: { $0.id == chatId }), let m = option(modelId) else { return }
        chats[i].modelId = m.id; chats[i].modelName = m.name
        choose(m.id)
        if !chats[i].messages.isEmpty { ChatStore.save(kv, chats[i]) }
    }

    func setSkill(_ chatId: String, _ skillId: String?) {
        guard let i = chats.firstIndex(where: { $0.id == chatId }) else { return }
        chats[i].skillId = skillId
        if !chats[i].messages.isEmpty { ChatStore.save(kv, chats[i]) }
    }

    // MARK: replies

    /// Returns false when nothing was sent (no model yet, or a cloud provider
    /// still needs your OK) — so the screen keeps what you typed.
    @discardableResult
    func send(_ chatId: String, _ raw: String, photo: Data? = nil) -> Bool {
        guard streaming == nil, let i = chats.firstIndex(where: { $0.id == chatId }) else { return false }
        let parsed = Skills.parseSlash(raw, skills)
        let body = parsed.text
        guard !body.isEmpty, let m = option(chats[i].modelId) ?? option(currentModelId) else { return false }
        // a cloud provider sees your words only after you have said it may
        if case .cloud(let p, _) = ModelRef(id: m.id), !Providers.hasConsent(kv, p) {
            held = (p, chatId, raw, photo)
            pendingConsent = Providers.byId(p)
            return false
        }
        chats[i].modelId = m.id; chats[i].modelName = m.name
        let skill = parsed.skill ?? skills.first { $0.id == chats[i].skillId }
        let instructions = skill?.body ?? ""
        let history = chats[i].messages
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        chats[i].messages.append(Msg(id: "u\(stamp)", role: "user", text: body))
        chats[i].title = ChatStore.title(chats[i].messages)
        chats[i].updatedAt = Double(stamp)
        ChatStore.save(kv, chats[i])
        Drafts.save(kv, chatId, "")
        streaming = chatId; live = ""; stopped = false
        firstAt = nil; chunks = 0; tokensPerSecond = nil
        Haptic.tap()

        let onToken: (String) -> Void = { chunk in Task { @MainActor in self.token(chatId, chunk) } }
        let onEnd: (Error?) -> Void = { e in Task { @MainActor in self.finish(chatId, m, instructions: instructions, error: e) } }

        switch ModelRef(id: m.id) {
        case .local(let id):
            let reuse = session.map { $0.chatId == chatId && $0.modelId == id && $0.skill == instructions && $0.count == history.count } ?? false
            let prompt = reuse ? body : Prompt.build(history, next: body, instructions: instructions, inline: false)
            engine.startTurn(modelId: id, prompt: prompt, conversation: chatId, reset: !reuse,
                             instructions: instructions, imageJPEG: m.vision ? photo : nil, onToken: onToken, onEnd: onEnd)
        case .apple:
            let prompt = Prompt.build(history, next: body, instructions: instructions, inline: false)
            appleTask = Task {
                do { try await AppleLM.stream(prompt, instructions: instructions) { snap in
                        Task { @MainActor in if self.streaming == chatId { self.live = snap; self.chunks += 1; if self.firstAt == nil { self.firstAt = Date() } } } }
                     onEnd(nil)
                } catch { onEnd(error) }
            }
        case .cloud(let p, let model):
            let provider = Providers.byId(p)
            let messages = Prompt.cloudMessages(history, next: body, instructions: instructions)
            cloudTask = Task {
                do { try await CloudStream.stream(provider: p, baseUrl: provider?.baseUrl ?? "", model: model, messages: messages, onToken: onToken)
                     onEnd(nil)
                } catch { onEnd(error) }
            }
        }
        return true
    }

    /// "Allow" on the consent sheet: finish sending what it held back (MobileChat.jsx onAllow).
    // TODO(wire): NativePreview ConsentSheet Allow must call app.consentGranted
    func consentGranted(_ providerId: String) {
        Providers.grantConsent(kv, providerId)
        guard let h = held, h.provider == providerId else { return }
        held = nil
        if send(h.chatId, h.raw, photo: h.photo) { sentFromHold = h.chatId }
    }

    private func token(_ chatId: String, _ chunk: String) {
        guard streaming == chatId else { return }
        live += chunk
        chunks += 1
        // timed from the first token, not the tap: loading and reading the prompt are not generation
        if firstAt == nil { firstAt = Date() }
        let secs = Date().timeIntervalSince(firstAt ?? Date())
        // tok/s only if a chunk really is a token, as MobileChat decides
        if chunks >= 8, secs > 0.5, Double(live.count) / Double(chunks) <= 12 { tokensPerSecond = Int(Double(chunks) / secs) }
    }

    func stop() {
        stopped = true
        appleTask?.cancel(); cloudTask?.cancel(); engine.stopTurn()
    }

    private func finish(_ chatId: String, _ m: ModelOption, instructions: String, error: Error?) {
        guard streaming == chatId, let i = chats.firstIndex(where: { $0.id == chatId }) else { return }
        let text = Fold.visible(live, opened: m.thinks, final: true).text.trimmingCharacters(in: .whitespacesAndNewlines)
        // a stop is the user's choice and never an error; a real failure is saved
        // on the reply, with whatever it had written (MobileChat.jsx finish)
        let failed = error != nil && !stopped
        if !text.isEmpty || failed {
            var reply = Msg(id: "a\(Int(Date().timeIntervalSince1970 * 1000))", role: "assistant", text: text)
            if failed, let error {
                reply.extra["error"] = m.id == AppleLM.id
                    ? "Apple Intelligence couldn't answer. It may still be getting ready on this \(Device.word). Try again in a minute, or pick another model."
                    : "\(m.name) couldn't answer: \(error.localizedDescription)"
            }
            chats[i].messages.append(reply)
        }
        // the engine's session holds the conversation only after a clean reply
        if case .local(let id) = ModelRef(id: m.id), error == nil, !stopped, !text.isEmpty {
            session = (chatId, id, instructions, chats[i].messages.count)
        } else { session = nil }
        streaming = nil; live = ""
        chats[i].updatedAt = Date().timeIntervalSince1970 * 1000
        ChatStore.save(kv, chats[i])
        chats.sort { $0.updatedAt > $1.updatedAt }
        if failed { Haptic.error() } else if error == nil, !stopped { Haptic.success() }
    }
}
