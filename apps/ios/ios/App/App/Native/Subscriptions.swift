import Foundation
import Network
import AuthenticationServices
import CryptoKit
import UIKit

// Signing in with a subscription (ChatGPT, SuperGrok, Copilot, Qwen, Nous
// Portal) instead of pasting an API key — a port of server/oauth.js, which the
// Mac app has used all along.
//
// ⚠️ UNOFFICIAL. These are the public sign-in clients the vendors' own
// command-line tools use (Codex, the grok CLI, VS Code Copilot, qwen-code,
// hermes-cli), and requests are presented the way those tools present them. A
// vendor can change or close any of this without notice. Claude is left out on
// purpose: Anthropic's terms keep a Claude subscription to its own apps, and it
// actively blocks others — Tony chose not to add it (2026-09-25).

/// A signed-in subscription, kept in the Keychain as JSON under "sub:<provider>".
struct SubToken: Codable {
    var access: String
    var refresh: String?
    var expires: Double          // seconds since 1970
    var accountId: String?       // ChatGPT: which account the Codex backend bills
    var github: String?          // Copilot: the GitHub token the short-lived one is minted from
    var apiBase: String?         // Qwen: the host its token is good for
}

struct SubSpec {
    enum Mode { case browser, device }
    let id: String, label: String, mode: Mode
    let clientId: String, scope: String, tokenUrl: String
    var authorizeUrl = "", port: UInt16 = 0, path = ""     // browser
    var deviceCodeUrl = "", pkce = false                    // device
    var skew: Double = 60                                    // refresh this long before expiry
}

struct DeviceStart { let user: String, url: URL, device: String, verifier: String?, interval: Double }

enum Subscriptions {
    static let specs: [SubSpec] = [
        SubSpec(id: "openai", label: "ChatGPT (Plus / Pro)", mode: .browser,
                clientId: "app_EMoamEEZ73f0CkXaXp7hrann", scope: "openid profile email offline_access",
                tokenUrl: "https://auth.openai.com/oauth/token",
                authorizeUrl: "https://auth.openai.com/oauth/authorize", port: 1455, path: "/auth/callback"),
        SubSpec(id: "xai", label: "Grok (SuperGrok / Premium+)", mode: .device,
                clientId: "b1a00492-073a-47ea-816f-4c329264a828", scope: "openid profile email offline_access grok-cli:access api:access",
                tokenUrl: "https://auth.x.ai/oauth2/token", deviceCodeUrl: "https://auth.x.ai/oauth2/device/code"),
        SubSpec(id: "copilot", label: "GitHub Copilot", mode: .device,
                clientId: "Iv1.b507a08c87ecfe98", scope: "read:user",
                tokenUrl: "https://github.com/login/oauth/access_token", deviceCodeUrl: "https://github.com/login/device/code", skew: 120),
        SubSpec(id: "qwen", label: "Qwen", mode: .device,
                clientId: "f0304373b74a44d2b584a3fb70ca9e56", scope: "openid profile email model.completion",
                tokenUrl: "https://chat.qwen.ai/api/v1/oauth2/token", deviceCodeUrl: "https://chat.qwen.ai/api/v1/oauth2/device/code", pkce: true),
        SubSpec(id: "nousresearch", label: "Nous Portal", mode: .device,
                clientId: "hermes-cli", scope: "inference:invoke",
                tokenUrl: "https://portal.nousresearch.com/api/oauth/token", deviceCodeUrl: "https://portal.nousresearch.com/api/oauth/device/code", skew: 130)
    ]
    static func spec(_ id: String) -> SubSpec? { specs.first { $0.id == id } }

    /// Copilot's editor identification, required on every api.githubcopilot.com call.
    static let copilotHeaders = [
        "Copilot-Integration-Id": "vscode-chat", "Editor-Version": "vscode/1.95.0",
        "Editor-Plugin-Version": "copilot-chat/0.22.0", "Openai-Intent": "conversation-panel"
    ]

    // MARK: stored token

    static func account(_ id: String) -> String { "sub:" + id }
    static func stored(_ id: String) -> SubToken? {
        Keychain.get(account(id)).flatMap { try? JSONDecoder().decode(SubToken.self, from: Data($0.utf8)) }
    }
    static func save(_ id: String, _ t: SubToken) {
        if let d = try? JSONEncoder().encode(t) { Keychain.set(account(id), String(decoding: d, as: UTF8.self)) }
    }
    static func signOut(_ id: String) { Keychain.remove(account(id)) }

    /// A token good for at least the spec's skew, refreshed if it is not.
    static func valid(_ id: String) async throws -> SubToken? {
        guard let t = stored(id), let s = spec(id) else { return nil }
        if t.expires - Date().timeIntervalSince1970 > s.skew { return t }
        return try await Refresher.shared.refresh(id) { try await renew(s, t) }
    }

    /// ⚠️ ONE REFRESH PER PROVIDER AT A TIME. Refresh tokens are single-use;
    /// a chat and its title call refreshing together spend the same one and the
    /// second is refused as "session expired" though nothing had (oauth.js).
    actor Refresher {
        static let shared = Refresher()
        private var jobs: [String: Task<SubToken, Error>] = [:]
        func refresh(_ id: String, _ work: @escaping @Sendable () async throws -> SubToken) async throws -> SubToken {
            if let j = jobs[id] { return try await j.value }
            let j = Task { try await work() }
            jobs[id] = j
            defer { jobs[id] = nil }
            let t = try await j.value
            Subscriptions.save(id, t)
            return t
        }
    }

    private static func renew(_ s: SubSpec, _ t: SubToken) async throws -> SubToken {
        if s.id == "copilot" {
            guard let gh = t.github else { throw CloudStream.err("Copilot sign-in expired — sign in again.") }
            return try await copilotToken(github: gh)
        }
        guard let refresh = t.refresh else { throw CloudStream.err("\(s.label) sign-in expired — sign in again.") }
        var headers: [String: String] = [:]
        var form = ["grant_type": "refresh_token", "client_id": s.clientId]
        if s.id == "nousresearch" { headers["x-nous-refresh-token"] = refresh } else { form["refresh_token"] = refresh }
        // ChatGPT's token endpoint takes JSON (as Codex sends it); the device-code servers take a form.
        let j = s.mode == .browser ? try await postJSON(s.tokenUrl, form) : try await postForm(s.tokenUrl, form, headers: headers)
        guard let access = j["access_token"] as? String else { throw CloudStream.err("\(s.label) sign-in expired — sign in again.") }
        var n = t
        n.access = access
        n.refresh = j["refresh_token"] as? String ?? refresh
        n.expires = Date().timeIntervalSince1970 + ((j["expires_in"] as? Double) ?? 3600)
        if let id = j["id_token"] as? String, let a = accountId(id) { n.accountId = a }
        if let r = j["resource_url"] as? String { n.apiBase = qwenBase(r) }
        return n
    }

    // MARK: browser sign-in (ChatGPT): PKCE, with the vendor redirecting to a
    // port on this phone, where a one-shot listener catches the code.

    @MainActor static func signInBrowser(_ s: SubSpec) async throws {
        let (verifier, challenge) = pkce()
        var c = URLComponents(string: s.authorizeUrl)!
        let redirect = "http://localhost:\(s.port)\(s.path)"
        c.queryItems = [
            .init(name: "response_type", value: "code"), .init(name: "client_id", value: s.clientId),
            .init(name: "redirect_uri", value: redirect), .init(name: "scope", value: s.scope),
            .init(name: "code_challenge", value: challenge), .init(name: "code_challenge_method", value: "S256"),
            .init(name: "state", value: verifier),
            // what Codex adds, so the page offers the subscription sign-in
            .init(name: "id_token_add_organizations", value: "true"), .init(name: "codex_cli_simplified_flow", value: "true")
        ]
        let listener = try Loopback(port: s.port, path: s.path)
        defer { listener.stop() }
        let browser = BrowserSheet()
        browser.open(c.url!) { listener.cancel() }
        defer { browser.close() }
        let code = try await listener.code()
        let j = try await postJSON(s.tokenUrl, [
            "grant_type": "authorization_code", "code": code, "redirect_uri": redirect,
            "client_id": s.clientId, "code_verifier": verifier, "state": verifier
        ])
        guard let access = j["access_token"] as? String else { throw CloudStream.err("\(s.label) did not return a sign-in.") }
        save(s.id, SubToken(access: access, refresh: j["refresh_token"] as? String,
                            expires: Date().timeIntervalSince1970 + ((j["expires_in"] as? Double) ?? 3600),
                            accountId: (j["id_token"] as? String).flatMap(accountId)))
    }

    // MARK: device sign-in: the user opens a page and enters a short code while we poll.

    static func startDevice(_ s: SubSpec) async throws -> DeviceStart {
        var form = ["client_id": s.clientId, "scope": s.scope]
        var verifier: String?
        if s.pkce { let p = pkce(); verifier = p.0; form["code_challenge"] = p.1; form["code_challenge_method"] = "S256" }
        let j = try await postForm(s.deviceCodeUrl, form)
        guard let user = j["user_code"] as? String, let device = j["device_code"] as? String,
              let u = (j["verification_uri_complete"] as? String) ?? (j["verification_uri"] as? String), let url = URL(string: u)
        else { throw CloudStream.err("\(s.label) would not start a sign-in.") }
        return DeviceStart(user: user, url: url, device: device, verifier: verifier, interval: (j["interval"] as? Double) ?? 5)
    }

    /// Polls until the user finishes on the vendor's page, the code expires, or the task is cancelled.
    static func finishDevice(_ s: SubSpec, device: String, verifier: String?, interval: Double) async throws {
        var wait = interval
        let deadline = Date().addingTimeInterval(900)
        while Date() < deadline {
            try await Task.sleep(nanoseconds: UInt64(wait * 1e9))
            var form = ["grant_type": "urn:ietf:params:oauth:grant-type:device_code", "client_id": s.clientId, "device_code": device]
            if let verifier { form["code_verifier"] = verifier }
            // ⚠️ THE USER IS IN SAFARI WHILE THIS RUNS. iOS pauses Radiant, and a
            // check in flight comes back "The network connection was lost" —
            // which ended the sign-in for Grok and Nous on Tony's phone
            // (2026-09-25). A dropped check is not a refusal: keep asking.
            let j: [String: Any]
            do { j = try await postForm(s.tokenUrl, form, allowError: true) }
            catch let e as URLError where CloudStream.transient(e) { continue }
            if let access = j["access_token"] as? String {
                if s.id == "copilot" { save(s.id, try await copilotToken(github: access)); return }
                save(s.id, SubToken(access: access, refresh: j["refresh_token"] as? String,
                                    expires: Date().timeIntervalSince1970 + ((j["expires_in"] as? Double) ?? 300),
                                    apiBase: (j["resource_url"] as? String).map(qwenBase)))
                return
            }
            switch j["error"] as? String {
            case "authorization_pending": continue
            case "slow_down": wait += 5
            default: throw CloudStream.err((j["error_description"] as? String) ?? (j["error"] as? String) ?? "\(s.label) sign-in failed.")
            }
        }
        throw CloudStream.err("The sign-in code expired. Start again.")
    }

    /// A GitHub token is only the first leg: Copilot mints a ~25-minute token from it.
    private static func copilotToken(github: String) async throws -> SubToken {
        var r = URLRequest(url: URL(string: "https://api.github.com/copilot_internal/v2/token")!)
        r.setValue("token \(github)", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        copilotHeaders.forEach { r.setValue($1, forHTTPHeaderField: $0) }
        let (data, resp) = try await CloudStream.data(r)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let tok = j["token"] as? String else {
            throw CloudStream.err(status == 403 ? "This GitHub account has no active Copilot subscription." : "Copilot would not issue a token (\(status)).")
        }
        return SubToken(access: tok, expires: (j["expires_at"] as? Double) ?? Date().timeIntervalSince1970 + 1500, github: github)
    }

    // MARK: helpers

    static func pkce() -> (String, String) {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let verifier = b64url(Data(bytes))
        return (verifier, b64url(Data(SHA256.hash(data: Data(verifier.utf8)))))
    }
    static func b64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    /// The ChatGPT account id inside the id_token (read, not verified — it is our own token).
    static func accountId(_ jwt: String) -> String? {
        let parts = jwt.split(separator: ".")
        guard parts.count > 1 else { return nil }
        var s = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        guard let d = Data(base64Encoded: s), let c = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
        return ((c["https://api.openai.com/auth"] as? [String: Any])?["chatgpt_account_id"] as? String) ?? c["chatgpt_account_id"] as? String
    }
    static func qwenBase(_ r: String) -> String { r.hasPrefix("http") ? r : "https://\(r)/v1" }

    private static func postForm(_ url: String, _ form: [String: String], headers: [String: String] = [:], allowError: Bool = false) async throws -> [String: Any] {
        var r = URLRequest(url: URL(string: url)!)
        r.httpMethod = "POST"
        r.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        headers.forEach { r.setValue($1, forHTTPHeaderField: $0) }
        var c = URLComponents(); c.queryItems = form.map { URLQueryItem(name: $0, value: $1) }
        r.httpBody = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B").data(using: .utf8)
        return try await send(r, allowError: allowError)
    }
    private static func postJSON(_ url: String, _ body: [String: String]) async throws -> [String: Any] {
        var r = URLRequest(url: URL(string: url)!)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(r, allowError: false)
    }
    private static func send(_ r: URLRequest, allowError: Bool) async throws -> [String: Any] {
        let (data, resp) = try await CloudStream.data(r)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let j = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        if !(200..<300).contains(status) && !allowError { throw CloudStream.err(CloudStream.message(from: data, status: status)) }
        return j
    }
}

/// A one-shot HTTP listener on this phone's loopback, for the page the vendor
/// redirects to after sign-in. It answers once, with a "signed in" page.
final class Loopback: @unchecked Sendable {
    private let listener: NWListener
    private let path: String
    private var waiter: CheckedContinuation<String, Error>?
    private var result: Result<String, Error>?
    private let lock = NSLock()

    init(port: UInt16, path: String) throws {
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        params.allowLocalEndpointReuse = true
        listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        self.path = path
        listener.newConnectionHandler = { [weak self] c in self?.serve(c) }
        listener.stateUpdateHandler = { [weak self] s in
            if case .failed(let e) = s { self?.finish(.failure(CloudStream.err("Could not listen for the sign-in: \(e.localizedDescription)"))) }
        }
        listener.start(queue: .global())
    }

    func code() async throws -> String {
        try await withCheckedThrowingContinuation { c in
            lock.lock()
            if let r = result { lock.unlock(); c.resume(with: r) } else { waiter = c; lock.unlock() }
        }
    }
    func cancel() { finish(.failure(CancellationError())) }
    func stop() { listener.cancel() }

    private func finish(_ r: Result<String, Error>) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = r
        let w = waiter; waiter = nil
        lock.unlock()
        w?.resume(with: r)
    }

    private func serve(_ c: NWConnection) {
        c.start(queue: .global())
        c.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] data, _, _, _ in
            guard let self else { return }
            let head = data.flatMap { String(data: $0, encoding: .utf8) }?.components(separatedBy: "\r\n").first ?? ""
            let target = head.split(separator: " ").dropFirst().first.map(String.init) ?? ""
            let comps = URLComponents(string: "http://localhost" + target)
            let ok = comps?.path == self.path
            let code = comps?.queryItems?.first { $0.name == "code" }?.value
            let page = "<html><body style=\"font-family:-apple-system;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0\"><div style=\"text-align:center\"><h2>Radiant is signed in</h2><p>Returning to Radiant…</p></div></body></html>"
            let reply = ok ? "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n\(page)" : "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"
            c.send(content: Data(reply.utf8), completion: .contentProcessed { _ in c.cancel() })
            guard ok else { return }
            let err = comps?.queryItems?.first { $0.name == "error_description" || $0.name == "error" }?.value
            self.finish(code.map { .success($0) } ?? .failure(CloudStream.err(err ?? "The sign-in page returned no code.")))
        }
    }
}

/// The system sign-in browser, which shares Safari's cookies so an existing
/// ChatGPT login carries over. Its own callback never fires — the loopback
/// listener catches the redirect — so it is closed by hand.
@MainActor
final class BrowserSheet: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func open(_ url: URL, onDismiss: @escaping () -> Void) {
        let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "radiant-signin") { _, _ in onDismiss() }
        s.presentationContextProvider = self
        session = s
        s.start()
    }
    func close() { session?.cancel(); session = nil }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { NavTitles.window ?? UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor() }
    }
}
