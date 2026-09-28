import SwiftUI
import PhotosUI

/// One conversation: the transcript, the model under the title, and a
/// Minis-style composer tray — photo (+), skills (/), the text, send/stop.
struct ChatView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.rx) private var rx
    @Environment(\.dismiss) private var dismiss
    let chatId: String
    /// Show another conversation in place of this one ("New conversation").
    var openChat: (String) -> Void = { _ in }
    var go: (Route) -> Void = { _ in }
    @State private var draft = ""
    @State private var photoItem: PhotosPickerItem?
    @State private var photo: Data?
    @State private var pickPhoto = false
    @State private var camera = false
    @State private var confirmDelete = false
    @State private var showInfo = false
    // following the reply (MobileChat.jsx onScroll): only a finger turns it off
    @State private var follow = true
    @State private var driving = false
    @State private var showJump = false
    /// Pushing Models or Skills over this chat is not leaving it.
    @State private var forward = false
    @State private var oneLine: CGFloat = 0
    @State private var multiline = false
    @FocusState private var focused: Bool

    private var chat: Chat? { app.chat(chatId) }
    private var model: ModelOption? { app.option(chat?.modelId) ?? app.option(app.currentModelId) }
    private var busy: Bool { app.streaming == chatId }
    private var skill: Skill? { app.skills.first { $0.id == chat?.skillId } }
    private var slashMatches: [Skill] {
        guard draft.range(of: "^/[A-Za-z0-9_-]*$", options: .regularExpression) != nil else { return [] }
        return Array(app.skills.filter { ("/" + $0.slug).hasPrefix(draft) }.sorted { $0.slug < $1.slug }.prefix(6))
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if chat?.messages.isEmpty ?? true, !busy { intro }
                    ForEach(chat?.messages ?? []) { m in
                        MessageRow(msg: m, name: chat?.modelName ?? model?.name ?? "Radiant").id(m.id)
                    }
                    if busy {
                        let v = Fold.visible(app.live, opened: model?.thinks ?? false, final: false)
                        LiveReply(name: model?.name ?? "Radiant", text: v.text, thinking: v.thinking)
                    }
                    Color.clear.frame(height: 1).id("end")
                        .onAppear { reached(true) }
                        .onDisappear { reached(false) }
                }
                .padding(.horizontal, 18).padding(.top, 8)
                .readingWidth()
            }
            .scrollDismissesKeyboard(.interactively)
            .modifier(FollowScroll(driving: $driving))
            .background(rx.bg)
            .onChange(of: app.live) { if follow { proxy.scrollTo("end", anchor: .bottom) } }
            .onChange(of: chat?.messages.count) { if follow { withAnimation(.snappy) { proxy.scrollTo("end", anchor: .bottom) } } }
            .onChange(of: busy) {
                // sending re-arms following; a finished reply needs no jump
                if busy { follow = true; driving = false; proxy.scrollTo("end", anchor: .bottom) }
                showJump = false
            }
            .overlay(alignment: .bottom) {
                if showJump {
                    Button {
                        follow = true; driving = false; showJump = false
                        withAnimation(.snappy) { proxy.scrollTo("end", anchor: .bottom) }
                    } label: {
                        Label("Jump to latest", systemImage: "arrow.down").font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 14).padding(.vertical, 8)
                    }
                    .buttonStyle(.plain).foregroundStyle(rx.label)
                    .modifier(Glass(shape: Capsule()))
                    .padding(.bottom, 10)
                }
            }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(rx.bg, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) { header }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("New conversation", systemImage: "square.and.pencil") { Haptic.tap(); openChat(app.newChat()) }
                    Button("Model info", systemImage: "info.circle") { Haptic.tap(); showInfo = true }.disabled(model == nil)
                    Button("Delete conversation", systemImage: "trash", role: .destructive) { confirmDelete = true }
                } label: { Image(systemName: "ellipsis.circle").accessibilityLabel("More") }
            }
        }
        .confirmationDialog("Delete this conversation?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { app.delete(chatId); dismiss() }
        } message: { Text("It can't be brought back.") }
        .sheet(isPresented: $showInfo) {
            if let m = model {
                ModelInfo(option: m, engine: app.engine) { id in showInfo = false; app.setModel(chatId, id) }
                    .modifier(Themed(appearance: app.appearance))
                    .presentationDetents([.medium])
            }
        }
        .photosPicker(isPresented: $pickPhoto, selection: $photoItem, matching: .images)
        .fullScreenCover(isPresented: $camera, onDismiss: { forward = false }) {
            CameraPicker { img in camera = false; if let img { photo = Self.jpeg(img) } }.ignoresSafeArea()
        }
        .onAppear {
            forward = false
            // a new chat takes the words left in one abandoned before its first message (drafts.js adoptDraft)
            draft = Drafts.adopt(app.kv, chatId, known: ChatStore.all(app.kv).map(\.id))
            if chat?.messages.isEmpty ?? true { focused = true }
        }
        // leaving mid-reply stops it, so another chat can send (MobileChat.jsx:884)
        .onDisappear { if !forward, busy { app.stop() } }
        .onChange(of: draft) { Drafts.save(app.kv, chatId, draft) }
        .onChange(of: photoItem) {
            Task { photo = await Self.jpeg(from: photoItem) }
        }
        // a model that cannot see would answer about a photo nothing looked at
        .onChange(of: model?.vision) { if model?.vision != true { photo = nil; photoItem = nil } }
        .onChange(of: app.sentFromHold) {
            guard app.sentFromHold == chatId else { return }
            draft = ""; photo = nil; photoItem = nil; app.sentFromHold = nil
        }
    }

    private func reached(_ near: Bool) {
        // reaching the bottom always re-arms following; leaving it counts only when the user is driving
        if near { follow = true; driving = false } else if driving { follow = false }
        showJump = !near && (showJump || busy)
    }

    private func goForward(_ r: Route) { forward = true; go(r) }

    private func submit(_ text: String? = nil) {
        if busy { Haptic.tap(.rigid); app.stop(); return }
        let t = text ?? draft
        guard !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        // nothing can answer: say so and go where it is fixed; the words are kept (MobileChat.jsx send)
        guard model != nil else {
            Haptic.warning()
            if let text { draft = text }
            goForward(.models)
            return
        }
        if app.send(chatId, t, photo: model?.vision == true ? photo : nil) { draft = ""; photo = nil; photoItem = nil }
    }

    // MARK: header

    private var header: some View {
        VStack(spacing: 1) {
            Text(chat?.title ?? "New chat").font(.headline).foregroundStyle(rx.label).lineLimit(1)
            Menu {
                ForEach(app.options) { m in
                    Button { Haptic.tap(); app.setModel(chatId, m.id) } label: {
                        if m.id == model?.id { Label(m.name, systemImage: "checkmark") } else { Text("\(m.name) · \(m.maker)") }
                    }
                }
                Divider()
                if model != nil { Button("Model info", systemImage: "info.circle") { Haptic.tap(); showInfo = true } }
                Button("More models…", systemImage: "square.stack.3d.up") { Haptic.tap(); goForward(.models) }
            } label: {
                HStack(spacing: 4) {
                    Circle().fill(model == nil ? Color.orange : Color.green).frame(width: 6, height: 6)
                    Text(subtitle).font(.caption).monospacedDigit()
                    Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                }
                .foregroundStyle(rx.label2)
            }
            .disabled(busy)
            .accessibilityLabel("Model: \(model?.name ?? "none"). Change model")
        }
    }

    private var subtitle: String {
        guard let m = model else { return "No model yet" }
        if busy, let t = app.tokensPerSecond { return "\(m.name) · \(t) tok/s" }
        switch ModelRef(id: m.id) {
        case .cloud: return "\(m.name) · \(m.maker)"
        case .apple: return "\(m.name) · On device"
        case .local: return "\(m.name) · On device"
        }
    }

    private var intro: some View {
        VStack(spacing: 10) {
            Image(systemName: HomeView.icon(model?.id)).font(.largeTitle).foregroundStyle(rx.tint)
            Text(model?.name ?? "No model yet").font(.title3.weight(.semibold)).foregroundStyle(rx.label)
            Text(model.map { ModelRef(id: $0.id) }.map { r -> String in
                if case .cloud = r { return "Runs on \(model?.maker ?? "the provider")'s servers, using your key." }
                return "Running on this \(Device.word). Nothing leaves the device."
            } ?? "Choose a model and it runs on this \(Device.word).")
                .font(.subheadline).foregroundStyle(rx.label2).multilineTextAlignment(.center)
            // starters send on tap; send already gives the haptic (MobileChat.jsx Suggestion)
            VStack(spacing: 8) {
                ForEach(["Rewrite this paragraph", "Explain a shell command", "Draft a reply"], id: \.self) { s in
                    Button { submit(s) } label: {
                        Text(s).font(.subheadline).padding(.horizontal, 14).padding(.vertical, 8)
                            .foregroundStyle(rx.label)
                            .background(rx.cell, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 14)
        }
        .frame(maxWidth: .infinity).padding(.top, 60)
    }

    // MARK: composer

    private var placeholder: String {
        // "Message Qwen 3", not "Message Qwen 3 4B": the size is noise here
        model.map { "Message " + $0.name.replacingOccurrences(of: "\\s+\\S+B$", with: "", options: [.regularExpression, .caseInsensitive]) }
            ?? "Type here — pick a model to send"
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if model == nil {
                // a chat with nothing to answer it has to say so, and be the way out
                HStack(spacing: 10) {
                    Text("No model yet — nothing can answer. What you type is kept.")
                        .font(.footnote).foregroundStyle(rx.label2)
                    Spacer(minLength: 0)
                    Button("Choose a model") { Haptic.tap(); goForward(.models) }
                        .font(.footnote.weight(.semibold)).buttonStyle(.bordered).controlSize(.small)
                }
                .padding(.horizontal, 16)
            }
            if !slashMatches.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(slashMatches) { s in
                        Button { Haptic.tap(); draft = "/" + s.slug + " "; focused = true } label: {
                            HStack { Text("/" + s.slug).font(.body.monospaced()).foregroundStyle(rx.tintText); Text(s.name).foregroundStyle(rx.label2) }
                                .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8).padding(.horizontal, 14)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .background(rx.cell, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .padding(.horizontal, 12)
            } else if let s = skill {
                // the skill bar steps aside while the slash list is up
                chip(s.name, systemImage: "wand.and.stars") { app.setSkill(chatId, nil) }.padding(.horizontal, 16)
            }
            if model?.vision == true, let photo, let img = UIImage(data: photo) {
                Image(uiImage: img).resizable().scaledToFill()
                    .frame(width: 64, height: 64)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(alignment: .topTrailing) {
                        Button { self.photo = nil; photoItem = nil } label: {
                            Image(systemName: "xmark.circle.fill").font(.title3).symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.6))
                        }
                        .offset(x: 6, y: -6)
                        .accessibilityLabel("Remove picture")
                    }
                    .padding(.horizontal, 16)
            }
            HStack(alignment: .bottom, spacing: 6) {
                if model?.vision == true {
                    Menu {
                        Button("Photo Library", systemImage: "photo.on.rectangle") { Haptic.tap(); pickPhoto = true }
                        if CameraPicker.available {
                            Button("Take Photo", systemImage: "camera") { Haptic.tap(); forward = true; camera = true }
                        }
                    } label: {
                        Image(systemName: "plus").font(.body.weight(.semibold)).frame(width: 34, height: 34)
                    }
                    .foregroundStyle(rx.label2)
                    .accessibilityLabel(photo == nil ? "Add a picture" : "Change picture")
                }
                Menu {
                    Button { Haptic.tap(); app.setSkill(chatId, nil) } label: {
                        if skill == nil { Label("No skill", systemImage: "checkmark") } else { Text("No skill") }
                    }
                    Divider()
                    ForEach(app.skills.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }) { s in
                        Button { Haptic.tap(); app.setSkill(chatId, s.id) } label: {
                            if s.id == skill?.id { Label(s.name, systemImage: "checkmark") } else { Text(s.name) }
                        }
                    }
                    Divider()
                    Button("Edit skills…", systemImage: "wand.and.stars") { Haptic.tap(); goForward(.skills) }
                } label: {
                    Image(systemName: "slash.circle").font(.body.weight(.semibold)).frame(width: 34, height: 34)
                }
                .foregroundStyle(skill == nil ? rx.label2 : rx.tint)
                .accessibilityLabel(skill.map { "Skill: \($0.name)" } ?? "Choose a skill")

                TextField(placeholder, text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($focused)
                    .foregroundStyle(rx.label)
                    .padding(.vertical, 8)
                    // a tick as the field grows past one line, and back (MobileChat.jsx grow)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { h in
                        if oneLine == 0 || h < oneLine { oneLine = h }
                        let multi = h > oneLine + 4
                        if multi != multiline { multiline = multi; Haptic.tick() }
                    }
                Button { submit() } label: {
                    Image(systemName: busy ? "stop.circle.fill" : "arrow.up.circle.fill")
                        .font(.system(size: 32)).symbolRenderingMode(.hierarchical)
                }
                .foregroundStyle(rx.tint)
                .disabled(!busy && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel(busy ? "Stop" : "Send")
            }
            .padding(.leading, 8).padding(.trailing, 6).padding(.vertical, 2)
            .background(rx.cell, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).strokeBorder(rx.separator.opacity(0.6)))
            .padding(.horizontal, 12)
        }
        .readingWidth()
        .padding(.bottom, 6)
        .background(rx.bg.opacity(0.001))
    }

    private func chip(_ text: String, systemImage: String, remove: @escaping () -> Void) -> some View {
        Button(action: remove) {
            HStack(spacing: 5) {
                Image(systemName: systemImage)
                Text(text).lineLimit(1)
                Image(systemName: "xmark").font(.caption2.weight(.bold))
            }
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10).padding(.vertical, 6)
            .foregroundStyle(rx.tintText)
            .background(rx.tint.opacity(0.16), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(text). Remove")
    }

    /// A picked photo as JPEG, at most 1536 px on its long side.
    static func jpeg(from item: PhotosPickerItem?) async -> Data? {
        guard let data = try? await item?.loadTransferable(type: Data.self), let img = UIImage(data: data) else { return nil }
        return jpeg(img)
    }

    static func jpeg(_ img: UIImage) -> Data? {
        let long = max(img.size.width, img.size.height), scale = min(1, 1536 / max(long, 1))
        let size = CGSize(width: img.size.width * scale, height: img.size.height * scale)
        let out = UIGraphicsImageRenderer(size: size).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
        return out.jpegData(compressionQuality: 0.85)
    }
}

/// Who is scrolling. iOS 18 reports the finger directly; iOS 17 infers it from
/// a drag. Only the initial position is anchored to the bottom on 18, so new
/// text never drags a reader down.
private struct FollowScroll: ViewModifier {
    @Binding var driving: Bool
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .onScrollPhaseChange { _, phase in if phase == .interacting { driving = true } }
        } else {
            content
                .defaultScrollAnchor(.bottom)
                .simultaneousGesture(DragGesture(minimumDistance: 8).onChanged { _ in driving = true })
        }
    }
}

/// Take Photo. Offered only when the camera exists and Info.plist says why —
/// without NSCameraUsageDescription iOS kills the app on first use.
private struct CameraPicker: UIViewControllerRepresentable {
    static var available: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera) && Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription") != nil
    }
    let done: (UIImage?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(done: done) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let p = UIImagePickerController()
        p.sourceType = .camera
        p.delegate = context.coordinator
        return p
    }
    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let done: (UIImage?) -> Void
        init(done: @escaping (UIImage?) -> Void) { self.done = done }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            done(info[.originalImage] as? UIImage)
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { done(nil) }
    }
}

/// "Model info": the same detail Models shows for a model on this phone; for
/// Apple's or a cloud model, what it is and where it runs.
private struct ModelInfo: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.rx) private var rx
    @StateObject private var models: ModelsModel
    let option: ModelOption
    let use: (String) -> Void

    init(option: ModelOption, engine: LocalModels, use: @escaping (String) -> Void) {
        self.option = option
        self.use = use
        _models = StateObject(wrappedValue: ModelsModel(engine: engine))
    }

    var body: some View {
        if let row = models.rows.first(where: { $0.id == option.id }) {
            ModelDetail(row: row, models: models, startChat: use)
                .onAppear { models.onChange = { app.reload() } }
        } else {
            VStack(alignment: .leading, spacing: 14) {
                Text(option.name).font(.title2.weight(.bold)).foregroundStyle(rx.label)
                Text(option.maker).font(.subheadline).foregroundStyle(rx.label2)
                Text(option.cloud ? "Runs on \(option.maker)'s servers, using your key or sign-in."
                                  : "Built into this \(Device.word). Nothing leaves the device.")
                    .foregroundStyle(rx.label)
                Spacer()
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(rx.bg)
        }
    }
}

// MARK: - messages

struct MessageRow: View {
    @Environment(\.rx) private var rx
    let msg: Msg
    let name: String

    var body: some View {
        if msg.role == "user" {
            HStack {
                Spacer(minLength: 48)
                Text(msg.text)
                    .foregroundStyle(rx.onTint)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(rx.tint, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .textSelection(.enabled)
            }
            .contextMenu { Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = msg.text } }
        } else {
            let text = Fold.visible(msg.text, opened: false, final: true).text
            let why = msg.extra["error"] as? String ?? ""
            let hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            if hasText || !why.isEmpty {
                // a failed reply keeps what it wrote, then says why (MobileChat.jsx rx-chat-error)
                VStack(alignment: .leading, spacing: 8) {
                    AssistantName(name: name)
                    if hasText { RichText(text: text) }
                    if !why.isEmpty {
                        Label(why, systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(.orange)
                    }
                }
                .contextMenu { if hasText { Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text } } }
            }
        }
    }
}

struct LiveReply: View {
    @Environment(\.rx) private var rx
    let name: String, text: String, thinking: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // the byline says "thinking…" for as long as the model is inside a thinking block (MobileChat.jsx)
            HStack(spacing: 8) {
                AssistantName(name: name)
                if thinking { Text("thinking…").font(.subheadline).foregroundStyle(rx.label3).modifier(Pulse()) }
            }
            if text.isEmpty {
                Text("Thinking…").foregroundStyle(rx.label2).modifier(Pulse())
            } else {
                RichText(text: text)
            }
        }
    }
}

struct AssistantName: View {
    @Environment(\.rx) private var rx
    let name: String
    var body: some View {
        Label(name, systemImage: "sparkles").font(.subheadline.weight(.semibold)).foregroundStyle(rx.label2)
    }
}

/// Markdown for prose (bold, italics, links, inline code) and a plain block for code.
struct RichText: View {
    @Environment(\.rx) private var rx
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
                if b.code {
                    CodeBlock(code: b.text)
                } else {
                    Text(markdown(b.text)).foregroundStyle(rx.label).tint(rx.tintText).textSelection(.enabled)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var blocks: [(code: Bool, text: String)] {
        var out: [(Bool, String)] = []
        for (i, p) in text.components(separatedBy: "```").enumerated() {
            if i % 2 == 1 {
                let body = p.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
                out.append((true, (body.count > 1 ? String(body[1]) : "").trimmingCharacters(in: .newlines)))
            } else if !p.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                out.append((false, p.trimmingCharacters(in: .newlines)))
            }
        }
        return out
    }

    private func markdown(_ s: String) -> AttributedString {
        // "### Heading" reads as bold without the marks: the marker is noise, the emphasis is the point (MobileChat.jsx richText)
        let h = s.replacingOccurrences(of: "(?m)^[ ]{0,3}#{1,6}[ \\t]+(.+?)[ \\t]*$", with: "**$1**", options: .regularExpression)
        return (try? AttributedString(markdown: h, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}

/// A code block with its own Copy, which says "Copied" for a moment (MobileChat.jsx CodeBlock).
struct CodeBlock: View {
    @Environment(\.rx) private var rx
    let code: String
    @State private var copied = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code).font(.system(.callout, design: .monospaced)).foregroundStyle(rx.label).padding(12).padding(.top, 18)
        }
        .background(rx.cell2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(alignment: .topTrailing) {
            Button(copied ? "Copied" : "Copy") {
                UIPasteboard.general.string = code
                Haptic.tick()
                copied = true
                Task { try? await Task.sleep(for: .seconds(1.2)); copied = false }
            }
            .font(.caption.weight(.semibold)).foregroundStyle(rx.label2)
            .padding(.horizontal, 10).padding(.vertical, 6)
        }
    }
}
