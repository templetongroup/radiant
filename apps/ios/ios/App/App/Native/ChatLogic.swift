import Foundation

// The same rules as the web chat (src/mobile/MobileChat.jsx, thinking.js), so a
// conversation behaves the same in either design.

enum Prompt {
    static let turns = 6, chars = 4000   // PROMPT_TURNS, PROMPT_CHARS in MobileChat.jsx

    /// The recent transcript as one prompt, when the engine's session cannot be
    /// reused. A skill's instructions go first and are paid for out of the budget.
    static func build(_ history: [Msg], next: String, instructions: String = "", inline: Bool = true) -> String {
        let head = instructions.isEmpty ? "" : "Instructions: \(instructions.trimmingCharacters(in: .whitespacesAndNewlines))\n\n"
        let budget = chars - head.count
        var ts = Array((history + [Msg(id: "", role: "user", text: next)]).suffix(turns))
        // a window that opens on a reply reads as a fragment; open on the question
        while ts.count > 1, ts.first?.role == "assistant" { ts.removeFirst() }
        var blocks = ts.map { ($0.role == "user" ? "User: " : "Assistant: ") + $0.text }
        let tail = "\n\nAssistant:"
        func fits() -> Bool { blocks.joined(separator: "\n\n").count + tail.count <= budget }
        while blocks.count > 1, !fits() { blocks.removeFirst() }
        // one turn alone can still blow the cap: keep its END, the question just asked
        if !fits(), let b = blocks.first { blocks[0] = String(b.suffix(max(budget - tail.count, 0))) }
        return (inline ? head : "") + blocks.joined(separator: "\n\n") + tail
    }

    /// The transcript as {role, content} for a cloud model, which has real
    /// multi-turn memory — the last 12 turns, as the web sends.
    static func cloudMessages(_ history: [Msg], next: String, instructions: String) -> [[String: String]] {
        var out: [[String: String]] = []
        if !instructions.isEmpty { out.append(["role": "system", "content": instructions]) }
        out += history.suffix(12).map { ["role": $0.role == "user" ? "user" : "assistant", "content": Fold.visible($0.text, opened: false, final: true).text] }
        out.append(["role": "user", "content": next])
        return out
    }
}

enum Fold {
    /// A model's thinking is not its answer: hide <think> blocks, an orphan
    /// </think> (the template opened it in the prompt), and — for a model known
    /// to think that way — everything until it closes. An answer never vanishes:
    /// at the end (`final`) a known thinker that never closed is shown whole.
    static func visible(_ raw: String, opened: Bool, final: Bool) -> (text: String, thinking: Bool) {
        var s = raw
        let open0 = s.range(of: "<think>"), close0 = s.range(of: "</think>")
        if let c = close0, open0 == nil || c.lowerBound < open0!.lowerBound {
            s = String(s[c.upperBound...]).replacingOccurrences(of: "^\n+", with: "", options: .regularExpression)
        } else if opened, close0 == nil, open0 == nil, !final {
            return ("", true)
        }
        var out = "", thinking = false
        while !s.isEmpty {
            if !thinking {
                guard let o = s.range(of: "<think>") else { out += s; break }
                out += s[..<o.lowerBound]; s = String(s[o.upperBound...]); thinking = true
            } else {
                guard let c = s.range(of: "</think>") else { s = ""; break }
                s = String(s[c.upperBound...]).replacingOccurrences(of: "^\n+", with: "", options: .regularExpression)
                thinking = false
            }
        }
        return (out, thinking)
    }
}
