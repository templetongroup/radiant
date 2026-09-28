import SwiftUI
import UIKit
#if canImport(FoundationModels)
import FoundationModels
#endif

// Models: what is on this phone, what else there is (by maker, A to Z), whether
// each one will run here, downloads with real progress, and Hugging Face search.
// The rules are the web's: src/fit.js + src/mobile/fit.js, hf.js, progress.js.

enum Fit: String {
    case well, tight, no
    static let comfortable = 0.75, edge = 0.95   // COMFORTABLE, EDGE in src/fit.js

    /// Memory a model needs to run: the download plus the runtime.
    static func need(_ gb: Double) -> Double { gb * 1.05 + 0.35 }

    static func of(_ gb: Double, budgetBytes: Double) -> Fit? {
        guard gb > 0, budgetBytes > 0 else { return nil }
        let n = need(gb), b = budgetBytes / 1e9
        return n <= b * comfortable ? .well : n <= b * edge ? .tight : .no
    }

    var label: String { self == .well ? "Runs well" : self == .tight ? "Runs tight" : "Won't run" }
    var color: Color { self == .well ? .green : self == .tight ? .orange : .red }
    func why(_ device: String) -> String {
        switch self {
        case .well: return "Comfortable on this \(device)."
        case .tight: return "Fits, but close to the limit — expect it to be slow, and to reload if you switch apps."
        case .no: return "Needs more memory than this \(device) can give one app."
        }
    }
}

struct Progress: Equatable { var pct: Double?; var done: Double }

private func gbText(_ gb: Double) -> String { String(format: "%.1f GB", gb) }

@MainActor
final class ModelsModel: ObservableObject {
    /// The one model the empty hero and the sheet recommend (RECOMMENDED_ID in ModelsScreen.jsx).
    static let recommendedId = "qwen3-1.7b"

    let engine: LocalModels
    @Published var rows: [LocalModels.CatalogRow] = []
    @Published var progress: [String: Progress] = [:]
    @Published var preparing: Set<String> = []
    @Published var failed: [String: String] = [:]
    /// Models added from Hugging Face before a check existed (a draft model,
    /// say) are checked again here; the verdict replaces the size-only label.
    @Published var refused: [String: (label: String, why: String)] = [:]
    private var checked: Set<String> = []
    @Published var disk: (free: Int64, total: Int64) = (0, 0)
    /// Measured bytes of each downloaded model, for the storage line.
    @Published var sizes: [String: Int64] = [:]
    /// A download that finished AND is really on disk — the sheet that started it opens the chat.
    @Published var justDone: String?
    let budget: Double
    let spec = LocalModels.deviceSummary()
    private var token: UUID?
    private var spoken: [String: Int] = [:]   // the last 25% step announced, per download
    var onChange: () -> Void = {}
    /// After a verified download: the view asks for a rating here.
    var onDownloaded: () -> Void = {}

    init(engine: LocalModels) {
        self.engine = engine
        budget = engine.memoryBudget()
        refresh()
        token = engine.observe { [weak self] event, d in self?.handle(event, d) }
    }
    deinit { if let token { let e = engine; Task { @MainActor in e.unobserve(token) } } }

    func refresh() {
        rows = engine.catalogRows()
        disk = engine.disk()
        sizes = Dictionary(uniqueKeysWithValues: rows.filter(\.downloaded).map { ($0.id, engine.bytesOnDisk($0.id)) })
        // a download that started before this screen opened is still running
        for r in rows where engine.isDownloading(r.id) && progress[r.id] == nil { progress[r.id] = Progress(pct: nil, done: 0) }
        for r in rows where r.custom && !r.downloaded && !checked.contains(r.id) {
            checked.insert(r.id)
            Task {
                guard let info = try? await HF.inspect(r.repo) else { return }
                let v = HF.qualify(info, fit: fit(r))
                if !v.ok { refused[r.id] = (v.label, v.why) }
            }
        }
    }

    func name(_ id: String) -> String { rows.first { $0.id == id }?.name ?? "Another model" }

    private func announce(_ s: String) { AccessibilityNotification.Announcement(s).post() }

    private func handle(_ event: String, _ d: [String: Any]) {
        guard let id = d["id"] as? String else { return }
        switch event {
        case "downloadStarted":
            progress[id] = Progress(pct: nil, done: 0); failed[id] = nil; spoken[id] = 0
            announce("Downloading \(name(id))")
        case "downloadProgress":
            // a stop clears the row at once; a late progress event must not bring it back
            guard progress[id] != nil else { return }
            let p = d["progress"] as? Double ?? -1
            progress[id] = Progress(pct: p >= 0 ? p : nil, done: (d["completedBytes"] as? Double) ?? Double(d["completedBytes"] as? Int64 ?? 0))
            // every 25%, not every 1% (the Announcer in ModelsScreen.jsx)
            if p >= 0 { let step = Int(p * 100) / 25 * 25
                if step > (spoken[id] ?? 0), step < 100 { spoken[id] = step; announce("Downloading \(name(id)), \(step) percent") } }
        case "downloadPreparing": preparing.insert(id)
        case "downloadDone":
            progress[id] = nil; preparing.remove(id); refresh(); onChange()
            verify(id)
        case "downloadCancelled": progress[id] = nil; preparing.remove(id); failed[id] = nil; disk = engine.disk()
        case "downloadFailed":
            progress[id] = nil; preparing.remove(id)
            let why = d["message"] as? String ?? "The download did not finish."
            failed[id] = why
            Haptic.error()
            announce("\(name(id)) failed. \(why)")
        default: break
        }
    }

    /// A finished download the app then does not recognise must say so (useLocalModels.js).
    private func verify(_ id: String) {
        if let c = engine.downloadCheck(id), !c.onDisk {
            let why = c.hasReceipt
                ? String(format: "The download finished but Radiant found only %.2f GB of the %.2f GB expected in %@. The files may be incomplete, or the repo may store them elsewhere.",
                         Double(c.bytes) / 1e9, Double(c.expected) / 1e9, c.folder)
                : "The download finished but was not recorded. Try again."
            failed[id] = why
            Haptic.error()
            announce("\(name(id)) failed. \(why)")
            return
        }
        Haptic.success()
        announce("\(name(id)) downloaded.")
        justDone = id
        onDownloaded()
    }

    func fit(_ r: LocalModels.CatalogRow) -> Fit? { Fit.of(r.gb, budgetBytes: budget) }

    /// Bytes short of room for this model; 0 when it fits, or when the disk is unknown (no claim without data).
    func shortBy(_ r: LocalModels.CatalogRow) -> Double {
        guard disk.total > 0, !r.downloaded else { return 0 }
        return max(0, r.gb * 1e9 - Double(disk.free))
    }

    /// Some OTHER model is downloading (preparing does not count — its bytes are in).
    func busyElsewhere(_ id: String) -> Bool { progress.keys.contains { $0 != id && !preparing.contains($0) } }

    /// "42%", or the megabytes when the total is not known; nil = say Downloading…
    static func text(_ p: Progress?) -> String? {
        guard let p else { return nil }
        if let pct = p.pct { return "\(Int((pct * 100).rounded()))%" }
        if p.done > 0 { return p.done >= 1e9 ? String(format: "%.1f GB", p.done / 1e9) : "\(Int(p.done / 1e6)) MB" }
        return nil
    }

    func download(_ id: String) {
        // One at a time, but say so — a guard that refuses without a word is a silent failure.
        if let busy = progress.keys.first(where: { $0 != id && !preparing.contains($0) }) {
            failed[id] = "\(name(busy)) is downloading. Wait for it to finish, or stop it first."
            Haptic.warning()
            return
        }
        failed[id] = nil
        guard engine.knows(id) else {
            progress[id] = nil
            failed[id] = "The download did not start."
            Haptic.error()
            return
        }
        Haptic.tap(.medium)
        progress[id] = Progress(pct: nil, done: 0)
        engine.startDownload(id)
    }

    /// Clears the row at once; downloadCancelled confirms it. Preparing cannot be stopped — the bytes are in.
    func stop(_ id: String) {
        guard !preparing.contains(id) else { return }
        Haptic.tap(.medium)
        progress[id] = nil
        engine.stopDownload(id)
    }

    func remove(_ r: LocalModels.CatalogRow) {
        if r.custom { engine.removeCustomModel(r.id) } else { engine.removeModel(r.id) }
        failed[r.id] = nil
        refresh(); onChange()
    }

    var usedBytes: Int64 { sizes.values.reduce(0, +) }

    /// Makers A to Z, models A to Z inside each, numbers as numbers (makers.js).
    /// Downloaded models stay on their shelf, with a tick.
    var shelves: [(maker: String, models: [LocalModels.CatalogRow])] {
        let groups = Dictionary(grouping: rows, by: \.maker)
        return groups.keys.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
            .map { ($0, groups[$0]!.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }) }
    }
}

extension AppleLM {
    /// Why Apple's model cannot answer, in words a person can act on (AppleModel.swift availability).
    static var reason: String {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            if case .unavailable(let why) = SystemLanguageModel.default.availability {
                switch why {
                case .deviceNotEligible: return "This \(Device.word) does not support Apple Intelligence."
                case .appleIntelligenceNotEnabled: return "Turn on Apple Intelligence in Settings to use Apple's model."
                case .modelNotReady: return "Apple's model is still downloading in the background. Try again shortly."
                @unknown default: break
                }
            }
            return "Apple's model is not available on this \(Device.word) right now."
        }
        #endif
        return "Apple's model needs iOS 26 or later."
    }
}

struct ModelsView: View {
    @EnvironmentObject var app: AppModel
    @StateObject private var models: ModelsModel
    @Environment(\.rx) private var rx
    @Environment(\.scenePhase) private var scenePhase
    @State private var open: Set<String> = []
    @State private var detail: LocalModels.CatalogRow?
    let startChat: (String) -> Void

    init(engine: LocalModels, startChat: @escaping (String) -> Void) {
        _models = StateObject(wrappedValue: ModelsModel(engine: engine))
        self.startChat = startChat
    }

    /// The model a new chat would use, if it is Apple's or one on this device (not a cloud one).
    private var heroModel: (id: String, name: String, gb: Double?)? {
        var here: [(id: String, name: String, gb: Double?)] = AppleLM.available ? [(AppleLM.id, "Apple Intelligence", nil)] : []
        here += models.rows.filter(\.downloaded).map { ($0.id, $0.name, $0.gb) }
        return here.first { $0.id == app.currentModelId } ?? here.first
    }

    /// Opens the empty hero: the recommendation, falling back to the smallest.
    private var pick: LocalModels.CatalogRow? {
        models.rows.first { $0.id == ModelsModel.recommendedId } ?? models.rows.min { $0.gb < $1.gb }
    }

    var body: some View {
        let installed = models.rows.filter(\.downloaded)
        List {
            Section { hero }.listRowBackground(Color.clear)

            Section {
                appleRow
            } header: { Text("Already on this \(Device.word)").foregroundStyle(rx.label2) } footer: {
                Text(AppleLM.available
                     ? "Apple’s own model, already on this \(Device.word). Free, works offline, and nothing is downloaded. The models below are yours to keep and are usually better at longer work."
                     : "Radiant can use Apple’s built-in model when it is available. The models below run on this \(Device.word) regardless.")
                    .foregroundStyle(rx.label2)
            }
            .listRowBackground(rx.cell)

            if let c = Providers.chosen(app.kv) {
                let id = "cloud:\(c.providerId):\(c.model)"
                Section {
                    Button { startChat(id) } label: {
                        rowLabel(title: Providers.shortName(c.model), subtitle: "Cloud · \(Providers.byId(c.providerId)?.name ?? c.providerId)", current: app.currentModelId == id)
                    }.buttonStyle(.plain)
                } header: { Text("Cloud").foregroundStyle(rx.label2) }
                .listRowBackground(rx.cell)
            }

            if !installed.isEmpty {
                Section {
                    ForEach(installed) { r in installedRow(r) }
                } header: { Text("On this \(Device.word)").foregroundStyle(rx.label2) } footer: {
                    Text("Tap one to start a conversation with it. Tap Manage to remove it.").foregroundStyle(rx.label2)
                }
                .listRowBackground(rx.cell)
            }

            Section {
                NavigationLink { HFSearchView(models: models, startChat: startChat) } label: {
                    Label("Search Hugging Face", systemImage: "magnifyingglass").foregroundStyle(rx.label)
                }
            }
            .listRowBackground(rx.cell)

            Section { specs }.listRowBackground(rx.cell)

            ForEach(models.shelves, id: \.maker) { shelf in
                Section {
                    DisclosureGroup(isExpanded: Binding(get: { open.contains(shelf.maker) }, set: { if $0 { open.insert(shelf.maker) } else { open.remove(shelf.maker) } })) {
                        ForEach(shelf.models) { r in catalogRow(r) }
                    } label: {
                        HStack {
                            Text(shelf.maker).font(.headline).foregroundStyle(rx.label)
                            Spacer()
                            Text(shelfMeta(shelf.models)).font(.caption).foregroundStyle(rx.label2)
                        }
                    }
                }
                .listRowBackground(rx.cell)
            }
            if models.rows.isEmpty {
                Section { Text("No models are available on this device.").font(.subheadline).foregroundStyle(rx.label2) }
                    .listRowBackground(rx.cell)
            }
            // the privacy claim, in the quietest text on the screen
            Section {} footer: {
                Text("A model you download runs on this \(Device.word), and nothing you send it leaves the device. A provider you add in Settings is a network service, and what you send there goes to them.")
                    .foregroundStyle(rx.label2)
            }
        }
        .scrollContentBackground(.hidden)
        .readingWidth()
        .background(rx.grouped)
        .safeAreaInset(edge: .bottom) { if models.disk.total > 0 { storage } }
        .navigationTitle("Models")
        .sheet(item: $detail) { r in
            ModelDetail(row: r, models: models, startChat: { detail = nil; startChat($0) })
                .presentationDetents(r.downloaded ? [.medium] : [.large])
        }
        .onAppear {
            models.onChange = { app.reload() }
            models.onDownloaded = { Rating.maybeAsk(app.kv, turns: app.chats.reduce(0) { $0 + $1.messages.filter { $0.role == "user" }.count }) }
            models.refresh()
        }
        .onChange(of: scenePhase) { _, p in if p == .active { models.refresh() } }
        .refreshable { models.refresh() }
    }

    // MARK: hero

    private var hero: some View {
        let m = heroModel
        let state = m.map { $0.gb.map { "Ready on this \(Device.word) · " + gbText($0) } ?? "Built into iOS · nothing to download" }
            ?? "Choose a model to run on this \(Device.word)"
        let spoken = m.map { m in m.gb.map { "\(m.name), ready on this \(Device.word), \(gbText($0)). Opens the conversation." }
            ?? "\(m.name), built into iOS, nothing to download. Opens the conversation." } ?? "No model yet. Choose a model to download."
        return Button {
            if let m { startChat(m.id) } else if let pick { detail = pick }
        } label: {
            HStack(spacing: 16) {
                Image("LogoMark").renderingMode(.template).resizable().scaledToFit()
                    .frame(width: 72, height: 72).foregroundStyle(m == nil ? rx.label3 : rx.tintText)
                VStack(alignment: .leading, spacing: 4) {
                    Text(m?.name ?? "No model yet").font(.title2.weight(.bold)).foregroundStyle(rx.label)
                    HStack(spacing: 4) {
                        Text(state).font(.footnote).monospacedDigit().foregroundStyle(rx.label2)
                        Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(rx.label3)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(m == nil && pick == nil)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
        .accessibilityAddTraits(.isButton)
    }

    // MARK: rows

    private var appleRow: some View {
        let ok = AppleLM.available
        return Button { startChat(AppleLM.id) } label: {
            rowLabel(title: "Apple Intelligence", subtitle: ok ? "Built into iOS · nothing to download" : AppleLM.reason,
                     current: ok && app.currentModelId == AppleLM.id, chevron: ok)
        }
        .buttonStyle(.plain)
        .disabled(!ok)
        .opacity(ok ? 1 : 0.55)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ok ? "Chat with Apple Intelligence\(app.currentModelId == AppleLM.id ? ", current model" : ""), built into iOS"
                               : "Apple Intelligence unavailable. \(AppleLM.reason)")
    }

    private func installedRow(_ r: LocalModels.CatalogRow) -> some View {
        let current = app.currentModelId == r.id
        return Button { startChat(r.id) } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(r.name).foregroundStyle(rx.label)
                        if current { Text("Current").font(.caption.weight(.semibold)).foregroundStyle(rx.tintText) }
                    }
                    Text(gbText(r.gb) + " on this \(Device.word)").font(.caption).foregroundStyle(rx.label2)
                }
                Spacer()
                Button("Manage") { detail = r }
                    .buttonStyle(.plain).font(.subheadline).foregroundStyle(rx.tintText)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .swipeActions { Button("Remove", role: .destructive) { models.remove(r) } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Chat with \(r.name)\(current ? ", current model" : "")")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: "Manage \(r.name)") { detail = r }
    }

    private func rowLabel(title: String, subtitle: String, current: Bool, chevron: Bool = true) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(rx.label)
                Text(subtitle).font(.caption).foregroundStyle(rx.label2)
            }
            Spacer()
            if current { Text("Current").font(.caption.weight(.semibold)).foregroundStyle(rx.tintText) }
            if chevron { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(rx.label3) }
        }
        .contentShape(Rectangle())
        .listRowBackground(rx.cell)
    }

    /// "3 models · 2 run here", nothing about running before the budget is known (MakerSection.jsx).
    private func shelfMeta(_ rows: [LocalModels.CatalogRow]) -> String {
        let count = "\(rows.count) model\(rows.count == 1 ? "" : "s")"
        guard models.budget > 0 else { return count }
        let runs = rows.filter { models.fit($0) != .no }.count
        return count + (runs == 0 ? " · none run here" : " · \(runs) run\(runs == 1 ? "s" : "") here")
    }

    private func catalogRow(_ r: LocalModels.CatalogRow) -> some View {
        let fit = models.fit(r)
        let p = models.progress[r.id]
        let preparing = models.preparing.contains(r.id)
        let failure = p == nil ? models.failed[r.id] : nil
        let short = p == nil ? models.shortBy(r) : 0
        let tooBig = fit == .no && !r.downloaded
        let busy = models.busyElsewhere(r.id)
        let pct = p?.pct.map { Int(($0 * 100).rounded()) }
        let shown = ModelsModel.text(p)
        let spoken = "\(r.name), \(gbText(r.gb))" + (
            r.downloaded ? ", on this \(Device.word)"
            : preparing ? ", downloaded, preparing the model"
            : p != nil ? ", downloading" + (pct.map { ", \($0) percent" } ?? "")
            : short > 0 ? ", not enough room"
            : fit.map { ", \($0.label.lowercased()) on this \(Device.word)" } ?? "")
        let accessory: (name: String, run: () -> Void)? =
            r.downloaded ? ("Chat with \(r.name)", { startChat(r.id) })
            : preparing ? nil
            : p != nil ? ("Stop downloading \(r.name)" + (shown.map { ", \($0) done" } ?? ""), { models.stop(r.id) })
            : short > 0 || busy ? nil
            : ("Download \(r.name)", { models.download(r.id) })
        return Button { detail = r } label: {
            HStack(alignment: .top) {
                // While it downloads, the logo turns beside the name and the
                // trailing control is a plain stop square — one moving thing per row.
                if p != nil { Swirl().padding(.top, 1) }
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(r.name).foregroundStyle(rx.label)
                        if !r.downloaded && p == nil && failure == nil {
                            if let no = models.refused[r.id] { Text(no.label).font(.caption.weight(.semibold)).foregroundStyle(.red) }
                            else if let fit { Text(fit.label).font(.caption.weight(.semibold)).foregroundStyle(fit.color) }
                        }
                    }
                    Group {
                        if p != nil {
                            Text(preparing ? "Preparing the model…" : "Downloading…" + (shown.map { " " + $0 } ?? "")).monospacedDigit().foregroundStyle(rx.label2)
                        } else if let failure {
                            Text((failure.hasSuffix(".") ? String(failure.dropLast()) : failure) + ". Tap to try again.").foregroundStyle(.red)
                        } else if short > 0 {
                            Text("Needs \(gbText(short / 1e9)) more room").foregroundStyle(.orange)
                        } else if tooBig {
                            Text(String(format: "Needs about %.1f GB of memory", Fit.need(r.gb))).foregroundStyle(rx.label2)
                        } else {
                            Text(gbText(r.gb) + " · " + Device.text(r.blurb)).foregroundStyle(rx.label2).lineLimit(2)
                        }
                    }
                    .font(.caption).lineLimit(4)
                    if p == nil, failure == nil, let why = models.refused[r.id]?.why { Text(why).font(.caption).foregroundStyle(.red).lineLimit(3) }
                }
                Spacer()
                if r.downloaded {
                    Button { startChat(r.id) } label: { Image(systemName: "checkmark").font(.body.weight(.semibold)).frame(width: 29, height: 29) }
                        .buttonStyle(.plain).foregroundStyle(rx.tintText)
                } else if p != nil {
                    Button { models.stop(r.id) } label: {
                        RoundedRectangle(cornerRadius: 3).fill(preparing ? rx.label3 : rx.tint).frame(width: 15, height: 15)
                            .frame(width: 29, height: 29).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(preparing)
                } else {
                    Button { models.download(r.id) } label: {
                        Image(systemName: "arrow.down.circle").font(.title3)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(failure != nil ? .red : (fit == .no || short > 0 || busy) ? rx.label3 : rx.tint)
                    .disabled(short > 0 || busy)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(short > 0)
        .opacity(short > 0 || (tooBig && p == nil) ? 0.55 : 1)
        .swipeActions { if r.custom && p == nil && !r.downloaded { Button("Remove", role: .destructive) { models.remove(r) } } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
        .accessibilityAddTraits(.isButton)
        .accessibilityActions {
            if let accessory { Button(accessory.name, action: accessory.run) }
            if r.custom && p == nil && !r.downloaded { Button("Remove \(r.name)") { models.remove(r) } }
        }
        .listRowBackground(rx.cell)
    }

    // MARK: device and storage

    /// What this device is, so the verdicts below make sense (DeviceSpecs.jsx).
    private var specs: some View {
        let s = models.spec
        let gb = { (n: Double) in String(format: n < 10e9 ? "%.1f GB" : "%.0f GB", n / 1e9) }
        let comfortable = s.ramAvailable > 0 ? (s.ramAvailable * 0.75 / 1e9 - 0.45) / 1.15 : 0
        let line = "\(gb(s.ramTotal)) memory · \(s.cores) cores · iOS \(s.os)" + (models.disk.total > 0 ? " · \(gb(Double(models.disk.free))) free" : "")
        return VStack(alignment: .leading, spacing: 4) {
            Text(s.name).font(.headline).foregroundStyle(rx.label)
            Text(line).font(.footnote).monospacedDigit().foregroundStyle(rx.label2)
            // only when credible: never promise models "up to roughly -0.4 GB"
            if s.ramAvailable > 0.5e9 && comfortable > 0.1 {
                Text("iOS gives one app about \(Text(gb(s.ramAvailable)).bold()) of that. Models up to roughly \(Text(String(format: "%.1f GB", comfortable)).bold()) \(Text("run well").foregroundStyle(Fit.well.color)) here; bigger ones \(Text("run tight").foregroundStyle(Fit.tight.color)), then \(Text("won't run").foregroundStyle(Fit.no.color)).")
                    .font(.footnote).foregroundStyle(rx.label2).padding(.top, 2)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    /// One segment per stored model against the whole disk; no rail when nothing is stored (StorageLine.jsx).
    private var storage: some View {
        let total = Double(models.disk.total)
        let stored = models.rows.filter(\.downloaded)
        let fmt = { (b: Double) -> String in b <= 0 ? "0 GB" : b >= 10e9 ? "\(Int((b / 1e9).rounded())) GB" : String(format: "%.1f GB", b / 1e9) }
        return VStack(alignment: .leading, spacing: 6) {
            if !stored.isEmpty {
                GeometryReader { g in
                    HStack(spacing: 1) {
                        ForEach(stored) { r in
                            Rectangle().fill(rx.tint).frame(width: g.size.width * max(0.006, min(1, Double(models.sizes[r.id] ?? 0) / total)))
                        }
                        Spacer(minLength: 0)
                    }
                    .background(rx.cell2)
                    .clipShape(Capsule())
                }
                .frame(height: 4)
                .accessibilityHidden(true)
            }
            Text(stored.isEmpty ? "No models stored · \(fmt(Double(models.disk.free))) free of \(fmt(total))."
                                : "\(fmt(Double(models.usedBytes))) of \(fmt(total)) used by models.")
                .font(.caption).monospacedDigit().foregroundStyle(rx.label2)
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
    }
}

struct ModelDetail: View {
    @Environment(\.rx) private var rx
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var app: AppModel
    let row: LocalModels.CatalogRow
    @ObservedObject var models: ModelsModel
    let startChat: (String) -> Void
    @State private var confirmRemove = false
    /// The download this sheet started, and whether the person has since left:
    /// only then does a finished download open the chat by itself.
    @State private var pending = false
    @State private var left = false

    var body: some View {
        let r = models.rows.first { $0.id == row.id } ?? row
        Group {
            if r.downloaded { have(r) } else { get(r) }
        }
        .background(rx.bg)
        .confirmationDialog("Remove \(r.name)?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { models.remove(r) }
        } message: { Text(String(format: "Frees %.1f GB. You can download it again later.", r.gb)) }
        .onChange(of: scenePhase) { _, p in if p != .active { left = true } }
        .task(id: models.justDone) {
            guard pending, models.justDone == row.id else { return }
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled, !left, models.justDone == row.id else { return }
            models.justDone = nil
            startChat(row.id)
        }
    }

    private func have(_ r: LocalModels.CatalogRow) -> some View {
        let fit = models.fit(r)
        return VStack(alignment: .leading, spacing: 14) {
            Text(r.name).font(.title2.weight(.bold)).foregroundStyle(rx.label)
            Text(r.maker + " · " + gbText(r.gb) + (r.vision ? " · sees pictures" : "")).font(.subheadline).foregroundStyle(rx.label2)
            Text(Device.text(r.blurb)).foregroundStyle(rx.label)
            if let fit { Label(fit.why(Device.word), systemImage: "memorychip").font(.subheadline).foregroundStyle(fit.color) }
            Spacer()
            Button { app.choose(r.id); startChat(r.id) } label: { Text("Start chatting").frame(maxWidth: .infinity) }
                .buttonStyle(Prominent())
            Button("Remove from this \(Device.word)", role: .destructive) { confirmRemove = true }.frame(maxWidth: .infinity)
        }
        .padding(24)
    }

    /// Getting a model (ModelPicker.jsx Hero): the one it is about, one button, and what is happening.
    private func get(_ r: LocalModels.CatalogRow) -> some View {
        let fit = models.fit(r)
        let p = models.progress[r.id]
        let preparing = models.preparing.contains(r.id)
        let downloading = p != nil && !preparing
        let failure = p == nil ? models.failed[r.id] : nil
        let short = models.shortBy(r)
        let blocked = short > 0 && p == nil
        let busy = p == nil && models.busyElsewhere(r.id)
        let shown = ModelsModel.text(p)
        let label = preparing ? "Preparing the model…"
            : downloading ? (shown.map { "Stop · \($0)" } ?? "Stop")
            : blocked ? "Not enough room"
            : failure != nil ? "Try again"
            : "Download · " + gbText(r.gb)
        let spoken = preparing ? "\(r.name) is preparing"
            : downloading ? "Downloading \(r.name)"
            : blocked ? "\(r.name), not enough room"
            : failure != nil ? "Try downloading \(r.name) again"
            : "Download \(r.name), \(gbText(r.gb))"
        return ScrollView {
            VStack(spacing: 14) {
                Text(r.id == ModelsModel.recommendedId ? "Recommended" : "Selected")
                    .font(.footnote.weight(.semibold)).textCase(.uppercase).foregroundStyle(rx.label2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("It runs on this \(Device.word) — no account, and no network once it’s here.")
                    .font(.subheadline).foregroundStyle(rx.label2).frame(maxWidth: .infinity, alignment: .leading)
                // a status object, not a logo: shown only while something is happening
                if p != nil {
                    ZStack {
                        if let pct = p?.pct {
                            Circle().stroke(rx.cell2, lineWidth: 4)
                            Circle().trim(from: 0, to: min(max(pct, 0), 1)).stroke(rx.tint, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                                .rotationEffect(.degrees(-90))
                        }
                        Swirl(size: 120)
                    }
                    .frame(width: 148, height: 148).padding(.top, 8)
                    .accessibilityHidden(true)
                } else if failure != nil {
                    Image("LogoMark").renderingMode(.template).resizable().scaledToFit()
                        .frame(width: 120, height: 120).foregroundStyle(rx.label3).padding(.top, 8).accessibilityHidden(true)
                }
                Text(r.name).font(.title2.weight(.bold)).foregroundStyle(rx.label).multilineTextAlignment(.center)
                Text(Device.text(r.blurb)).foregroundStyle(rx.label2).multilineTextAlignment(.center)
                if let no = models.refused[r.id] { Label(no.why, systemImage: "memorychip").font(.subheadline).foregroundStyle(.red) }
                else if let fit { Label(fit.why(Device.word), systemImage: "memorychip").font(.subheadline).foregroundStyle(fit.color) }

                Button {
                    if downloading { models.stop(r.id); pending = false }
                    else { pending = true; left = false; models.download(r.id) }
                } label: { Text(label).monospacedDigit().frame(maxWidth: .infinity) }
                .buttonStyle(Prominent())
                .tint(downloading ? .red : rx.tint)
                .disabled(preparing || blocked || busy)
                .accessibilityLabel(spoken)
                .padding(.top, 8)

                if downloading {
                    Text("Keep Radiant open while this downloads.").font(.footnote).foregroundStyle(.orange)
                } else if let failure {
                    Text(failure).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
                } else if blocked {
                    Text("Needs \(gbText(short / 1e9)) more room on this \(Device.word).").font(.footnote).foregroundStyle(.orange)
                } else if busy, let other = models.progress.keys.first(where: { $0 != r.id }) {
                    Text("\(models.name(other)) is downloading. Wait for it to finish, or stop it first.")
                        .font(.footnote).foregroundStyle(rx.label2).multilineTextAlignment(.center)
                }
                if r.custom && p == nil {
                    Button("Remove from the list", role: .destructive) { models.remove(r); dismiss() }.padding(.top, 4)
                }
            }
            .padding(24)
        }
    }
}

// MARK: - Hugging Face search (hf.js)

struct HFResult: Identifiable {
    let repo: String
    var id: String { repo }
    let downloads: Int
    var info: HFInfo?
    /// The check itself failed — said instead of an endless "Checking…".
    var error: String?
}

struct HFInfo {
    let gb: Double, modelType: String?, quantized: Bool, bits: Int?, bytesPerParam: Double?, vision: Bool, hasWeights: Bool
    var draft = false
}

enum HF {
    // The model types the engine can load, as hf.js lists them.
    static let supported: Set<String> = ["acereason", "afmoe", "apertus", "baichuan_m1", "bailing_moe", "bitnet", "cohere", "deepseek_v2", "deepseek_v3", "ernie4_5",
        "exaone4", "falcon_h1", "gemma", "gemma2", "gemma3", "gemma3_text", "gemma3n", "gemma4", "gemma4_text", "gemma4_unified",
        "glm4", "glm4_moe", "glm4_moe_lite", "gpt_oss", "granite", "granitemoehybrid", "helium", "hunyuan_v1_dense", "internlm2",
        "jamba", "lfm2", "lfm2_moe", "lille-130m", "llama", "mamba2", "mimo", "mimo_v2_flash", "minicpm", "minimax", "mistral",
        "mistral3", "mixtral", "nanbeige", "nanochat", "nemotron_h", "nemotron_labs_diffusion", "olmo2", "olmo3", "olmoe", "openelm",
        "phi", "phi3", "phimoe", "qwen2", "qwen3", "qwen3_5", "qwen3_5_moe", "qwen3_5_text", "qwen3_moe", "qwen3_next", "smollm3",
        "starcoder2", "fastvlm", "glm_ocr", "idefics3", "lfm2-vl", "lfm2_vl", "llava_qwen2", "muse_glimmer", "paligemma", "pixtral",
        "qwen2_5_vl", "qwen2_vl", "qwen3_vl", "qwen3_vl_moe", "smolvlm"]
    static let vision: Set<String> = ["fastvlm", "glm_ocr", "idefics3", "lfm2-vl", "lfm2_vl", "llava_qwen2", "muse_glimmer", "paligemma",
        "pixtral", "qwen2_5_vl", "qwen2_vl", "qwen3_vl", "qwen3_vl_moe", "smolvlm", "gemma3", "gemma4", "gemma4_unified"]

    /// Search MLX repos. No word filter — uncensored models must be findable (TG-454).
    static func search(_ q: String) async throws -> [HFResult] {
        var c = URLComponents(string: "https://huggingface.co/api/models")!
        c.queryItems = [.init(name: "search", value: q), .init(name: "filter", value: "mlx"), .init(name: "sort", value: "downloads"),
                        .init(name: "direction", value: "-1"), .init(name: "limit", value: "50")]
        let (data, resp) = try await URLSession.shared.data(from: c.url!)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw CloudStream.err("Hugging Face answered \((resp as? HTTPURLResponse)?.statusCode ?? 0).") }
        let rows = (try JSONSerialization.jsonObject(with: data) as? [[String: Any]]) ?? []
        return rows.compactMap { r -> HFResult? in
            guard let id = r["id"] as? String, id.range(of: "embed|rerank|lora|adapter", options: [.regularExpression, .caseInsensitive]) == nil else { return nil }
            return HFResult(repo: id, downloads: r["downloads"] as? Int ?? 0)
        }.prefix(25).map { $0 }
    }

    static func inspect(_ repo: String) async throws -> HFInfo {
        async let metaReq = URLSession.shared.data(from: URL(string: "https://huggingface.co/api/models/\(repo)?blobs=true")!)
        async let cfgReq = URLSession.shared.data(from: URL(string: "https://huggingface.co/\(repo)/raw/main/config.json")!)
        let meta = (try JSONSerialization.jsonObject(with: try await metaReq.0) as? [String: Any]) ?? [:]
        let cfg = (try? JSONSerialization.jsonObject(with: try await cfgReq.0)) as? [String: Any]
        let weights = (meta["siblings"] as? [[String: Any]] ?? []).filter { ($0["rfilename"] as? String)?.hasSuffix(".safetensors") == true }
        let bytes = weights.reduce(0.0) { $0 + (($1["size"] as? Double) ?? Double($1["size"] as? Int ?? 0)) }
        let type = (cfg?["model_type"] as? String) ?? ((cfg?["text_config"] as? [String: Any])?["model_type"] as? String)
        let quant = (cfg?["quantization"] as? [String: Any]) ?? (cfg?["quantization_config"] as? [String: Any])
        let params = ((meta["safetensors"] as? [String: Any])?["total"] as? Double) ?? Double((meta["safetensors"] as? [String: Any])?["total"] as? Int ?? 0)
        return HFInfo(gb: bytes / 1e9, modelType: type, quantized: quant != nil, bits: quant?["bits"] as? Int,
                      bytesPerParam: params > 0 ? bytes / params : nil, vision: type.map { vision.contains($0) } ?? false, hasWeights: !weights.isEmpty,
                      draft: (cfg?["architectures"] as? [String] ?? []).contains { $0.localizedCaseInsensitiveContains("draft") })
    }

    /// Will it run? The same checks, in the same order, as qualify() in hf.js.
    static func qualify(_ i: HFInfo, fit: Fit?) -> (ok: Bool, label: String, why: String, color: Color) {
        if !i.hasWeights { return (false, "No weights", "This repo has no safetensors files — it is not a model Radiant can download.", .red) }
        guard let t = i.modelType else { return (false, "Unknown type", "No config.json with a model type — Radiant cannot tell what this is.", .red) }
        if i.draft { return (false, "Won't run", "This is a draft model — a helper that speeds up a bigger model. It cannot hold a conversation on its own.", .red) }
        if !supported.contains(t) { return (false, "Won't run", "Radiant's engine has no loader for “\(t)” models yet.", .red) }
        if !i.quantized, let b = i.bytesPerParam, b < 1.2 { return (false, "Won't load", "The weights look quantized but config.json does not say so; the download would fail to load. Pick a repo from mlx-community with the same model instead.", .red) }
        if !i.quantized, i.gb > 8 { return (false, "Too big", String(format: "%.1f GB of unquantized weights — look for a 4-bit version.", i.gb), .red) }
        if fit == .no { return (false, "Won't fit", String(format: "%.1f GB needs more memory than this device can give one app.", i.gb), .red) }
        if fit == .tight { return (true, "Runs tight", String(format: "%.1f GB fits, but close to the limit — expect it to be slow.", i.gb), .orange) }
        return (true, "Runs well", String(format: "%.1f GB, ", i.gb) + (i.bits.map { "\($0)-bit" } ?? "quantized") + ", \(t).", .green)
    }

    /// A catalogue row for a find (customRow in hf.js).
    static func row(_ repo: String, _ i: HFInfo) -> RemoteCatalog.Row {
        let name = repo.components(separatedBy: "/").last!.replacingOccurrences(of: "[-_]", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\b(mlx|4bit|8bit|bf16)\\b", with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        let id = "hf-" + repo.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
        let t = i.modelType ?? ""
        let stop: String? = t.localizedCaseInsensitiveContains("gemma") ? "<end_of_turn>" : (t.localizedCaseInsensitiveContains("phi") ? "<|end|>" : nil)
        return RemoteCatalog.Row(id: id, name: name, maker: repo.components(separatedBy: "/")[0], blurb: "From Hugging Face — \(repo).",
                                 gb: (i.gb * 100).rounded() / 100, repo: repo, stop: stop, vision: i.vision, video: false)
    }
}

struct HFSearchView: View {
    @Environment(\.rx) private var rx
    @ObservedObject var models: ModelsModel
    let startChat: (String) -> Void
    @State private var query = ""
    @State private var results: [HFResult] = []
    @State private var busy = false
    @State private var error: String?
    @State private var searched = ""   // the query the results belong to

    var body: some View {
        List {
            Section {
                Text("Anything in MLX format that Radiant can load. Each result is checked before you download it: whether the engine has a loader for it, whether its weights are what its config says, and whether it fits this \(Device.word).")
                    .font(.footnote).foregroundStyle(rx.label2)
                    .listRowBackground(rx.grouped)
            }
            if let error { Text(error).foregroundStyle(.red).listRowBackground(rx.cell) }
            ForEach(results) { r in resultRow(r) }
            if !busy && results.isEmpty && !searched.isEmpty && error == nil {
                Text("Nothing found — try another word, or the model’s family name.").font(.subheadline).foregroundStyle(rx.label2)
                    .listRowBackground(rx.cell)
            }
        }
        .scrollContentBackground(.hidden)
        .readingWidth()
        .background(rx.grouped)
        .overlay { if busy { ProgressView() } }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search Hugging Face")
        .onSubmit(of: .search) { Task { await run() } }
        .navigationTitle("Hugging Face")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func run() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        busy = true; error = nil; results = []; searched = q
        defer { busy = false }
        do {
            results = try await HF.search(q)
            // inspect each in parallel, so verdicts fill in as they arrive
            await withTaskGroup(of: (String, Result<HFInfo, Error>).self) { g in
                for r in results { g.addTask { do { return (r.repo, .success(try await HF.inspect(r.repo))) } catch { return (r.repo, .failure(error)) } } }
                for await (repo, res) in g {
                    guard let i = results.firstIndex(where: { $0.repo == repo }) else { continue }
                    switch res {
                    case .success(let info): results[i].info = info
                    case .failure(let e): results[i].error = e.localizedDescription
                    }
                }
            }
        } catch { self.error = error.localizedDescription }
    }

    private func resultRow(_ r: HFResult) -> some View {
        let name = r.repo.components(separatedBy: "/").last ?? r.repo
        let row = r.info.map { HF.row(r.repo, $0) }
        let existing = models.rows.first { $0.repo == r.repo } ?? row.flatMap { rr in models.rows.first { $0.id == rr.id } }
        let q = r.info.map { HF.qualify($0, fit: Fit.of($0.gb, budgetBytes: models.budget)) }
        let p = existing.flatMap { models.progress[$0.id] }
        let preparing = existing.map { models.preparing.contains($0.id) } ?? false
        let downloading = p != nil && !preparing
        let failure = existing.flatMap { p == nil ? models.failed[$0.id] : nil }
        return HStack(alignment: .top) {
            if p != nil { Swirl().padding(.top, 1) }
            VStack(alignment: .leading, spacing: 3) {
                Text(name).foregroundStyle(rx.label)
                Text("\(r.repo.components(separatedBy: "/")[0]) · \(r.downloads.formatted()) downloads" + (r.info.map { String(format: " · %.1f GB", $0.gb) } ?? ""))
                    .font(.caption).foregroundStyle(rx.label2)
                if let q { Text("\(Text(q.label).font(.caption.weight(.semibold)).foregroundStyle(q.color))  \(q.why)").font(.caption).foregroundStyle(rx.label2) }
                else if let e = r.error { Text(e).font(.caption).foregroundStyle(.red) }
                else { Text("Checking…").font(.caption).foregroundStyle(rx.label3) }
                if downloading { Text("Downloading…" + (ModelsModel.text(p).map { " " + $0 } ?? "")).font(.caption).monospacedDigit().foregroundStyle(rx.label2) }
                if preparing { Text("Preparing…").font(.caption).foregroundStyle(rx.label2) }
                if let failure { Text(failure).font(.caption).foregroundStyle(.red) }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 6) {
                if let existing, existing.downloaded {
                    Button("Chat") { startChat(existing.id) }.buttonStyle(.bordered)
                        .accessibilityLabel("Chat with \(name)")
                } else if let existing, downloading {
                    Button("Stop") { models.stop(existing.id) }.buttonStyle(.bordered)
                        .accessibilityLabel("Stop downloading \(name)")
                } else if preparing {
                    Button("…") {}.buttonStyle(.bordered).disabled(true)
                        .accessibilityLabel("\(name) is preparing")
                } else if existing != nil || q?.ok == true {
                    Button("Download") {
                        if let existing { models.download(existing.id) }
                        else if let row {
                            if let id = models.engine.addCustomModel(row) { models.refresh(); models.download(id) }
                            else { error = "This build cannot add models from Hugging Face." }
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(models.busyElsewhere(existing?.id ?? ""))
                    .accessibilityLabel("Download \(name)")
                }
                // Only a row a search added can be removed here; catalogue models live on their shelf.
                if let existing, existing.custom, p == nil {
                    Button("Remove", role: .destructive) { models.remove(existing) }.buttonStyle(.borderless).font(.caption)
                        .accessibilityLabel("Remove \(name)")
                }
            }
        }
        .listRowBackground(rx.cell)
    }
}
