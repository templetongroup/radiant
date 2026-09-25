import Foundation
import UIKit
import CoreImage
import MLXLMCommon
#if canImport(FoundationModels)
import FoundationModels
#endif

// Where a reply comes from: a model on the phone (LocalModels), Apple
// Intelligence, or a cloud provider with the user's key. One entry point, so a
// screen asks for a reply without caring which kind of model answers.

/// A model as the pickers and chats refer to it — the same ids the web uses:
/// a catalogue id, "apple-intelligence", or "cloud:<provider>:<model>".
enum ModelRef: Equatable {
    case local(String)
    case apple
    case cloud(provider: String, model: String)

    init(id: String) {
        if id == AppleLM.id { self = .apple; return }
        if id.hasPrefix("cloud:") {
            let parts = id.split(separator: ":", maxSplits: 2).map(String.init)
            if parts.count == 3 { self = .cloud(provider: parts[1], model: parts[2]); return }
        }
        self = .local(id)
    }

    var id: String {
        switch self {
        case .local(let id): return id
        case .apple: return AppleLM.id
        case .cloud(let p, let m): return "cloud:\(p):\(m)"
        }
    }
}

/// One entry in a model picker.
struct ModelOption: Identifiable, Equatable {
    let id: String
    let name: String
    let maker: String
    var thinks = false
    var vision = false
    var cloud: Bool { id.hasPrefix("cloud:") }
}

// MARK: - Apple Intelligence (as AppleModel.swift)

enum AppleLM {
    static let id = "apple-intelligence"   // APPLE_ID in src/mobile/appleModel.js

    static var available: Bool {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *), case .available = SystemLanguageModel.default.availability { return true }
        #endif
        return false
    }

    static var option: ModelOption? { available ? ModelOption(id: id, name: "Apple Intelligence", maker: "Apple") : nil }

    /// Streams snapshots — the whole answer so far each time.
    static func stream(_ prompt: String, instructions: String, onSnapshot: @escaping (String) -> Void) async throws {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            let session = instructions.isEmpty ? LanguageModelSession() : LanguageModelSession(instructions: instructions)
            for try await partial in session.streamResponse(to: prompt) {
                if Task.isCancelled { break }
                onSnapshot(String(describing: partial.content))
            }
            return
        }
        #endif
        throw NSError(domain: "Radiant", code: 2, userInfo: [NSLocalizedDescriptionKey: "Apple Intelligence needs iOS 26 or later."])
    }
}

// MARK: - cloud providers (shared with ProviderChat.swift)

/// Streams a reply from a cloud provider. The key is read from the Keychain
/// here and never leaves native code — the web layer never had it either.
enum CloudStream {
    static let service = "com.templetongroup.radiant.providers"

    static func key(for provider: String) -> String? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func authorize(_ req: inout URLRequest, provider: String, key: String) {
        if provider == "anthropic" {
            req.setValue(key, forHTTPHeaderField: "x-api-key")
            req.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        } else {
            req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }

    /// Pull a human-readable reason out of an error body, whatever shape it is.
    static func message(from data: Data, status: Int) -> String {
        if let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let e = j["error"] as? [String: Any], let m = e["message"] as? String { return m }
            if let m = j["message"] as? String { return m }
        }
        if status == 401 { return "That key was refused. Check it is still valid." }
        if status == 429 { return "Rate limited — too many requests just now." }
        return "The provider returned \(status)."
    }

    /// The provider's own model list, for the picker.
    static func models(provider: String, baseUrl: String) async throws -> [String] {
        guard let apiKey = key(for: provider) else { throw err("No key saved for \(provider)") }
        guard let url = URL(string: baseUrl + (provider == "anthropic" ? "/v1/models" : "/models")) else { throw err("Bad baseUrl") }
        var req = URLRequest(url: url)
        authorize(&req, provider: provider, key: apiKey)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw err("No response") }
        guard (200..<300).contains(http.statusCode) else { throw err(message(from: data, status: http.statusCode)) }
        let rows = ((try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["data"] as? [[String: Any]]) ?? []
        return rows.compactMap { $0["id"] as? String }.sorted()
    }

    /// Stream a reply. `messages` are {role, content}; a "system" one becomes
    /// Anthropic's separate system field. Returns normally when cancelled.
    static func stream(provider: String, baseUrl: String, model: String, messages: [[String: String]],
                       onToken: @escaping (String) -> Void) async throws {
        guard let apiKey = key(for: provider) else { throw err("No key saved for \(provider)") }
        let anthropic = provider == "anthropic"
        guard let url = URL(string: baseUrl + (anthropic ? "/v1/messages" : "/chat/completions")) else { throw err("Bad baseUrl") }
        var body: [String: Any] = ["model": model, "stream": true]
        if anthropic {
            body["max_tokens"] = 4096
            body["messages"] = messages.filter { $0["role"] != "system" }
            if let sys = messages.first(where: { $0["role"] == "system" })?["content"] { body["system"] = sys }
        } else {
            body["messages"] = messages
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        authorize(&req, provider: provider, key: apiKey)
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (bytes, resp) = try await URLSession.shared.bytes(for: req)
            guard let http = resp as? HTTPURLResponse else { throw err("No response") }
            guard (200..<300).contains(http.statusCode) else {
                var raw = Data()
                for try await b in bytes { raw.append(b) }
                throw err(message(from: raw, status: http.statusCode))
            }
            for try await line in bytes.lines {
                if Task.isCancelled { break }
                guard line.hasPrefix("data:") else { continue }
                let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                if payload == "[DONE]" { break }
                guard let d = payload.data(using: .utf8), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
                if let t = chunk(j, anthropic: anthropic), !t.isEmpty { onToken(t) }
            }
        } catch let e as URLError where e.code == .cancelled {
            return   // stopped: what arrived is kept by the caller
        }
    }

    private static func chunk(_ j: [String: Any], anthropic: Bool) -> String? {
        if anthropic { return (j["delta"] as? [String: Any])?["text"] as? String }
        return ((j["choices"] as? [[String: Any]])?.first?["delta"] as? [String: Any])?["content"] as? String
    }

    static func err(_ m: String) -> NSError { NSError(domain: "Radiant", code: 3, userInfo: [NSLocalizedDescriptionKey: m]) }
}

// MARK: - the Keychain (as SecureStore.swift: same service, same accessibility)

enum Keychain {
    static let service = CloudStream.service

    private static func query(_ account: String? = nil) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let account { q[kSecAttrAccount as String] = account }
        return q
    }

    @discardableResult
    static func set(_ account: String, _ value: String) -> Bool {
        SecItemDelete(query(account) as CFDictionary)
        var add = query(account)
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func get(_ account: String) -> String? { CloudStream.key(for: account) }

    static func remove(_ account: String) { SecItemDelete(query(account) as CFDictionary) }

    static func accounts() -> [String] {
        var q = query()
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitAll
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let rows = item as? [[String: Any]] else { return [] }
        return rows.compactMap { $0[kSecAttrAccount as String] as? String }
    }
}
