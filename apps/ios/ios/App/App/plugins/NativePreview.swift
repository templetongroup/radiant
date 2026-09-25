import SwiftUI
import UIKit
import Capacitor

/// The native app, opened over the web app while the rebuild is in progress.
///
/// ⚠️ A NATIVE REBUILD, SCREEN BY SCREEN. Tony saw Minis and chose native
/// ("Try swift ui and chat first", then "Go ahead"). The screens live in
/// App/Native/. Until every one of them exists, this plugin hosts them over
/// the web app: the web hands over its store when this opens (see KV in
/// NativeKit.swift), every write goes back as a "kv" event, a screen that is
/// not native yet is shown by the web ("navigate"), and "Use the current
/// design" closes this and turns the preference off.
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
        var snapshot: [String: String] = [:]
        if let store = call.getObject("store") {
            for (k, v) in store { if let s = v as? String { snapshot[k] = s } }
        }
        let animated = call.getBool("animated") ?? true
        DispatchQueue.main.async {
            guard self.host == nil else { return call.resolve() }
            guard let engine = self.bridge?.plugin(withName: "LocalModels") as? LocalModels,
                  let presenter = self.bridge?.viewController else {
                return call.reject("The model engine is not available.")
            }
            let kv = KV(snapshot)
            kv.onWrite = { [weak self] key, value in
                self?.notifyListeners("kv", data: ["key": key, "value": value ?? NSNull()])
            }
            let app = AppModel(kv: kv, engine: engine)
            app.openWeb = { [weak self] route in
                engine.stopTurn()
                NavTitles.window?.overrideUserInterfaceStyle = .unspecified
                self?.host?.dismiss(animated: false)
                self?.host = nil
                self?.notifyListeners("navigate", data: ["route": route])
            }
            app.close = { [weak self] in
                engine.stopTurn()
                kv.set("radiant.phone.nativeUI", string: "0")
                NavTitles.window?.overrideUserInterfaceStyle = .unspecified
                self?.host?.dismiss(animated: true)
                self?.host = nil
                self?.notifyListeners("closed", data: [:])
            }
            // Titles are drawn by UIKit, not SwiftUI, so the theme's label color is
            // given to it before the screens exist — a pinned theme's cream text
            // otherwise sits under a pure-white "Radiant".
            let appearance = Appearance(kv.json(Appearance.key))
            let pal = Themes.palette(appearance, systemDark: presenter.traitCollection.userInterfaceStyle == .dark)
            NavTitles.window = presenter.view.window
            NavTitles.style(appearance)
            NavTitles.recolor(pal.label)
            let vc = UIHostingController(rootView: NativeRoot().environmentObject(app).environmentObject(kv))
            vc.modalPresentationStyle = .fullScreen
            self.host = vc
            presenter.present(vc, animated: animated)
            call.resolve()
        }
    }
}

/// The native app's root: navigation, theme, and the cloud-permission sheet.
/// Where the native app can go.
enum Route: Hashable { case chat(String), models, settings, cloud, skills }

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
                            app.choose(modelId)
                            path = [.chat(app.newChat())]
                        })
                    case .settings: SettingsView(go: { path.append($0) })
                    case .cloud: CloudModelsView()
                    case .skills: SkillsView()
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

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("You chose a model that runs on \(provider.name)'s servers, not on this device. To answer, Radiant has to send the conversation there.")
                        .foregroundStyle(rx.label)
                    section("What is sent", "The messages in this conversation, any photo you attach, and the replies.")
                    section("Where it goes", "\(provider.name)'s servers at \(URL(string: provider.baseUrl)?.host ?? provider.baseUrl), using your API key, under \(provider.name)'s policy — not Templeton's.")
                    section("What is not sent", "Your other chats, your contacts, photos you did not attach, and your location.")
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
                    Button { Providers.grantConsent(app.kv, provider.id); dismiss() } label: {
                        Text("Allow").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
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
