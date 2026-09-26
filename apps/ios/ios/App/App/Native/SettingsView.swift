import SwiftUI
import AuthenticationServices

// Settings, Cloud models and Skills, native. Same choices, same stored shapes
// as SettingsScreen.jsx, ProvidersScreen.jsx and SkillsScreen.jsx.

struct SettingsView: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var kv: KV
    @Environment(\.rx) private var rx
    let go: (Route) -> Void
    @State private var confirmClear = false
    @State private var confirmRemoveAll = false

    private var a: Appearance { Appearance(kv.json(Appearance.key)) }
    private func update(_ f: (inout Appearance) -> Void) {
        var n = a; f(&n); kv.set(Appearance.key, json: n.json)
    }

    var body: some View {
        List {
            Section {
                Picker("Open to", selection: Binding(get: { a.openTo }, set: { v in update { $0.openTo = v } })) {
                    Text("Home").tag("home"); Text("Last chat").tag("chat")
                }.pickerStyle(.segmented)
            } header: { head("Open to") } footer: { foot("Whether Radiant opens on Home or straight back into the conversation you were last having.") }
            .listRowBackground(rx.cell)

            Section {
                Picker("Appearance", selection: Binding(get: { a.mode }, set: { v in update { $0.mode = v } })) {
                    Text("Dark").tag("dark"); Text("Medium").tag("medium"); Text("Light").tag("light"); Text("System").tag("system")
                }.pickerStyle(.segmented)
            } header: { head("Appearance") } footer: { foot("Radiant opens dark unless you change this.") }
            .listRowBackground(rx.cell)

            Section {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 10)], spacing: 10) {
                    ForEach(Themes.all, id: \.id) { t in
                        Button { update { $0.themeId = t.id } } label: {
                            HStack(spacing: 6) {
                                Circle().fill(Themes.swatch(t)).frame(width: 16, height: 16)
                                Text(t.name).font(.subheadline).lineLimit(1).minimumScaleFactor(0.8)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 10).padding(.vertical, 9)
                            .foregroundStyle(rx.label)
                            .background(rx.cell2, in: Capsule())
                            .overlay(Capsule().strokeBorder(a.themeId == t.id ? rx.tint : .clear, lineWidth: 2))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(t.name + (a.themeId == t.id ? ", selected" : ""))
                    }
                }
                .padding(.vertical, 4)
            } header: { head("Color") } footer: { foot("The color runs through the whole app — buttons, bubbles, and the logo that turns while a model downloads.") }
            .listRowBackground(rx.cell)

            Section {
                Picker("Text size", selection: Binding(get: { a.textScale }, set: { v in update { $0.textScale = v } })) {
                    Text("Small").tag(0.92); Text("Default").tag(1.0); Text("Large").tag(1.1); Text("Larger").tag(1.2)
                }.pickerStyle(.segmented)
            } header: { head("Text size") } footer: { foot("Rides on top of the system text size rather than replacing it, so Accessibility settings still win.") }
            .listRowBackground(rx.cell)

            Section {
                let installed = app.localModels
                row("Models", value: installed.isEmpty ? "None yet" : "\(installed.count) on this phone", icon: "square.stack.3d.up") { go(.models) }
                row("Cloud models", value: Providers.chosen(kv).map { Providers.shortName($0.model) } ?? "", icon: "cloud") { go(.cloud) }
                row("Skills", value: "\(app.skills.count)", icon: "wand.and.stars") { go(.skills) }
                row("Read me", value: "", icon: "book") { app.openWeb("readme") }
                if !installed.isEmpty {
                    Button("Remove all models", role: .destructive) { confirmRemoveAll = true }
                }
            }
            .listRowBackground(rx.cell)

            Section {
                Button("Clear all Radiant data", role: .destructive) { confirmClear = true }
            } footer: { foot("Deletes every conversation, draft, skill, and preference on this phone. Downloaded models and saved keys stay.") }
            .listRowBackground(rx.cell)

            Section {
                HStack { Text("Version").foregroundStyle(rx.label); Spacer(); Text(version).foregroundStyle(rx.label2).monospacedDigit() }
                Link("Radiant is a Templeton Technologies product.", destination: URL(string: "https://templetontech.com")!)
                    .font(.footnote).tint(rx.tintText)
                Button("Use the current design") { app.close() }.foregroundStyle(rx.tintText)
            }
            .listRowBackground(rx.cell)
        }
        .scrollContentBackground(.hidden)
        .background(rx.grouped)
        .navigationTitle("Settings")
        .confirmationDialog("Clear all Radiant data?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Clear everything", role: .destructive) { clearAll() }
        } message: { Text("Conversations, drafts, skills and preferences are deleted. It can't be undone.") }
        .confirmationDialog("Remove all models?", isPresented: $confirmRemoveAll, titleVisibility: .visible) {
            Button("Remove all", role: .destructive) {
                for m in app.localModels { app.engine.removeModel(m.id) }
                app.reload()
            }
        } message: { Text("Every downloaded model is deleted from this phone. You can download them again later.") }
    }

    private var version: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
        return "\(v) (\(b))"
    }

    private func clearAll() {
        // what the web's "Clear all" removes: everything it keeps in localStorage
        for k in kv.raw.keys where (k.hasPrefix("radiant.phone.") || k.hasPrefix("rx.")) && k != "radiant.phone.nativeUI" {
            kv.set(k, string: nil)
        }
        app.reload()
    }

    private func head(_ t: String) -> some View { Text(t).foregroundStyle(rx.label2) }
    private func foot(_ t: String) -> some View { Text(t).foregroundStyle(rx.label2) }
    private func row(_ title: String, value: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Label(title, systemImage: icon).foregroundStyle(rx.label)
                Spacer()
                Text(value).foregroundStyle(rx.label2).lineLimit(1)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(rx.label3)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Cloud models (ProvidersScreen.jsx)

struct CloudModelsView: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var kv: KV
    @Environment(\.rx) private var rx
    @State private var connected = Providers.connected()

    var body: some View {
        List {
            // Plans people already pay for come first: signing in costs nothing extra.
            Section {
                ForEach(Subscriptions.specs, id: \.id) { spec in
                    if let p = Providers.byId(spec.id) {
                        NavigationLink {
                            ProviderView(provider: p, connected: $connected)
                        } label: {
                            HStack {
                                Text(spec.label).foregroundStyle(rx.label)
                                if Subscriptions.stored(spec.id) != nil { Text("Signed in").font(.caption.weight(.semibold)).foregroundStyle(.green) }
                                if Providers.chosen(kv)?.providerId == p.id { Text("In use").font(.caption.weight(.semibold)).foregroundStyle(rx.tintText) }
                            }
                        }
                    }
                }
            } header: { Text("Sign in with a subscription").foregroundStyle(rx.label2) } footer: {
                Text("Use a plan you already pay for, with no API key. Claude subscriptions are not offered: Anthropic only allows them in its own apps.")
                    .foregroundStyle(rx.label2)
            }
            .listRowBackground(rx.cell)

            Section {
                ForEach(Providers.all.filter { !$0.keyless }) { p in
                    NavigationLink {
                        ProviderView(provider: p, connected: $connected)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(p.name).foregroundStyle(rx.label)
                                if Keychain.get(p.id) != nil { Text("Connected").font(.caption.weight(.semibold)).foregroundStyle(.green) }
                                if Providers.chosen(kv)?.providerId == p.id { Text("In use").font(.caption.weight(.semibold)).foregroundStyle(rx.tintText) }
                            }
                            Text(p.hint).font(.caption).foregroundStyle(rx.label2).lineLimit(2)
                        }
                    }
                }
            } header: { Text("API keys").foregroundStyle(rx.label2) } footer: {
                Text("Keys and sign-ins are kept in this phone's Keychain and sent only to that provider. A cloud model answers on the provider's servers, not on this phone.")
                    .foregroundStyle(rx.label2)
            }
            .listRowBackground(rx.cell)
        }
        .scrollContentBackground(.hidden)
        .background(rx.grouped)
        .navigationTitle("Cloud models")
    }
}

struct ProviderView: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var kv: KV
    @Environment(\.rx) private var rx
    let provider: Provider
    @Binding var connected: Set<String>
    @State private var key = ""
    @State private var problem: String?
    @State private var models: [String] = []
    @State private var loading = false
    @State private var error: String?
    @State private var query = ""
    @State private var askConsent = false
    @State private var consentFor: (() -> Void)?
    @State private var signing: Task<Void, Never>?
    @State private var device: DeviceStart?
    @State private var subError: String?
    @State private var signedIn = false
    @Environment(\.openURL) private var openURL
    private var spec: SubSpec? { Subscriptions.spec(provider.id) }

    private var isConnected: Bool { connected.contains(provider.id) }
    private var shown: [String] {
        let f = query.isEmpty ? models : models.filter { $0.localizedCaseInsensitiveContains(query) }
        return Array(f.prefix(query.isEmpty ? 12 : 60))
    }

    var body: some View {
        List {
            if let spec { subscription(spec) }
            if !provider.keyless { Section {
                SecureField(isConnected ? "Paste a new key to replace" : "Paste your API key", text: $key)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .foregroundStyle(rx.label)
                if let problem { Text(problem).font(.caption).foregroundStyle(.red) }
                Button(isConnected ? "Replace key" : "Save key") { save() }
                    .disabled(key.trimmingCharacters(in: .whitespaces).isEmpty)
                if Keychain.get(provider.id) != nil {
                    Button("Remove key", role: .destructive) {
                        Keychain.remove(provider.id)
                        disconnected()
                    }
                }
            } header: { Text("API key").foregroundStyle(rx.label2) } footer: { Text(provider.hint).foregroundStyle(rx.label2) }
            .listRowBackground(rx.cell) }

            if isConnected {
                Section {
                    if loading { Text("Asking \(provider.name) what it can run…").foregroundStyle(rx.label2) }
                    if let error { Text(error).foregroundStyle(.red) }
                    ForEach(shown, id: \.self) { m in
                        Button {
                            let chosen = Providers.chosen(kv)
                            if chosen?.providerId == provider.id && chosen?.model == m { Providers.setChosen(kv, nil) }
                            else { Providers.setChosen(kv, (provider.id, m)) }
                            app.objectWillChange.send()
                        } label: {
                            HStack {
                                Text(m).foregroundStyle(rx.label).lineLimit(1)
                                Spacer()
                                if Providers.chosen(kv)?.providerId == provider.id && Providers.chosen(kv)?.model == m {
                                    Image(systemName: "checkmark").foregroundStyle(rx.tint)
                                }
                            }
                        }
                    }
                    if models.count > shown.count {
                        Text("\(models.count - shown.count) more — keep typing to narrow it down").font(.caption).foregroundStyle(rx.label2)
                    }
                } header: { Text("Models").foregroundStyle(rx.label2) }
                .listRowBackground(rx.cell)
            }
        }
        .scrollContentBackground(.hidden)
        .background(rx.grouped)
        .navigationTitle(provider.name)
        .searchable(text: $query, prompt: "Search \(models.count) models")
        .task(id: isConnected) { if isConnected { await load() } }
        .onAppear { signedIn = Subscriptions.stored(provider.id) != nil }
        .onDisappear { signing?.cancel() }
        .sheet(isPresented: $askConsent) {
            ConsentSheet(provider: provider).onDisappear {
                if Providers.hasConsent(kv, provider.id) { consentFor?() }
                consentFor = nil
            }
        }
    }

    /// Sign in with a subscription instead of a key (Subscriptions.swift).
    @ViewBuilder private func subscription(_ spec: SubSpec) -> some View {
        Section {
            if signedIn {
                Label("Signed in with \(spec.label)", systemImage: "checkmark.seal.fill").foregroundStyle(rx.label)
                Button("Sign out", role: .destructive) {
                    Subscriptions.signOut(provider.id); signedIn = false
                    disconnected()
                }
            } else if let device {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Enter this code on the page that opened:").font(.subheadline).foregroundStyle(rx.label2)
                    Text(device.user).font(.system(.title, design: .monospaced).weight(.semibold)).foregroundStyle(rx.label)
                        .textSelection(.enabled)
                    Text("It is already copied. Come back here when the page says you are done.").font(.caption).foregroundStyle(rx.label2)
                }
                Button("Copy code and open the page again") { UIPasteboard.general.string = device.user; openURL(device.url) }
                Button("Cancel", role: .cancel) { signing?.cancel() }
            } else if signing != nil {
                HStack { ProgressView(); Text("Signing in…").foregroundStyle(rx.label2) }
            } else {
                Button("Sign in with \(spec.label)") { withConsent(signIn) }
            }
            if let subError { Text(subError).font(.caption).foregroundStyle(.red) }
        } header: { Text("Subscription").foregroundStyle(rx.label2) } footer: {
            Text("Uses the plan you already pay for instead of an API key. This is the same sign-in \(spec.mode == .browser ? "Codex" : "the provider's own command-line tool") uses, not an official way in, so the provider can change or stop it at any time.")
                .foregroundStyle(rx.label2)
        }
        .listRowBackground(rx.cell)
    }

    private func signIn() {
        guard let spec else { return }
        subError = nil
        signing = Task {
            do {
                switch spec.mode {
                case .browser: try await Subscriptions.signInBrowser(spec)
                case .device:
                    let d = try await Subscriptions.startDevice(spec)
                    device = d
                    UIPasteboard.general.string = d.user
                    openURL(d.url)
                    try await Subscriptions.finishDevice(spec, device: d.device, verifier: d.verifier, interval: d.interval)
                }
                signedIn = true
                connected.insert(provider.id)
            } catch is CancellationError {
            } catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin {
            } catch { subError = error.localizedDescription }
            device = nil; signing = nil
        }
    }

    /// Nothing left to reach this provider with: forget the permission and the choice.
    private func disconnected() {
        guard Keychain.get(provider.id) == nil, Subscriptions.stored(provider.id) == nil else { return }
        Providers.revokeConsent(kv, provider.id)
        if Providers.chosen(kv)?.providerId == provider.id { Providers.setChosen(kv, nil) }
        connected.remove(provider.id); models = []
    }

    /// The provider sees your words only after you have said it may.
    private func withConsent(_ then: @escaping () -> Void) {
        if Providers.hasConsent(kv, provider.id) { then() } else { consentFor = then; askConsent = true }
    }

    private func save() {
        if let p = Providers.looksWrong(provider, key) { problem = p; return }
        problem = nil
        withConsent(store)
    }

    private func store() {
        guard Keychain.set(provider.id, key.trimmingCharacters(in: .whitespacesAndNewlines)) else { problem = "The Keychain would not save it."; return }
        key = ""; connected.insert(provider.id)
    }

    private func load() async {
        loading = true; error = nil
        defer { loading = false }
        do { models = try await CloudStream.models(provider: provider.id, baseUrl: provider.baseUrl) }
        catch { self.error = error.localizedDescription }
    }
}

// MARK: - Skills (SkillsScreen.jsx)

struct SkillsView: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var kv: KV
    @Environment(\.rx) private var rx
    @State private var editing: Skill?
    @State private var creating = false
    @State private var pasting = false
    @State private var fromMac = false

    var body: some View {
        List {
            Section {
                ForEach(app.skills) { s in
                    Button { editing = s } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack { Text(s.name).foregroundStyle(rx.label); Text("/" + s.slug).font(.caption.monospaced()).foregroundStyle(rx.tintText) }
                            Text(s.body).font(.caption).foregroundStyle(rx.label2).lineLimit(2)
                        }
                    }
                    .swipeActions { Button("Delete", role: .destructive) { Skills.delete(kv, s.id); app.objectWillChange.send() } }
                }
            } footer: {
                Text("A skill is standing instructions for the model — tone, format, a way of working. Pick one with the slash button in a chat, or type / and its name.")
                    .foregroundStyle(rx.label2)
            }
            .listRowBackground(rx.cell)
        }
        .scrollContentBackground(.hidden)
        .background(rx.grouped)
        .navigationTitle("Skills")
        .toolbar {
            Menu {
                Button("New skill", systemImage: "plus") { creating = true }
                Button("Paste a SKILL.md", systemImage: "doc.on.clipboard") { pasting = true }
                Button("From Radiant on your Mac", systemImage: "desktopcomputer") { fromMac = true }
            } label: { Image(systemName: "plus").accessibilityLabel("Add a skill") }
        }
        .sheet(item: $editing) { s in SkillEditor(skill: s) }
        .sheet(isPresented: $creating) { SkillEditor(skill: nil) }
        .sheet(isPresented: $pasting) { SkillPaste() }
        .sheet(isPresented: $fromMac) { MacSkills() }
    }
}

struct SkillEditor: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var kv: KV
    @Environment(\.dismiss) private var dismiss
    let skill: Skill?
    @State private var name = ""
    @State private var text = ""

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name).onChange(of: name) { if name.count > 60 { name = String(name.prefix(60)) } }
                Section {
                    TextEditor(text: $text).frame(minHeight: 180)
                        .onChange(of: text) { if text.count > Skills.maxChars { text = String(text.prefix(Skills.maxChars)) } }
                } footer: {
                    let left = Skills.maxChars - text.count
                    Text(left < 200 ? "\(left) characters left — shorter instructions work better here" : "\(text.count) characters")
                        .foregroundStyle(left < 200 ? .orange : .secondary)
                }
            }
            .navigationTitle(skill == nil ? "New skill" : "Edit skill")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Skills.upsert(kv, id: skill?.id, name: name, body: text); app.objectWillChange.send(); dismiss() }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear { name = skill?.name ?? ""; text = skill?.body ?? "" }
        }
    }
}

/// A SKILL.md pasted in: front matter `name:`, else a leading # heading (parseSkillMarkdown).
struct SkillPaste: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var kv: KV
    @Environment(\.dismiss) private var dismiss
    @State private var raw = ""

    static func parse(_ raw: String) -> (name: String, body: String) {
        var body = raw, name = ""
        if let fm = raw.range(of: "^---\\s*\\n([\\s\\S]*?)\\n---\\s*\\n?", options: .regularExpression) {
            let meta = String(raw[fm])
            if let m = meta.range(of: "(?m)^name:\\s*(.+)$", options: .regularExpression) {
                name = String(meta[m]).replacingOccurrences(of: "name:", with: "").trimmingCharacters(in: CharacterSet(charactersIn: " \"'>"))
            }
            body = String(raw[fm.upperBound...])
        }
        body = body.trimmingCharacters(in: .whitespacesAndNewlines)
        if let h1 = body.range(of: "^#\\s+(.+)\\s*\\n+", options: .regularExpression) {
            if name.isEmpty { name = String(body[h1]).replacingOccurrences(of: "#", with: "").trimmingCharacters(in: .whitespacesAndNewlines) }
            body = String(body[h1.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return (String(name.prefix(60)), body)
    }

    var body: some View {
        let p = Self.parse(raw)
        NavigationStack {
            Form {
                Section { TextEditor(text: $raw).frame(minHeight: 220).font(.callout.monospaced()) } footer: {
                    if raw.isEmpty { Text("Paste the whole file. Its name comes from `name:` at the top, or from its first # heading.") }
                    else if p.body.count > Skills.maxChars { Text("That is \(p.body.count) characters; the phone takes \(Skills.maxChars). Nothing is cut — shorten it first.").foregroundStyle(.orange) }
                    else { Text("“\(p.name.isEmpty ? "Untitled" : p.name)” · \(p.body.count) characters") }
                }
            }
            .navigationTitle("Paste a SKILL.md").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Skills.upsert(kv, id: nil, name: p.name.isEmpty ? "Untitled" : p.name, body: p.body); app.objectWillChange.send(); dismiss() }
                        .disabled(p.body.isEmpty || p.body.count > Skills.maxChars)
                }
            }
        }
    }
}

/// Take skills from Radiant on the Mac (fetchMacSkills). The address and token
/// stay in the Keychain as `radiant.phone.mac`.
struct MacSkills: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var kv: KV
    @Environment(\.dismiss) private var dismiss
    @State private var base = ""
    @State private var token = ""
    @State private var rows: [(id: String, name: String, body: String, reason: String?)] = []
    @State private var error: String?
    @State private var taken: Set<String> = []

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Your Mac — 100.x.y.z:5834", text: $base).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    SecureField("Sharing token", text: $token)
                    Button("Show its skills") { Task { await fetch() } }.disabled(base.isEmpty)
                } footer: { Text("On the Mac: Settings → Devices & sharing shows the address and the token.") }
                if let error { Text(error).foregroundStyle(.red) }
                ForEach(rows, id: \.id) { r in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(r.name)
                            if let why = r.reason { Text(why).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        if taken.contains(r.id) { Image(systemName: "checkmark").foregroundStyle(.green) }
                        else if r.reason == nil {
                            Button("Take") { Skills.upsert(kv, id: nil, name: r.name, body: r.body); taken.insert(r.id); app.objectWillChange.send() }
                                .buttonStyle(.bordered)
                        }
                    }
                }
            }
            .navigationTitle("Skills from your Mac").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear {
                if let s = Keychain.get("radiant.phone.mac"), let d = s.data(using: .utf8),
                   let j = try? JSONSerialization.jsonObject(with: d) as? [String: String] { base = j["base"] ?? ""; token = j["token"] ?? "" }
            }
        }
    }

    private func origin() -> URL? {
        var v = base.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if !v.lowercased().hasPrefix("http") { v = "http://" + v }
        guard let u = URL(string: v), let host = u.host else { return nil }
        return URL(string: "\(u.scheme ?? "http")://\(host)\(u.port.map { ":\($0)" } ?? "")")
    }

    private func fetch() async {
        error = nil
        guard let o = origin() else { error = "That address does not look right."; return }
        var req = URLRequest(url: o.appendingPathComponent("api/config"))
        if !token.isEmpty { req.setValue(token, forHTTPHeaderField: "x-radiant-token") }
        req.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if status == 401 || status == 403 { error = "The Mac refused that token."; return }
            guard status == 200 else { error = "The Mac answered \(status)."; return }
            let cfg = (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            rows = (cfg["skills"] as? [[String: Any]] ?? []).map { sk in
                let body = (sk["content"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let reason: String? = sk["dir"] != nil && !(sk["dir"] is NSNull) ? "needs a folder — Mac only"
                    : body.isEmpty ? "empty" : body.count > Skills.maxChars ? "too long for the phone (\(body.count) characters)" : nil
                return (sk["id"] as? String ?? UUID().uuidString, sk["name"] as? String ?? "Untitled", body, reason)
            }
            if rows.isEmpty { error = "That Mac has no skills yet." }
            if let d = try? JSONSerialization.data(withJSONObject: ["base": base, "token": token]), let s = String(data: d, encoding: .utf8) {
                Keychain.set("radiant.phone.mac", s)
            }
        } catch { self.error = "Could not reach the Mac: \(error.localizedDescription)" }
    }
}
