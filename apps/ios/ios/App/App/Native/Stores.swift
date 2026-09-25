import Foundation

// The phone's data, read and written in exactly the shapes src/mobile writes —
// chats.js, skills.js, drafts.js, providers.js, consent.js — through KV. The
// rules those files enforce (40 kept chats, 200 turns, titles from the first
// question, bundled skills until you make your own) are enforced here too, so
// a chat saved by either design is the same chat.

// MARK: - chats

/// One message. `extra` carries every field the web wrote that this side does
/// not know about, so saving a chat here never strips anything.
struct Msg: Identifiable, Equatable {
    let id: String
    let role: String        // "user" | "assistant"
    var text: String
    var extra: [String: AnyHashable] = [:]

    init(id: String, role: String, text: String) { self.id = id; self.role = role; self.text = text }

    init?(_ d: [String: Any], index: Int) {
        guard let role = d["role"] as? String, let text = d["text"] as? String else { return nil }
        id = (d["id"] as? String) ?? "m\(index)"
        self.role = role == "user" ? "user" : "assistant"
        self.text = text
        for (k, v) in d where !["id", "role", "text"].contains(k) { if let h = v as? AnyHashable { extra[k] = h } }
    }

    var dict: [String: Any] {
        var d: [String: Any] = extra.mapValues { $0 as Any }
        d["id"] = id; d["role"] = role; d["text"] = text
        return d
    }
}

struct Chat: Identifiable, Equatable {
    let id: String
    var title: String
    var modelId: String?
    var modelName: String?
    var skillId: String?
    var archived: Bool
    var updatedAt: Double
    var messages: [Msg]

    /// The last thing said, for the list — what a conversation came to, not how it began.
    var preview: String {
        let last = messages.last(where: { $0.role == "assistant" && !$0.text.isEmpty }) ?? messages.last
        return Fold.visible(last?.text ?? "", opened: false, final: true).text
            .replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
    }
}

@MainActor
enum ChatStore {
    static let key = "radiant.phone.chats"
    static let maxKept = 40        // MAX in chats.js
    static let maxTurns = 200      // MAX_TURNS in chats.js

    private static func rows(_ kv: KV) -> [[String: Any]] { kv.json(key) as? [[String: Any]] ?? [] }

    static func all(_ kv: KV) -> [Chat] {
        rows(kv).compactMap { r in
            guard let id = r["id"] as? String else { return nil }
            let msgs = (r["messages"] as? [[String: Any]] ?? []).enumerated().compactMap { Msg($1, index: $0) }
            return Chat(id: id, title: r["title"] as? String ?? "New chat", modelId: r["modelId"] as? String,
                        modelName: r["modelName"] as? String, skillId: r["skillId"] as? String,
                        archived: r["archived"] as? Bool ?? false,
                        updatedAt: (r["updatedAt"] as? Double) ?? Double(r["updatedAt"] as? Int ?? 0), messages: msgs)
        }.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Save a conversation, newest first, keeping the web's rules.
    static func save(_ kv: KV, _ c: Chat) {
        guard !c.messages.isEmpty else { return }
        var rs = rows(kv).filter { ($0["id"] as? String) != c.id }
        var row: [String: Any] = [
            "id": c.id, "archived": c.archived, "title": title(c.messages),
            "updatedAt": Date().timeIntervalSince1970 * 1000,
            "messages": c.messages.suffix(maxTurns).map(\.dict)
        ]
        row["modelId"] = c.modelId ?? NSNull(); row["modelName"] = c.modelName ?? NSNull(); row["skillId"] = c.skillId ?? NSNull()
        rs.insert(row, at: 0)
        write(kv, rs)
    }

    static func delete(_ kv: KV, _ id: String) { write(kv, rows(kv).filter { ($0["id"] as? String) != id }) }

    static func setArchived(_ kv: KV, _ id: String, _ archived: Bool) {
        var rs = rows(kv)
        guard let i = rs.firstIndex(where: { ($0["id"] as? String) == id }) else { return }
        rs[i]["archived"] = archived
        write(kv, rs)
    }

    /// Archived chats are exempt from the cap: archiving is how you say one matters.
    private static func write(_ kv: KV, _ rs: [[String: Any]]) {
        let archived = rs.filter { $0["archived"] as? Bool == true }
        let rest = Array(rs.filter { $0["archived"] as? Bool != true }.prefix(maxKept))
        let keep = rs.filter { r in
            let id = r["id"] as? String
            return archived.contains { $0["id"] as? String == id } || rest.contains { $0["id"] as? String == id }
        }
        kv.set(key, json: keep)
    }

    /// The first question, trimmed — what every messaging app uses as a title.
    static func title(_ messages: [Msg]) -> String {
        guard let first = messages.first(where: { $0.role == "user" && !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }) else { return "New chat" }
        let t = first.text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return t.count > 60 ? String(t.prefix(57)).trimmingCharacters(in: .whitespaces) + "…" : t
    }

    static func newId() -> String {
        "c" + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36) + String(Int.random(in: 0..<1_000_000), radix: 36)
    }
}

// MARK: - drafts (drafts.js)

@MainActor
enum Drafts {
    static let key = "radiant.phone.drafts"
    static func load(_ kv: KV, _ id: String) -> String { (kv.json(key) as? [String: Any])?[id] as? String ?? "" }
    static func save(_ kv: KV, _ id: String, _ text: String) {
        var d = kv.json(key) as? [String: Any] ?? [:]
        if text.isEmpty { d.removeValue(forKey: id) } else { d[id] = text }
        kv.set(key, json: d)
    }
}

// MARK: - skills (skills.js)

struct Skill: Identifiable, Equatable {
    let id: String
    var name: String
    var body: String
    /// The slash form, e.g. "Plain English" → "plain-english".
    var slug: String {
        name.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}

@MainActor
enum Skills {
    static let key = "radiant.phone.skills"
    static let seededKey = "radiant.phone.skillsSeeded"
    static let maxChars = 900   // MAX_SKILL_CHARS: about a quarter of the prompt budget

    static let bundled: [Skill] = [
        Skill(id: "seed-plain", name: "Plain English", body: "Answer in plain English that a smart person outside software would follow on the first read. No jargon unless you define it in the same sentence."),
        Skill(id: "seed-brief", name: "Keep it short", body: "Answer in at most three sentences. If the honest answer needs more room, give the short answer first and say what you left out."),
        Skill(id: "seed-steps", name: "Step by step", body: "Give the answer as numbered steps in the order I should do them. One action per step. Say what I should see after each one."),
        Skill(id: "seed-reasoning", name: "Show your reasoning", body: "Before the answer, state briefly what you are assuming and why you are taking this approach. If you are unsure, say which part you are unsure about rather than picking confidently."),
        Skill(id: "seed-devil", name: "Argue the other side", body: "Give the strongest case against what I just said before you agree with any of it. Be specific rather than balanced.")
    ]

    static func all(_ kv: KV) -> [Skill] {
        if let rows = kv.json(key) as? [[String: Any]] {
            return rows.compactMap { r in
                guard let id = r["id"] as? String, let name = r["name"] as? String else { return nil }
                return Skill(id: id, name: name, body: r["body"] as? String ?? "")
            }
        }
        // never saved: the bundled five, as skills.js serves them
        return kv.string(seededKey) == "1" ? [] : bundled
    }

    /// Add or change one skill, keeping any field the web stored on it (saveSkill).
    @discardableResult
    static func upsert(_ kv: KV, id: String?, name: String, body: String) -> Skill? {
        let clean = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
        let text = String(body.trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxChars))
        guard !clean.isEmpty, !text.isEmpty else { return nil }
        var rows = (kv.json(key) as? [[String: Any]]) ?? all(kv).map { ["id": $0.id, "name": $0.name, "body": $0.body] }
        let newId = id ?? ("sk-" + String(Int.random(in: 0..<Int(pow(36.0, 7.0))), radix: 36))
        if let i = rows.firstIndex(where: { $0["id"] as? String == id }) {
            rows[i]["name"] = clean; rows[i]["body"] = text
        } else {
            rows.append(["id": newId, "name": clean, "body": text])
        }
        kv.set(key, json: rows); kv.set(seededKey, string: "1")
        return Skill(id: id ?? newId, name: clean, body: text)
    }

    static func delete(_ kv: KV, _ id: String) {
        let rows = (kv.json(key) as? [[String: Any]]) ?? all(kv).map { ["id": $0.id, "name": $0.name, "body": $0.body] }
        kv.set(key, json: rows.filter { $0["id"] as? String != id }); kv.set(seededKey, string: "1")
    }

    /// "/slug rest" → the skill and the rest of the message; an unknown command is left alone (parseSlash).
    static func parseSlash(_ body: String, _ skills: [Skill]) -> (skill: Skill?, text: String) {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let m = text.range(of: "^/([A-Za-z0-9_-]+)\\s*", options: .regularExpression) else { return (nil, text) }
        let cmd = String(text[m]).dropFirst().trimmingCharacters(in: .whitespaces)
        guard let s = skills.first(where: { $0.slug == cmd }) else { return (nil, text) }
        let rest = String(text[m.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        return (s, rest.isEmpty ? "Use the \(s.name) skill." : rest)
    }
}

// MARK: - cloud providers (providers.js, consent.js)

struct Provider: Identifiable {
    let id: String, name: String, baseUrl: String, hint: String
    var prefix: String? = nil
}

@MainActor
enum Providers {
    static let all: [Provider] = [
        Provider(id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", hint: "Claude models. Key from console.anthropic.com.", prefix: "sk-ant-"),
        Provider(id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", hint: "GPT models. Key from platform.openai.com.", prefix: "sk-"),
        Provider(id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", hint: "Hundreds of models behind one key. openrouter.ai/keys.", prefix: "sk-or-"),
        Provider(id: "xai", name: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", hint: "Grok models. Key from console.x.ai.", prefix: "xai-"),
        Provider(id: "nousresearch", name: "Nous Portal", baseUrl: "https://inference-api.nousresearch.com/v1", hint: "Hermes models. Key from portal.nousresearch.com → API Keys."),
        Provider(id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", hint: "deepseek-chat and deepseek-reasoner. platform.deepseek.com."),
        Provider(id: "moonshot", name: "Kimi (Moonshot)", baseUrl: "https://api.moonshot.ai/v1", hint: "Kimi models. platform.moonshot.ai."),
        Provider(id: "zai", name: "GLM (Z.ai)", baseUrl: "https://api.z.ai/api/paas/v4", hint: "GLM-4.6 and 4.5. Works with the GLM Coding Plan."),
        Provider(id: "minimax", name: "MiniMax", baseUrl: "https://api.minimax.io/v1", hint: "MiniMax-M3 and the M2 series. Key from platform.minimax.io — the international platform, not the mainland-China one."),
        Provider(id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", hint: "Very fast open models. console.groq.com.", prefix: "gsk_"),
        Provider(id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", hint: "Mistral and Codestral. console.mistral.ai.")
    ]
    static func byId(_ id: String) -> Provider? { all.first { $0.id == id } }

    static let chosenKey = "radiant.phone.cloudModel"
    static let consentKey = "radiant.phone.cloudConsent"

    /// The chosen cloud model, {providerId, model}, if any.
    static func chosen(_ kv: KV) -> (providerId: String, model: String)? {
        guard let d = kv.json(chosenKey) as? [String: Any], let p = d["providerId"] as? String,
              let m = d["model"] as? String, byId(p) != nil else { return nil }
        return (p, m)
    }
    static func setChosen(_ kv: KV, _ c: (providerId: String, model: String)?) {
        kv.set(chosenKey, json: c.map { ["providerId": $0.providerId, "model": $0.model] })
    }

    static func hasConsent(_ kv: KV, _ providerId: String) -> Bool { ((kv.json(consentKey) as? [String: Any])?[providerId] as? String) != nil }
    static func grantConsent(_ kv: KV, _ providerId: String) {
        var d = kv.json(consentKey) as? [String: Any] ?? [:]
        d[providerId] = ISO8601DateFormatter().string(from: Date())
        kv.set(consentKey, json: d)
    }

    static func revokeConsent(_ kv: KV, _ providerId: String) {
        var d = kv.json(consentKey) as? [String: Any] ?? [:]
        d.removeValue(forKey: providerId)
        kv.set(consentKey, json: d)
    }

    /// A pasted key that is plainly not a key (looksWrong in providers.js).
    static func looksWrong(_ p: Provider, _ value: String) -> String? {
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if v.count < 16 { return "That looks too short to be a key." }
        if v.rangeOfCharacter(from: .whitespaces) != nil { return "That has a space in it — check the paste." }
        if let pre = p.prefix, !v.hasPrefix(pre) { return "\(p.name) keys start with \(pre)" }
        return nil
    }

    /// "anthropic/claude-sonnet-4.5" → "claude-sonnet-4.5" (shortModelName).
    static func shortName(_ model: String) -> String { model.components(separatedBy: "/").last ?? model }
}
