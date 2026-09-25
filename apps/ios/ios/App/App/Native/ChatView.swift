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
    @State private var confirmDelete = false
    @FocusState private var focused: Bool

    private var chat: Chat? { app.chat(chatId) }
    private var model: ModelOption? { app.option(chat?.modelId) ?? app.option(app.currentModelId) }
    private var busy: Bool { app.streaming == chatId }
    private var skill: Skill? { app.skills.first { $0.id == chat?.skillId } }
    private var slashMatches: [Skill] {
        guard draft.range(of: "^/[A-Za-z0-9_-]*$", options: .regularExpression) != nil else { return [] }
        return app.skills.filter { ("/" + $0.slug).hasPrefix(draft) }.sorted { $0.slug < $1.slug }
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
                        LiveReply(name: model?.name ?? "Radiant", text: v.text, thinking: v.thinking || v.text.isEmpty)
                    } else if let why = app.failure[chatId] {
                        Label(why, systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(.orange)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 18).padding(.top, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .background(rx.bg)
            .onChange(of: app.live) { proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: chat?.messages.count) { withAnimation(.snappy) { proxy.scrollTo("end", anchor: .bottom) } }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(rx.bg, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) { header }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("New conversation", systemImage: "square.and.pencil") { openChat(app.newChat()) }
                    Button("Delete conversation", systemImage: "trash", role: .destructive) { confirmDelete = true }
                } label: { Image(systemName: "ellipsis.circle").accessibilityLabel("More") }
            }
        }
        .confirmationDialog("Delete this conversation?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { app.delete(chatId); dismiss() }
        } message: { Text("It can't be brought back.") }
        .onAppear {
            draft = Drafts.load(app.kv, chatId)
            if chat?.messages.isEmpty ?? true { focused = true }
        }
        .onChange(of: draft) { Drafts.save(app.kv, chatId, draft) }
        .onChange(of: photoItem) {
            Task { photo = await Self.jpeg(from: photoItem) }
        }
    }

    // MARK: header

    private var header: some View {
        VStack(spacing: 1) {
            Text(chat?.title ?? "New chat").font(.headline).foregroundStyle(rx.label).lineLimit(1)
            Menu {
                ForEach(app.options) { m in
                    Button { app.setModel(chatId, m.id) } label: {
                        if m.id == model?.id { Label(m.name, systemImage: "checkmark") } else { Text("\(m.name) · \(m.maker)") }
                    }
                }
                Divider()
                Button("More models…", systemImage: "square.stack.3d.up") { go(.models) }
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
                return "Running on this iPhone. Nothing leaves the device."
            } ?? "Choose a model from the menu above to start.")
                .font(.subheadline).foregroundStyle(rx.label2).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(.top, 60)
    }

    // MARK: composer

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !slashMatches.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(slashMatches) { s in
                        Button { draft = "/" + s.slug + " " } label: {
                            HStack { Text("/" + s.slug).font(.body.monospaced()).foregroundStyle(rx.tintText); Text(s.name).foregroundStyle(rx.label2) }
                                .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8).padding(.horizontal, 14)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .background(rx.cell, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .padding(.horizontal, 12)
            }
            if skill != nil || photo != nil {
                HStack(spacing: 8) {
                    if let s = skill { chip(s.name, systemImage: "wand.and.stars") { app.setSkill(chatId, nil) } }
                    if photo != nil { chip("Photo", systemImage: "photo") { photo = nil; photoItem = nil } }
                }
                .padding(.horizontal, 16)
            }
            HStack(alignment: .bottom, spacing: 6) {
                if model?.vision == true {
                    PhotosPicker(selection: $photoItem, matching: .images) {
                        Image(systemName: "plus").font(.body.weight(.semibold)).frame(width: 34, height: 34)
                    }
                    .foregroundStyle(rx.label2)
                    .accessibilityLabel("Add a photo")
                }
                Menu {
                    ForEach(app.skills) { s in
                        Button { app.setSkill(chatId, s.id) } label: {
                            if s.id == skill?.id { Label(s.name, systemImage: "checkmark") } else { Text(s.name) }
                        }
                    }
                    if skill != nil { Divider(); Button("No skill") { app.setSkill(chatId, nil) } }
                    Divider()
                    Button("Manage skills…", systemImage: "wand.and.stars") { app.openWeb("skills") }
                } label: {
                    Image(systemName: "slash.circle").font(.body.weight(.semibold)).frame(width: 34, height: 34)
                }
                .foregroundStyle(skill == nil ? rx.label2 : rx.tint)
                .accessibilityLabel(skill.map { "Skill: \($0.name)" } ?? "Choose a skill")

                TextField(model.map { "Message \($0.name)" } ?? "Choose a model to start", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($focused)
                    .disabled(model == nil)
                    .foregroundStyle(rx.label)
                    .padding(.vertical, 8)
                Button {
                    if busy { app.stop() } else if app.send(chatId, draft, photo: photo) { draft = ""; photo = nil; photoItem = nil }
                } label: {
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
        let long = max(img.size.width, img.size.height), scale = min(1, 1536 / max(long, 1))
        let size = CGSize(width: img.size.width * scale, height: img.size.height * scale)
        let out = UIGraphicsImageRenderer(size: size).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
        return out.jpegData(compressionQuality: 0.85)
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
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    AssistantName(name: name)
                    RichText(text: text)
                }
                .contextMenu { Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text } }
            } else if let why = msg.extra["error"] as? String, !why.isEmpty {
                // a failed reply the web design saved: say why, not an empty name
                Label(why, systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(.orange)
            }
        }
    }
}

struct LiveReply: View {
    @Environment(\.rx) private var rx
    let name: String, text: String, thinking: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            AssistantName(name: name)
            if thinking && text.isEmpty {
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
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(b.text).font(.system(.callout, design: .monospaced)).foregroundStyle(rx.label).padding(12)
                    }
                    .background(rx.cell2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}
