import SwiftUI
import UIKit
import Capacitor
#if canImport(FoundationModels)
import FoundationModels
#endif

/// A native SwiftUI home and chat, opened over the web app as a preview.
///
/// ⚠️ A TRIAL, NOT A REPLACEMENT. Tony saw Minis ("slick interface … tremendous
/// ui/ux") and chose to feel a native version before committing to a rewrite:
/// "Try swift ui and chat first". So this is two screens — the chat list and a
/// conversation — on the SAME data and the SAME engine as the web app. Chats
/// arrive from the web store when it opens and every change goes straight back
/// ("saved" / "deleted" / "archived" events), so closing the preview loses
/// nothing and the web home shows what happened here.
///
/// The model is LocalModels' own slot (startTurn), never a second copy: two
/// multi-GB models do not fit in a phone's memory at once.
@objc(NativePreview)
public class NativePreview: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativePreview"
    public let jsName = "NativePreview"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)
    ]

    private weak var host: UIViewController?

    @objc func open(_ call: CAPPluginCall) {
        let raw = call.getArray("chats", JSObject.self) ?? []
        let chats = raw.compactMap(PChat.init(js:))
        let current = call.getString("currentModelId")
        DispatchQueue.main.async {
            guard let engine = self.bridge?.plugin(withName: "LocalModels") as? LocalModels,
                  let presenter = self.bridge?.viewController else {
                return call.reject("The model engine is not available.")
            }
            let store = PreviewStore(chats: chats, models: AppleLM.entry + engine.downloadedOnDevice(),
                                     currentModelId: current, engine: engine)
            store.emit = { [weak self] event, data in self?.notifyListeners(event, data: data) }
            store.close = { [weak self] in
                engine.stopTurn()
                self?.host?.dismiss(animated: true)
                self?.notifyListeners("closed", data: [:])
            }
            let vc = UIHostingController(rootView: PreviewRoot(store: store))
            vc.modalPresentationStyle = .fullScreen
            self.host = vc
            presenter.present(vc, animated: true)
            call.resolve()
        }
    }
}

// MARK: - data

struct PMsg: Identifiable, Equatable {
    let id: String
    let role: String      // "user" | "assistant"
    var text: String
}

struct PChat: Identifiable, Equatable {
    let id: String
    var title: String
    var modelId: String?
    var modelName: String?
    var updatedAt: Double
    var messages: [PMsg]

    init(id: String, title: String, modelId: String?, modelName: String?, updatedAt: Double, messages: [PMsg]) {
        self.id = id; self.title = title; self.modelId = modelId; self.modelName = modelName
        self.updatedAt = updatedAt; self.messages = messages
    }

    init?(js: JSObject) {
        guard let id = js["id"] as? String else { return nil }
        let msgs = (js["messages"] as? [JSObject] ?? []).enumerated().compactMap { i, m -> PMsg? in
            guard let role = m["role"] as? String, let text = m["text"] as? String else { return nil }
            return PMsg(id: (m["id"] as? String) ?? "m\(i)", role: role == "user" ? "user" : "assistant", text: text)
        }
        self.init(id: id, title: js["title"] as? String ?? "New chat", modelId: js["modelId"] as? String,
                  modelName: js["modelName"] as? String,
                  updatedAt: (js["updatedAt"] as? Double) ?? Double(js["updatedAt"] as? Int ?? 0),
                  messages: msgs)
    }

    var js: JSObject {
        var o: JSObject = ["id": id, "updatedAt": updatedAt,
                           "messages": messages.map { ["id": $0.id, "role": $0.role, "text": $0.text] as JSObject }]
        if let modelId { o["modelId"] = modelId }
        if let modelName { o["modelName"] = modelName }
        return o
    }

    /// The last thing said, for the list — what a conversation came to, not how it began.
    var preview: String {
        let last = messages.last(where: { $0.role == "assistant" && !$0.text.isEmpty }) ?? messages.last
        return Fold.visible(last?.text ?? "", opened: false, final: true).text
            .replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
    }
}

// MARK: - the same rules as the web chat (src/mobile/MobileChat.jsx, thinking.js)

enum Prompt {
    static let turns = 6, chars = 4000   // PROMPT_TURNS, PROMPT_CHARS in MobileChat.jsx

    /// The recent transcript as one prompt, when the engine's session cannot be reused.
    static func build(_ history: [PMsg], next: String) -> String {
        var ts = Array((history + [PMsg(id: "", role: "user", text: next)]).suffix(turns))
        while ts.count > 1, ts.first?.role == "assistant" { ts.removeFirst() }
        var blocks = ts.map { ($0.role == "user" ? "User: " : "Assistant: ") + $0.text }
        let tail = "\n\nAssistant:"
        func fits() -> Bool { blocks.joined(separator: "\n\n").count + tail.count <= chars }
        while blocks.count > 1, !fits() { blocks.removeFirst() }
        if !fits(), let b = blocks.first { blocks[0] = String(b.suffix(chars - tail.count)) }
        return blocks.joined(separator: "\n\n") + tail
    }
}

enum Fold {
    /// A model's thinking is not its answer: hide <think> blocks, an orphan
    /// </think> (template opened it in the prompt), and — for a model known to
    /// think that way — everything until it closes. Same as thinking.js.
    static func visible(_ raw: String, opened: Bool, final: Bool) -> (text: String, thinking: Bool) {
        var s = raw
        let open0 = s.range(of: "<think>"), close0 = s.range(of: "</think>")
        if let c = close0, open0 == nil || c.lowerBound < open0!.lowerBound {
            s = String(s[c.upperBound...]).replacingOccurrences(of: "^\n+", with: "", options: .regularExpression)
        } else if opened, close0 == nil, open0 == nil, !final {
            return ("", true)
        }
        var out = "", thinking = false
        while !s.isEmpty {
            if !thinking {
                guard let o = s.range(of: "<think>") else { out += s; break }
                out += s[..<o.lowerBound]; s = String(s[o.upperBound...]); thinking = true
            } else {
                guard let c = s.range(of: "</think>") else { s = ""; break }
                s = String(s[c.upperBound...]).replacingOccurrences(of: "^\n+", with: "", options: .regularExpression)
                thinking = false
            }
        }
        return (out, thinking)
    }
}

// MARK: - Apple's model

/// Apple Intelligence, called directly — the same way AppleModel.swift does,
/// with a fresh session and the recent transcript as the prompt. iOS 26+ only,
/// and only offered when the system says it is available.
enum AppleLM {
    static let id = "apple-intelligence"   // APPLE_ID in src/mobile/appleModel.js

    static var entry: [LocalModels.OnDevice] {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *), case .available = SystemLanguageModel.default.availability {
            return [LocalModels.OnDevice(id: id, name: "Apple Intelligence", maker: "Apple", thinks: false)]
        }
        #endif
        return []
    }

    /// Streams snapshots — the whole answer so far each time.
    static func stream(_ prompt: String, onSnapshot: @escaping (String) -> Void) -> Task<Void, Error>? {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            return Task {
                let session = LanguageModelSession()
                for try await partial in session.streamResponse(to: prompt) {
                    if Task.isCancelled { break }
                    onSnapshot(String(describing: partial.content))
                }
            }
        }
        #endif
        return nil
    }
}

// MARK: - store

@MainActor
final class PreviewStore: ObservableObject {
    @Published var chats: [PChat]
    @Published var models: [LocalModels.OnDevice]
    @Published var currentModelId: String?
    @Published var streaming: String? = nil          // chat id with a reply in flight
    @Published var live = ""                          // raw text of that reply
    /// Why the last reply in a chat failed, in plain words. Shown under the
    /// conversation and never saved as if the model had said it.
    @Published var failure: [String: String] = [:]
    let engine: LocalModels
    var emit: (String, JSObject) -> Void = { _, _ in }
    var close: () -> Void = {}
    /// What the engine's session already holds, so a follow-up sends only the new message.
    private var session: (chatId: String, modelId: String, count: Int)?
    /// Stop makes the engine drop its session, so the next message must resend the transcript.
    private var stopped = false
    private var appleTask: Task<Void, Error>?

    init(chats: [PChat], models: [LocalModels.OnDevice], currentModelId: String?, engine: LocalModels) {
        self.chats = chats.sorted { $0.updatedAt > $1.updatedAt }
        self.models = models
        self.engine = engine
        let ids = Set(models.map(\.id))
        self.currentModelId = currentModelId.flatMap { ids.contains($0) ? $0 : nil } ?? models.first?.id
    }

    func model(_ id: String?) -> LocalModels.OnDevice? { models.first { $0.id == id } }

    func newChat() -> String {
        let id = "c" + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36) + String(Int.random(in: 0..<1_000_000), radix: 36)
        let m = model(currentModelId)
        chats.insert(PChat(id: id, title: "New chat", modelId: m?.id, modelName: m?.name,
                           updatedAt: Date().timeIntervalSince1970 * 1000, messages: []), at: 0)
        return id
    }

    func delete(_ id: String) {
        chats.removeAll { $0.id == id }
        emit("deleted", ["id": id])
    }

    func archive(_ id: String) {
        chats.removeAll { $0.id == id }
        emit("archived", ["id": id])
    }

    func setModel(_ chatId: String, _ modelId: String) {
        guard let i = chats.firstIndex(where: { $0.id == chatId }), let m = model(modelId) else { return }
        chats[i].modelId = m.id; chats[i].modelName = m.name
        currentModelId = m.id
        if !chats[i].messages.isEmpty { save(i) }
    }

    func send(_ chatId: String, _ text: String) {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, streaming == nil, let i = chats.firstIndex(where: { $0.id == chatId }) else { return }
        guard let m = model(chats[i].modelId) ?? model(currentModelId) else { return }
        chats[i].modelId = m.id; chats[i].modelName = m.name
        let history = chats[i].messages
        let reuse = session.map { $0.chatId == chatId && $0.modelId == m.id && $0.count == history.count } ?? false
        let prompt = reuse ? body : Prompt.build(history, next: body)
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        chats[i].messages.append(PMsg(id: "u\(stamp)", role: "user", text: body))
        if chats[i].title == "New chat" {
            let t = body.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            chats[i].title = t.count > 60 ? String(t.prefix(57)).trimmingCharacters(in: .whitespaces) + "…" : t
        }
        chats[i].updatedAt = Double(stamp)
        streaming = chatId; live = ""; stopped = false; failure[chatId] = nil
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        let thinks = m.thinks
        if m.id == AppleLM.id {
            let full = Prompt.build(history, next: body)
            appleTask = AppleLM.stream(full) { snap in Task { @MainActor in if self.streaming == chatId { self.live = snap } } }
            let t = appleTask
            Task { @MainActor in
                var err: Error? = nil
                do { try await t?.value } catch { err = error }
                self.finish(chatId, modelId: m.id, thinks: false, error: err)
            }
            return
        }
        engine.startTurn(modelId: m.id, prompt: prompt, conversation: chatId, reset: !reuse,
            onToken: { chunk in Task { @MainActor in if self.streaming == chatId { self.live += chunk } } },
            onEnd: { error in Task { @MainActor in self.finish(chatId, modelId: m.id, thinks: thinks, error: error) } })
    }

    func stop() { stopped = true; appleTask?.cancel(); engine.stopTurn() }

    private func finish(_ chatId: String, modelId: String, thinks: Bool, error: Error?) {
        guard streaming == chatId, let i = chats.firstIndex(where: { $0.id == chatId }) else { return }
        let text = Fold.visible(live, opened: thinks, final: true).text.trimmingCharacters(in: .whitespacesAndNewlines)
        let cancelled = stopped || error is CancellationError
        if !text.isEmpty {
            chats[i].messages.append(PMsg(id: "a\(Int(Date().timeIntervalSince1970 * 1000))", role: "assistant", text: text))
        }
        if let error, !cancelled, text.isEmpty {
            failure[chatId] = modelId == AppleLM.id
                ? "Apple Intelligence couldn't answer. It may still be getting ready on this iPhone. Try again in a minute, or pick another model above."
                : "The model couldn't answer: \(error.localizedDescription)"
        }
        // the engine's session holds this conversation only after a clean reply
        session = (error == nil && !stopped && !text.isEmpty) ? (chatId, modelId, chats[i].messages.count) : nil
        streaming = nil; live = ""
        chats[i].updatedAt = Date().timeIntervalSince1970 * 1000
        save(i)
        if error == nil { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    }

    private func save(_ i: Int) {
        emit("saved", ["chat": chats[i].js])
        chats.sort { $0.updatedAt > $1.updatedAt }
    }
}

// MARK: - screens

struct PreviewRoot: View {
    @ObservedObject var store: PreviewStore
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            HomeList(store: store, open: { path.append($0) })
                .navigationDestination(for: String.self) { ChatScreen(store: store, chatId: $0) }
        }
    }
}

struct HomeList: View {
    @ObservedObject var store: PreviewStore
    let open: (String) -> Void
    @State private var query = ""

    private var shown: [PChat] {
        guard !query.isEmpty else { return store.chats }
        return store.chats.filter { $0.title.localizedCaseInsensitiveContains(query) || $0.preview.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        List {
            ForEach(shown) { chat in
                Button { open(chat.id) } label: { ChatRowView(chat: chat, busy: store.streaming == chat.id) }
                    .buttonStyle(.plain)
                    .listRowSeparator(chat.id == shown.first?.id ? .hidden : .visible, edges: .top)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) { store.delete(chat.id) } label: { Label("Delete", systemImage: "trash") }
                        Button { store.archive(chat.id) } label: { Label("Archive", systemImage: "archivebox") }.tint(.indigo)
                    }
            }
        }
        .listStyle(.plain)
        .overlay {
            if store.chats.isEmpty {
                ContentUnavailableView("No conversations yet", systemImage: "bubble.left.and.bubble.right",
                                       description: Text(store.models.isEmpty ? "Download a model in the current design, then come back."
                                                                              : "Start one with the button below."))
            }
        }
        .searchable(text: $query, prompt: "Search conversations")
        .navigationTitle("Radiant")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Close") { store.close() }
                    .accessibilityHint("Back to the current design")
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if !store.models.isEmpty {
                Button { open(store.newChat()) } label: {
                    Image(systemName: "square.and.pencil").font(.title2.weight(.semibold))
                        .frame(width: 60, height: 60)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.primary)
                .modifier(Glass())
                .padding(.trailing, 20).padding(.bottom, 12)
                .accessibilityLabel("New chat")
            }
        }
    }
}

struct ChatRowView: View {
    let chat: PChat
    let busy: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle().fill(Palette.tint(for: chat.modelName ?? chat.title).gradient)
                Image(systemName: "sparkles").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
            }
            .frame(width: 38, height: 38)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(chat.title).font(.headline).lineLimit(1)
                    Spacer(minLength: 8)
                    Text(busy ? "Answering…" : Relative.label(chat.updatedAt))
                        .font(.caption).foregroundStyle(.secondary).monospacedDigit()
                }
                Text(chat.preview.isEmpty ? (chat.modelName ?? "") : chat.preview)
                    .font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

struct ChatScreen: View {
    @ObservedObject var store: PreviewStore
    let chatId: String
    @State private var draft = ""
    @FocusState private var focused: Bool

    private var chat: PChat? { store.chats.first { $0.id == chatId } }
    private var model: LocalModels.OnDevice? { store.model(chat?.modelId) ?? store.model(store.currentModelId) }
    private var busy: Bool { store.streaming == chatId }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(chat?.messages ?? []) { m in
                        MessageView(msg: m, name: chat?.modelName ?? model?.name ?? "Radiant").id(m.id)
                    }
                    if busy {
                        let v = Fold.visible(store.live, opened: model?.thinks ?? false, final: false)
                        LiveReply(name: model?.name ?? "Radiant", text: v.text, thinking: v.thinking || v.text.isEmpty)
                    } else if let why = store.failure[chatId] {
                        Label(why, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline)
                            .foregroundStyle(.orange)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 18).padding(.top, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: store.live) { proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: chat?.messages.count) { withAnimation(.snappy) { proxy.scrollTo("end", anchor: .bottom) } }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(chat?.title ?? "New chat").font(.headline).lineLimit(1)
                    Menu {
                        ForEach(store.models, id: \.id) { m in
                            Button { store.setModel(chatId, m.id) } label: {
                                if m.id == model?.id { Label(m.name, systemImage: "checkmark") } else { Text(m.name) }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Circle().fill(.green).frame(width: 6, height: 6)
                            Text(model?.name ?? "No model").font(.caption)
                            Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                        }
                        .foregroundStyle(.secondary)
                    }
                    .disabled(busy)
                    .accessibilityLabel("Model: \(model?.name ?? "none"). Change model")
                }
            }
        }
        .onAppear { if chat?.messages.isEmpty ?? true { focused = true } }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField(model.map { "Message \($0.name)" } ?? "Download a model first", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($focused)
                .disabled(model == nil)
                .padding(.vertical, 10)
            Button {
                if busy { store.stop() } else { store.send(chatId, draft); draft = "" }
            } label: {
                Image(systemName: busy ? "stop.circle.fill" : "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .symbolRenderingMode(.hierarchical)
            }
            .disabled(!busy && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel(busy ? "Stop" : "Send")
            .padding(.bottom, 4)
        }
        .padding(.leading, 16).padding(.trailing, 8)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).strokeBorder(.quaternary))
        .padding(.horizontal, 12).padding(.bottom, 6)
    }
}

struct MessageView: View {
    let msg: PMsg
    let name: String

    var body: some View {
        if msg.role == "user" {
            HStack {
                Spacer(minLength: 48)
                Text(msg.text)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .textSelection(.enabled)
            }
            .contextMenu { Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = msg.text } }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                AssistantName(name: name)
                RichText(text: Fold.visible(msg.text, opened: false, final: true).text)
            }
            .contextMenu {
                Button("Copy", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = Fold.visible(msg.text, opened: false, final: true).text
                }
            }
        }
    }
}

struct LiveReply: View {
    let name: String
    let text: String
    let thinking: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            AssistantName(name: name)
            if thinking && text.isEmpty {
                Text("Thinking…").foregroundStyle(.secondary).modifier(Pulse())
            } else {
                RichText(text: text)
            }
        }
    }
}

struct AssistantName: View {
    let name: String
    var body: some View {
        Label(name, systemImage: "sparkles")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .labelStyle(.titleAndIcon)
    }
}

/// Markdown for prose (bold, italics, links, inline code) and a plain block for code.
struct RichText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
                if b.code {
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(b.text).font(.system(.callout, design: .monospaced)).padding(12)
                    }
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                } else {
                    Text(markdown(b.text)).textSelection(.enabled)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var blocks: [(code: Bool, text: String)] {
        var out: [(Bool, String)] = []
        let parts = text.components(separatedBy: "```")
        for (i, p) in parts.enumerated() {
            if i % 2 == 1 {
                // drop the language tag on the fence line
                let body = p.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
                let code = body.count > 1 ? String(body[1]) : ""
                out.append((true, code.trimmingCharacters(in: .newlines)))
            } else if !p.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                out.append((false, p.trimmingCharacters(in: .newlines)))
            }
        }
        return out
    }

    private func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}

// MARK: - small pieces

enum Palette {
    /// A steady color per model, so a list of chats reads at a glance.
    static func tint(for key: String) -> Color {
        let colors: [Color] = [.blue, .indigo, .purple, .pink, .orange, .teal, .green, .cyan, .mint]
        let h = key.unicodeScalars.reduce(5381) { ($0 &* 33 &+ Int($1.value)) & 0x7fffffff }
        return colors[h % colors.count]
    }
}

enum Relative {
    static func label(_ ms: Double) -> String {
        guard ms > 0 else { return "" }
        let d = Date(timeIntervalSince1970: ms / 1000)
        if Date().timeIntervalSince(d) < 60 { return "Just now" }
        return d.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }
}

/// Liquid Glass on iOS 26 and later; a material with a hairline everywhere else.
struct Glass: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: .circle)
        } else {
            content
                .background(.regularMaterial, in: Circle())
                .overlay(Circle().strokeBorder(.quaternary))
                .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
        }
    }
}

struct Pulse: ViewModifier {
    @State private var dim = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content.opacity(dim ? 0.45 : 1)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
            }
    }
}
