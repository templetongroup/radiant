import SwiftUI
import UIKit

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

@MainActor
final class ModelsModel: ObservableObject {
    let engine: LocalModels
    @Published var rows: [LocalModels.CatalogRow] = []
    @Published var progress: [String: Progress] = [:]
    @Published var preparing: Set<String> = []
    @Published var failed: [String: String] = [:]
    @Published var disk: (free: Int64, total: Int64) = (0, 0)
    let budget: Double
    let device = UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
    private var token: UUID?
    var onChange: () -> Void = {}

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
        // a download that started before this screen opened is still running
        for r in rows where engine.isDownloading(r.id) && progress[r.id] == nil { progress[r.id] = Progress(pct: nil, done: 0) }
    }

    private func handle(_ event: String, _ d: [String: Any]) {
        guard let id = d["id"] as? String else { return }
        switch event {
        case "downloadStarted": progress[id] = Progress(pct: nil, done: 0); failed[id] = nil
        case "downloadProgress":
            let p = d["progress"] as? Double ?? -1
            progress[id] = Progress(pct: p >= 0 ? p : nil, done: (d["completedBytes"] as? Double) ?? Double(d["completedBytes"] as? Int64 ?? 0))
        case "downloadPreparing": preparing.insert(id)
        case "downloadDone": progress[id] = nil; preparing.remove(id); refresh(); onChange()
        case "downloadCancelled": progress[id] = nil; preparing.remove(id)
        case "downloadFailed": progress[id] = nil; preparing.remove(id); failed[id] = d["message"] as? String ?? "Download failed."
        default: break
        }
    }

    func fit(_ r: LocalModels.CatalogRow) -> Fit? { Fit.of(r.gb, budgetBytes: budget) }

    /// "42%", or the megabytes when the total is not known; nil = say Downloading…
    static func text(_ p: Progress?) -> String? {
        guard let p else { return nil }
        if let pct = p.pct { return "\(Int((pct * 100).rounded()))%" }
        if p.done > 0 { return p.done >= 1e9 ? String(format: "%.1f GB", p.done / 1e9) : "\(Int(p.done / 1e6)) MB" }
        return nil
    }

    func download(_ id: String) { failed[id] = nil; progress[id] = Progress(pct: nil, done: 0); engine.startDownload(id) }
    func stop(_ id: String) { engine.stopDownload(id) }
    func remove(_ r: LocalModels.CatalogRow) {
        if r.custom { engine.removeCustomModel(r.id) } else { engine.removeModel(r.id) }
        refresh(); onChange()
    }

    var usedBytes: Int64 { rows.filter(\.downloaded).reduce(0) { $0 + engine.bytesOnDisk($1.id) } }

    /// Makers A to Z, models A to Z inside each, numbers as numbers (makers.js).
    var shelves: [(maker: String, models: [LocalModels.CatalogRow])] {
        let groups = Dictionary(grouping: rows.filter { !$0.downloaded }, by: \.maker)
        return groups.keys.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
            .map { ($0, groups[$0]!.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }) }
    }
}

struct ModelsView: View {
    @EnvironmentObject var app: AppModel
    @StateObject private var models: ModelsModel
    @Environment(\.rx) private var rx
    @State private var open: Set<String> = []
    @State private var detail: LocalModels.CatalogRow?
    let startChat: (String) -> Void

    init(engine: LocalModels, startChat: @escaping (String) -> Void) {
        _models = StateObject(wrappedValue: ModelsModel(engine: engine))
        self.startChat = startChat
    }

    var body: some View {
        List {
            Section { storage }.listRowBackground(rx.cell)
            let installed = models.rows.filter(\.downloaded)
            Section {
                if AppleLM.available {
                    Button { app.choose(AppleLM.id); startChat(AppleLM.id) } label: {
                        rowLabel(title: "Apple Intelligence", subtitle: "Built into iOS · nothing to download", current: app.currentModelId == AppleLM.id)
                    }.buttonStyle(.plain)
                }
                if let c = Providers.chosen(app.kv) {
                    let id = "cloud:\(c.providerId):\(c.model)"
                    Button { startChat(id) } label: {
                        rowLabel(title: Providers.shortName(c.model), subtitle: "Cloud · \(Providers.byId(c.providerId)?.name ?? c.providerId)", current: app.currentModelId == id)
                    }.buttonStyle(.plain)
                }
                ForEach(installed) { r in
                    Button { app.choose(r.id); startChat(r.id) } label: {
                        rowLabel(title: r.name, subtitle: String(format: "%.1f GB", r.gb) + " · " + r.maker, current: app.currentModelId == r.id)
                    }
                    .buttonStyle(.plain)
                    .swipeActions { Button("Remove", role: .destructive) { models.remove(r) } }
                    .contextMenu { Button("Details", systemImage: "info.circle") { detail = r } }
                }
            } header: { Text("On this \(models.device)").foregroundStyle(rx.label2) }
            .listRowBackground(rx.cell)

            Section {
                NavigationLink { HFSearchView(models: models) } label: {
                    Label("Search Hugging Face", systemImage: "magnifyingglass").foregroundStyle(rx.label)
                }
            }
            .listRowBackground(rx.cell)

            ForEach(models.shelves, id: \.maker) { shelf in
                Section {
                    DisclosureGroup(isExpanded: Binding(get: { open.contains(shelf.maker) }, set: { if $0 { open.insert(shelf.maker) } else { open.remove(shelf.maker) } })) {
                        ForEach(shelf.models) { r in catalogRow(r) }
                    } label: {
                        HStack {
                            Text(shelf.maker).font(.headline).foregroundStyle(rx.label)
                            Spacer()
                            let runs = shelf.models.filter { models.fit($0) != .no }.count
                            Text("\(shelf.models.count) model\(shelf.models.count == 1 ? "" : "s") · \(runs) run here")
                                .font(.caption).foregroundStyle(rx.label2)
                        }
                    }
                }
                .listRowBackground(rx.cell)
            }
        }
        .scrollContentBackground(.hidden)
        .background(rx.grouped)
        .navigationTitle("Models")
        .sheet(item: $detail) { r in ModelDetail(row: r, models: models, startChat: { detail = nil; startChat($0) }).presentationDetents([.medium]) }
        .onAppear { models.onChange = { app.reload() }; models.refresh() }
        .refreshable { models.refresh() }
    }

    private func rowLabel(title: String, subtitle: String, current: Bool) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(rx.label)
                Text(subtitle).font(.caption).foregroundStyle(rx.label2)
            }
            Spacer()
            if current { Text("Current").font(.caption.weight(.semibold)).foregroundStyle(rx.tintText) }
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(rx.label3)
        }
        .contentShape(Rectangle())
        .listRowBackground(rx.cell)
    }

    private func catalogRow(_ r: LocalModels.CatalogRow) -> some View {
        let fit = models.fit(r)
        let p = models.progress[r.id]
        return Button { detail = r } label: {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(r.name).foregroundStyle(rx.label)
                        if let fit { Text(fit.label).font(.caption.weight(.semibold)).foregroundStyle(fit.color) }
                    }
                    Text(String(format: "%.1f GB", r.gb) + " · " + r.blurb).font(.caption).foregroundStyle(rx.label2).lineLimit(2)
                    if let why = models.failed[r.id] { Text(why).font(.caption).foregroundStyle(.red).lineLimit(2) }
                }
                Spacer()
                if p != nil {
                    VStack(spacing: 2) {
                        Button { models.stop(r.id) } label: {
                            ZStack {
                                if let pct = p?.pct { ProgressView(value: pct).progressViewStyle(.circular) } else { ProgressView() }
                                Image(systemName: "stop.fill").font(.system(size: 8))
                            }
                        }
                        .buttonStyle(.plain).foregroundStyle(rx.tint)
                        .accessibilityLabel("Stop downloading \(r.name)")
                        Text(models.preparing.contains(r.id) ? "Preparing" : (ModelsModel.text(p) ?? "…"))
                            .font(.caption2).monospacedDigit().foregroundStyle(rx.label2)
                    }
                } else {
                    Button { models.download(r.id) } label: {
                        Image(systemName: "arrow.down.circle").font(.title3)
                    }
                    .buttonStyle(.plain).foregroundStyle(fit == .no ? rx.label3 : rx.tint)
                    .accessibilityLabel("Download \(r.name), \(String(format: "%.1f", r.gb)) gigabytes")
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(rx.cell)
    }

    private var storage: some View {
        let used = Double(models.usedBytes), free = Double(models.disk.free), total = Double(max(models.disk.total, 1))
        return VStack(alignment: .leading, spacing: 8) {
            GeometryReader { g in
                HStack(spacing: 0) {
                    Rectangle().fill(rx.tint).frame(width: g.size.width * min(used / total, 1))
                    Rectangle().fill(rx.label3.opacity(0.5)).frame(width: g.size.width * max(0, min((total - free - used) / total, 1)))
                    Rectangle().fill(rx.cell2)
                }
                .clipShape(Capsule())
            }
            .frame(height: 8)
            Text(String(format: "%.1f GB used by models · %.0f GB free", used / 1e9, free / 1e9))
                .font(.caption).foregroundStyle(rx.label2).monospacedDigit()
        }
        .padding(.vertical, 4)
        .listRowBackground(rx.cell)
        .accessibilityElement(children: .combine)
    }
}

struct ModelDetail: View {
    @Environment(\.rx) private var rx
    @EnvironmentObject var app: AppModel
    let row: LocalModels.CatalogRow
    @ObservedObject var models: ModelsModel
    let startChat: (String) -> Void
    @State private var confirmRemove = false

    var body: some View {
        let r = models.rows.first { $0.id == row.id } ?? row
        let fit = models.fit(r)
        VStack(alignment: .leading, spacing: 14) {
            Text(r.name).font(.title2.weight(.bold)).foregroundStyle(rx.label)
            Text(r.maker + " · " + String(format: "%.1f GB", r.gb) + (r.vision ? " · sees pictures" : "")).font(.subheadline).foregroundStyle(rx.label2)
            Text(r.blurb).foregroundStyle(rx.label)
            if let fit { Label(fit.why(models.device), systemImage: "memorychip").font(.subheadline).foregroundStyle(fit.color) }
            Spacer()
            if r.downloaded {
                Button { app.choose(r.id); startChat(r.id) } label: { Text("Start chatting").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                Button("Remove from this \(models.device)", role: .destructive) { confirmRemove = true }.frame(maxWidth: .infinity)
            } else if models.progress[r.id] != nil {
                Button("Stop downloading", role: .destructive) { models.stop(r.id) }.frame(maxWidth: .infinity)
            } else {
                Button { models.download(r.id) } label: { Text("Download · " + String(format: "%.1f GB", r.gb)).frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).controlSize(.large)
            }
        }
        .padding(24)
        .background(rx.bg)
        .confirmationDialog("Remove \(r.name)?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { models.remove(r) }
        } message: { Text(String(format: "Frees %.1f GB. You can download it again later.", r.gb)) }
    }
}

// MARK: - Hugging Face search (hf.js)

struct HFResult: Identifiable {
    let repo: String
    var id: String { repo }
    let downloads: Int
    var info: HFInfo?
}

struct HFInfo {
    let gb: Double, modelType: String?, quantized: Bool, bits: Int?, bytesPerParam: Double?, vision: Bool, hasWeights: Bool
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
                      bytesPerParam: params > 0 ? bytes / params : nil, vision: type.map { vision.contains($0) } ?? false, hasWeights: !weights.isEmpty)
    }

    /// Will it run? The same checks, in the same order, as qualify() in hf.js.
    static func qualify(_ i: HFInfo, fit: Fit?) -> (ok: Bool, label: String, why: String, color: Color) {
        if !i.hasWeights { return (false, "No weights", "This repo has no safetensors files — it is not a model Radiant can download.", .red) }
        guard let t = i.modelType else { return (false, "Unknown type", "No config.json with a model type — Radiant cannot tell what this is.", .red) }
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
    @State private var query = ""
    @State private var results: [HFResult] = []
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        List {
            Section {
                Text("Anything in MLX format that Radiant can load. Each result is checked before you download it: whether the engine has a loader for it, whether its weights are what its config says, and whether it fits this \(models.device).")
                    .font(.footnote).foregroundStyle(rx.label2)
                    .listRowBackground(rx.grouped)
            }
            if let error { Text(error).foregroundStyle(.red).listRowBackground(rx.cell) }
            ForEach(results) { r in resultRow(r) }
        }
        .scrollContentBackground(.hidden)
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
        busy = true; error = nil
        defer { busy = false }
        do {
            results = try await HF.search(q)
            // inspect each in parallel, so verdicts fill in as they arrive
            await withTaskGroup(of: (String, HFInfo?).self) { g in
                for r in results { g.addTask { (r.repo, try? await HF.inspect(r.repo)) } }
                for await (repo, info) in g { if let i = results.firstIndex(where: { $0.repo == repo }) { results[i].info = info } }
            }
        } catch { self.error = error.localizedDescription }
    }

    private func resultRow(_ r: HFResult) -> some View {
        let row = r.info.map { HF.row(r.repo, $0) }
        let existing = row.flatMap { rr in models.rows.first { $0.repo == rr.repo || $0.id == rr.id } }
        let q = r.info.map { HF.qualify($0, fit: Fit.of($0.gb, budgetBytes: models.budget)) }
        return HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
                Text(r.repo.components(separatedBy: "/").last ?? r.repo).foregroundStyle(rx.label)
                Text("\(r.repo.components(separatedBy: "/")[0]) · \(r.downloads.formatted()) downloads" + (r.info.map { String(format: " · %.1f GB", $0.gb) } ?? ""))
                    .font(.caption).foregroundStyle(rx.label2)
                if let q { Text(q.label).font(.caption.weight(.semibold)).foregroundStyle(q.color) + Text("  " + q.why).font(.caption).foregroundStyle(rx.label2) }
                else { Text("Checking…").font(.caption).foregroundStyle(rx.label3) }
            }
            Spacer()
            if let existing {
                if existing.downloaded { Image(systemName: "checkmark").foregroundStyle(rx.tint) }
                else if models.progress[existing.id] != nil { Text(ModelsModel.text(models.progress[existing.id]) ?? "…").font(.caption).monospacedDigit() }
                else { Button("Download") { models.download(existing.id) }.buttonStyle(.bordered) }
            } else if let row, q?.ok == true {
                Button("Download") {
                    if let id = models.engine.addCustomModel(row) { models.refresh(); models.download(id) }
                }
                .buttonStyle(.bordered)
            }
        }
        .listRowBackground(rx.cell)
    }
}
