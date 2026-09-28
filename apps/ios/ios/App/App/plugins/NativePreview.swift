import SwiftUI
import UIKit

/// The native app's root: navigation, theme, and the cloud-permission sheet.
/// Where the native app can go.
enum Route: Hashable { case chat(String), models, settings, cloud, skills, readme }

struct NativeRoot: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var kv: KV
    @State private var path: [Route] = []

    var body: some View {
        let appearance = Appearance(kv.json(Appearance.key))
        NavigationStack(path: $path) {
            HomeView(open: { path.append(.chat($0)) }, go: { path.append($0) })
                .navigationDestination(for: Route.self) { r in
                    switch r {
                    case .chat(let id):
                        ChatView(chatId: id, openChat: { path = [.chat($0)] }, go: { path.append($0) })
                    case .models:
                        ModelsView(engine: app.engine, startChat: { modelId in
                            path = [.chat(app.openChat(forModel: modelId))]
                        })
                    case .settings: SettingsView(go: { path.append($0) })
                    case .cloud: CloudModelsView(startChat: { path = [.chat(app.newChat())] })
                    case .skills: SkillsView()
                    case .readme: ReadMeView()
                    }
                }
        }
        .modifier(Themed(appearance: appearance))
        .onChange(of: appearance) {
            NavTitles.style(appearance)
            NavTitles.recolor(Themes.palette(appearance, systemDark: UIScreen.main.traitCollection.userInterfaceStyle == .dark).label)
        }
        .onAppear {
            // "Open to: Last chat" in Settings
            if appearance.openTo == "chat", path.isEmpty, let last = app.chats.first(where: { !$0.archived }) { path = [.chat(last.id)] }
        }
        .sheet(item: $app.pendingConsent) { p in ConsentSheet(provider: p).modifier(Themed(appearance: appearance)) }
    }
}

/// "Send your messages to …?" — the same promise the web's ConsentSheet makes.
struct ConsentSheet: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.rx) private var rx
    @Environment(\.dismiss) private var dismiss
    let provider: Provider

    static func host(_ p: Provider) -> String {
        let h = URL(string: p.baseUrl)?.host ?? p.baseUrl
        return p.id == "openai" ? "\(h) (chatgpt.com when you sign in with ChatGPT)" : h
    }
    static func how(_ p: Provider) -> String {
        p.keyless ? "your subscription sign-in" : Subscriptions.spec(p.id) != nil ? "your API key or subscription sign-in" : "your API key"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("You chose a model that runs on \(provider.name)'s servers, not on this device. To answer, Radiant has to send the conversation there.")
                        .foregroundStyle(rx.label)
                    section("What is sent", "The messages in this conversation, any photo you attach, and the replies.")
                    section("Where it goes", "\(provider.name)'s servers at \(Self.host(provider)), using \(Self.how(provider)), under \(provider.name)'s privacy policy. Not to Templeton Technologies — we run no server and never see it.")
                    section("What is not sent", "Anything else on this device — your other chats, contacts, photos you did not attach, location. Models you download run entirely on the device and send nothing.")
                    Text("You can withdraw this any time by removing the \(provider.name) key or signing out in Settings › Cloud models.")
                        .font(.caption).foregroundStyle(rx.label3)
                    Link("Privacy policy", destination: URL(string: "https://www.templetongroup.dev/showcase/radiant/privacy.html")!)
                        .font(.footnote).tint(rx.tintText)
                }
                .padding(20)
            }
            .background(rx.bg)
            .navigationTitle("Send your messages to \(provider.name)?")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 10) {
                    Button { app.consentGranted(provider.id); dismiss() } label: {
                        Text("Allow").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6)
                    }
                    .buttonStyle(Prominent())
                    Button("Not now") { dismiss() }.foregroundStyle(rx.label2)
                }
                .padding(20)
            }
        }
        .presentationDetents([.large])
    }

    private func section(_ title: String, _ body: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(rx.label2)
            Text(body).foregroundStyle(rx.label)
        }
    }
}
