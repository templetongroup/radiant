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
            header
                .listRowBackground(rx.bg)
                .listRowSeparator(.hidden)
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
            byline
                .listRowBackground(rx.bg)
                .listRowSeparator(.hidden)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(rx.bg)
        .searchable(text: $query, prompt: "Search conversations")
        // The logo and wordmark ARE the header, as on the previous Home — a
        // "Radiant" title above a RADIANT wordmark would be the name twice.
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Button("Settings", systemImage: "gearshape") { go(.settings) }
                    Button("Models", systemImage: "square.stack.3d.up") { go(.models) }
                    Button("Skills", systemImage: "wand.and.stars") { go(.skills) }
                    Button("Cloud models", systemImage: "cloud") { go(.cloud) }
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

    /// The previous Home's lockup: the swirl, the wordmark, a greeting for the
    /// time of day, and the model a new chat will use. Both marks take the
    /// theme's text tint, so they follow the color picked in Settings.
    private var header: some View {
        VStack(spacing: 0) {
            Image("LogoMark").renderingMode(.template).resizable().scaledToFit()
                .frame(width: 72, height: 72)
            Image("Wordmark").renderingMode(.template).resizable().scaledToFit()
                .frame(width: 132).padding(.top, 10)
                .accessibilityLabel("Radiant").accessibilityAddTraits(.isHeader)
            Text(Self.greeting()).font(.subheadline).foregroundStyle(rx.label2).padding(.top, 14)
            if app.options.isEmpty {
                Text("No model on this iPhone yet.\nChoose one and it runs here, offline.")
                    .font(.subheadline).foregroundStyle(rx.label2).padding(.top, 10)
                Button("Choose a model") { go(.models) }.buttonStyle(.borderedProminent).padding(.top, 14)
            } else if let name = app.option(app.currentModelId)?.name {
                (Text("Current model: ").foregroundStyle(rx.label2) + Text(name).fontWeight(.semibold).foregroundStyle(rx.label))
                    .font(.footnote).padding(.top, 12)
            }
            if app.chats.isEmpty, !app.options.isEmpty {
                Text("Start a conversation with the button below.").font(.footnote).foregroundStyle(rx.label2).padding(.top, 28)
            }
        }
        .foregroundStyle(rx.tintText)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.top, 4).padding(.bottom, 12)
    }

    /// Whose app this is, at the foot of the list as on the previous Home.
    private var byline: some View {
        Link(destination: URL(string: "https://templetontech.com")!) {
            (Text("Radiant is a ").foregroundStyle(rx.label2) + Text("Templeton Technologies").foregroundStyle(rx.tintText) + Text(" product.").foregroundStyle(rx.label2))
                .font(.caption2)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 20).padding(.bottom, 90)   // clear of the new-chat button
        .accessibilityLabel("Radiant is a Templeton Technologies product. Opens templetontech.com.")
    }

    /// Time of day, because a greeting that never changes stops being one (HomeScreen.jsx).
    static func greeting(_ now: Date = Date()) -> String {
        let h = Calendar.current.component(.hour, from: now)
        return h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"
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
