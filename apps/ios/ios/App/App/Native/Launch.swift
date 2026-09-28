import SwiftUI
import UIKit
import WebKit

// The app's own start: a store on disk, and — once — everything the old web
// design kept in localStorage.
//
// ⚠️ UNTIL BUILD 42 THE NATIVE SCREENS HAD NO STORE OF THEIR OWN. The web app
// booted first, handed them a snapshot of its localStorage, and took every
// write back. With the web design gone, KV is backed by a file here, and the
// first launch of a native-only build copies the old keys across, so chats,
// drafts, skills and settings from any earlier build (App Store 1.1 included)
// are waiting. Keys and JSON shapes are unchanged, so nothing above KV moves.

enum DiskStore {
    static let url: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("radiant-store.json")
    }()
    /// Set once the web store has been copied; until then every launch tries again.
    static let importedKey = "radiant.native.imported"
    /// Only the handover between the two designs used these.
    static let dropped: Set<String> = ["radiant.phone.nativeUI", "rx.nativeRoute"]

    static func load() -> [String: String]? {
        guard let d = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode([String: String].self, from: d)
    }

    private static let queue = DispatchQueue(label: "radiant.store")
    private static var pending: [String: String]?
    /// Coalesced: a burst of writes (a streaming reply, a draft being typed)
    /// becomes one file write a moment later, off the main thread.
    static func save(_ raw: [String: String]) {
        queue.async {
            let first = pending == nil
            pending = raw
            guard first else { return }
            queue.asyncAfter(deadline: .now() + 0.4) { write() }
        }
    }
    /// Write now and wait (going to the background, or right after the import).
    /// Never call it from `queue` itself: sync onto your own queue traps.
    static func flush() { queue.sync { write() } }
    private static func write() {
        guard let raw = pending else { return }
        pending = nil
        if let d = try? JSONEncoder().encode(raw) { try? d.write(to: url, options: .atomic) }
    }
}

/// Reads the old web design's localStorage. Capacitor served that app from
/// radiant://localhost, so a hidden web view on that same origin, in the same
/// default data store, sees the same storage. Nothing is deleted from it.
@MainActor
final class WebStoreImport: NSObject, WKURLSchemeHandler, WKNavigationDelegate {
    private var web: WKWebView?
    private var done: ((String?) -> Void)?

    static func read() async -> [String: String]? {
        let reader = WebStoreImport()
        let json: String? = await withCheckedContinuation { c in reader.start { c.resume(returning: $0) } }
        guard let json, let d = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode([String: String].self, from: d)
    }

    private func start(_ finish: @escaping (String?) -> Void) {
        done = finish
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.setURLSchemeHandler(self, forURLScheme: "radiant")
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        self.web = web
        web.load(URLRequest(url: URL(string: "radiant://localhost/")!))
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in self?.finish(nil) }
    }

    private func finish(_ value: String?) {
        guard let done else { return }
        self.done = nil
        web?.navigationDelegate = nil
        web = nil
        done(value)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let js = "JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('radiant.phone.') || k.startsWith('rx.')).map(k => [k, localStorage.getItem(k)])))"
        webView.evaluateJavaScript(js) { [weak self] result, _ in self?.finish(result as? String) }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(nil) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(nil) }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let body = Data("<!doctype html><title>Radiant</title>".utf8)
        task.didReceive(URLResponse(url: task.request.url!, mimeType: "text/html", expectedContentLength: body.count, textEncodingName: "utf-8"))
        task.didReceive(body)
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

enum Launch {
    /// The store as it should open: the file, plus anything the web store has
    /// that the file lacks, until one import has succeeded.
    static func store() async -> [String: String] {
        var raw = DiskStore.load() ?? [:]
        if raw[DiskStore.importedKey] != "1", let old = await WebStoreImport.read() {
            for (k, v) in old where raw[k] == nil && !DiskStore.dropped.contains(k) { raw[k] = v }
            raw[DiskStore.importedKey] = "1"
            DiskStore.save(raw)
            DiskStore.flush()
        }
        return raw
    }

    @MainActor static func root(window: UIWindow, raw: [String: String]) -> UIViewController {
        let engine = LocalModels()
        engine.load()
        let kv = KV(raw)
        kv.onWrite = { _, _ in DiskStore.save(kv.raw) }
        let app = AppModel(kv: kv, engine: engine)
        let appearance = Appearance(kv.json(Appearance.key))
        NavTitles.window = window
        NavTitles.style(appearance)
        NavTitles.recolor(Themes.palette(appearance, systemDark: window.traitCollection.userInterfaceStyle == .dark).label)
        return UIHostingController(rootView: NativeRoot().environmentObject(app).environmentObject(kv))
    }
}

/// What shows for the moment the first launch spends copying the old store.
struct LaunchCover: View {
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            Image("LogoMark").renderingMode(.template).resizable().scaledToFit().frame(width: 96).foregroundStyle(.white)
        }
    }
}
