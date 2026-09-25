import SwiftUI

/// Home: your conversations, newest first, searchable, with archived ones
/// folded away underneath. Minis-style — the list IS the home screen.
struct HomeView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.rx) private var rx
    let open: (String) -> Void
    var go: (Route) -> Void = { _ in }
    @State private var query = ""
    @State private var showArchived = false

    private func matches(_ c: Chat) -> Bool {
        query.isEmpty || c.title.localizedCaseInsensitiveContains(query) || c.preview.localizedCaseInsensitiveContains(query)
    }
    private var live: [Chat] { app.chats.filter { !$0.archived && matches($0) } }
    private var archived: [Chat] { app.chats.filter { $0.archived && matches($0) } }

    var body: some View {
        List {
            ForEach(live) { chat in
                row(chat)
                    .listRowSeparator(chat.id == live.first?.id ? .hidden : .visible, edges: .top)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) { app.delete(chat.id) } label: { Label("Delete", systemImage: "trash") }
                        Button { app.setArchived(chat.id, true) } label: { Label("Archive", systemImage: "archivebox") }.tint(.indigo)
                    }
            }
            if !archived.isEmpty {
                Section {
                    DisclosureGroup(isExpanded: $showArchived) {
                        ForEach(archived) { chat in
                            row(chat)
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    Button(role: .destructive) { app.delete(chat.id) } label: { Label("Delete", systemImage: "trash") }
                                    Button { app.setArchived(chat.id, false) } label: { Label("Restore", systemImage: "tray.and.arrow.up") }.tint(rx.tint)
                                }
                        }
                    } label: {
                        Text("Archived (\(archived.count))").font(.subheadline.weight(.semibold)).foregroundStyle(rx.label2)
                    }
                }
                .listRowBackground(rx.bg)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(rx.bg)
        .overlay {
            if app.chats.isEmpty { empty }
        }
        .searchable(text: $query, prompt: "Search conversations")
        .navigationTitle("Radiant")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Button("Settings", systemImage: "gearshape") { app.openWeb("settings") }
                    Button("Models", systemImage: "square.stack.3d.up") { go(.models) }
                    Button("Skills", systemImage: "wand.and.stars") { app.openWeb("skills") }
                    Button("Cloud models", systemImage: "cloud") { app.openWeb("providers") }
                    Button("Read me", systemImage: "book") { app.openWeb("readme") }
                    Divider()
                    Button("Use the current design", systemImage: "arrow.uturn.backward") { app.close() }
                } label: {
                    Image(systemName: "gearshape").accessibilityLabel("Settings and more")
                }
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if !app.options.isEmpty {
                Button { open(app.newChat()) } label: {
                    Image(systemName: "square.and.pencil").font(.title2.weight(.semibold)).frame(width: 60, height: 60)
                }
                .buttonStyle(.plain)
                .foregroundStyle(rx.label)
                .modifier(Glass(shape: Circle()))
                .padding(.trailing, 20).padding(.bottom, 12)
                .accessibilityLabel("New chat")
            }
        }
        .refreshable { app.reload() }
    }

    private func row(_ chat: Chat) -> some View {
        Button { open(chat.id) } label: {
            HStack(alignment: .top, spacing: 12) {
                ZStack {
                    Circle().fill(Self.tint(for: chat.modelName ?? chat.title, rx: rx).gradient)
                    Image(systemName: Self.icon(chat.modelId))
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                }
                .frame(width: 38, height: 38)
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(chat.title).font(.headline).foregroundStyle(rx.label).lineLimit(1)
                        Spacer(minLength: 8)
                        Text(app.streaming == chat.id ? "Answering…" : Relative.label(chat.updatedAt))
                            .font(.caption).foregroundStyle(rx.label2).monospacedDigit()
                    }
                    Text(chat.preview.isEmpty ? (chat.modelName ?? "") : chat.preview)
                        .font(.subheadline).foregroundStyle(rx.label2).lineLimit(2)
                }
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(rx.bg)
        .listRowSeparatorTint(rx.separator)
        .accessibilityElement(children: .combine)
    }

    private var empty: some View {
        ContentUnavailableView {
            Label("No conversations yet", systemImage: "bubble.left.and.bubble.right")
        } description: {
            Text(app.options.isEmpty ? "Get a model to talk to — it runs right here, offline." : "Start one with the button below.")
        } actions: {
            if app.options.isEmpty {
                Button("Choose a model") { go(.models) }.buttonStyle(.borderedProminent)
            }
        }
        .foregroundStyle(rx.label2)
    }

    /// On the phone, Apple's, or in the cloud — the one thing worth knowing at a glance.
    static func icon(_ modelId: String?) -> String {
        guard let id = modelId else { return "sparkles" }
        switch ModelRef(id: id) {
        case .apple: return "sparkles"
        case .cloud: return "cloud.fill"
        case .local: return "iphone"
        }
    }

    /// A steady color per model, in the theme's family, so a list reads at a glance.
    static func tint(for key: String, rx: Palette) -> Color {
        let h = key.unicodeScalars.reduce(5381) { ($0 &* 33 &+ Int($1.value)) & 0x7fffffff }
        let hues: [Double] = [258, 200, 150, 55, 310, 25, 180, 90]
        return Color(oklch: rx.dark ? 0.62 : 0.55, 0.13, hues[h % hues.count])
    }
}
