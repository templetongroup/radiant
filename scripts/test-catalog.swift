// The remotely-published model catalogue: decoding, validation, and the merge.
//
// ⚠️ THIS IS THE SAME RISK AS scripts/test-download-math.swift, ONE STEP WORSE.
// That file exists because download progress broke in production four times and
// every failure was arithmetic that needed no MLX, no simulator and no phone to
// test. This code has the same shape — values in, values out — but a mistake here
// reaches every installed copy at once, without an App Store release to slow it
// down. A published catalogue is a remote code path.
//
// Run: swift scripts/test-catalog.swift

import Foundation

// The file under test, minus its network entry point.
let src = try! String(contentsOfFile: "apps/ios/ios/App/App/plugins/RemoteCatalog.swift", encoding: .utf8)

var pass = 0, fail = 0
func ok(_ cond: Bool, _ what: String) {
    if cond { pass += 1 } else { fail += 1; print("  FAIL \(what)") }
}

// ── the source itself must keep its guarantees ─────────────────────────────
ok(src.contains("row.gb > 0"), "a row with no size is rejected — the progress bar divides by it")
ok(src.contains("doc.schema == 1"), "an unknown schema is ignored rather than guessed at")
ok(src.contains("out.isEmpty ? nil : out"), "an empty published list falls back to the built-in one")
ok(src.contains("onDisk.contains($0)"), "a downloaded model is never dropped by a publish")
ok(src.contains("seen.insert(row.id).inserted"), "duplicate ids are collapsed, not shown twice")
ok(src.contains("row.repo.contains(\"/\")"), "a repo id must look like owner/name")

// ── the merge, exercised directly ──────────────────────────────────────────
struct Row { let id: String }
func merge(builtIn: [String], remote: [String]?, onDisk: Set<String>) -> [String] {
    guard let remote, !remote.isEmpty else { return builtIn }
    let publishedSet = Set(remote)
    return remote + builtIn.filter { !publishedSet.contains($0) && onDisk.contains($0) }
}

let builtIn = ["gemma3-1b", "qwen3-1.7b", "llama3-2-3b"]

ok(merge(builtIn: builtIn, remote: nil, onDisk: []) == builtIn,
   "no catalogue fetched yet → exactly what shipped")
ok(merge(builtIn: builtIn, remote: [], onDisk: []) == builtIn,
   "an empty catalogue → what shipped, never an empty picker")
ok(merge(builtIn: builtIn, remote: ["gemma4-e4b", "qwen3-1.7b"], onDisk: []) == ["gemma4-e4b", "qwen3-1.7b"],
   "a published catalogue replaces the built-in list, in its own order")
ok(merge(builtIn: builtIn, remote: ["gemma4-e4b"], onDisk: ["llama3-2-3b"]) == ["gemma4-e4b", "llama3-2-3b"],
   "a model already on disk survives being dropped from the catalogue")
ok(merge(builtIn: builtIn, remote: ["gemma4-e4b"], onDisk: ["gemma3-1b", "qwen3-1.7b"])
     == ["gemma4-e4b", "gemma3-1b", "qwen3-1.7b"],
   "several rescued models keep their built-in order, after the published ones")
ok(merge(builtIn: builtIn, remote: ["qwen3-1.7b"], onDisk: ["qwen3-1.7b"]) == ["qwen3-1.7b"],
   "a model that is both published and on disk appears once")

// ── the published file must itself be sane ─────────────────────────────────
let data = try! Data(contentsOf: URL(fileURLWithPath: "apps/ios/catalog.json"))
let doc = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
let models = doc["models"] as! [[String: Any]]
ok(doc["schema"] as? Int == 1, "the exported file declares schema 1")
ok(models.count >= 40, "it carries the whole catalogue (\(models.count) models), not a truncated parse")
ok(models.allSatisfy { ($0["gb"] as? Double ?? 0) > 0 }, "every exported row has a real measured size")
ok(models.allSatisfy { ($0["repo"] as? String ?? "").contains("/") }, "every exported row names a repo")
ok(Set(models.map { $0["id"] as! String }).count == models.count, "exported ids are unique")

// ⚠️ THE ROW THAT CAUSED ALL THIS. The shipped build points Gemma 4 at
// `-qat-mobile`, whose weights are 4-bit while the config declares none: MLX builds
// a dense model and the user gets `mismatched parameters` after 3.5 GB. The whole
// point of publishing a catalogue is that this row can be corrected without review.
let gemma4 = models.filter { ($0["id"] as! String).hasPrefix("gemma4") }
ok(gemma4.count == 2, "both Gemma 4 rows are published")
ok(gemma4.allSatisfy { !($0["repo"] as! String).contains("qat-mobile") },
   "and neither points at the -qat-mobile repos that break with mismatched parameters")

print("  \(pass)/\(pass + fail) passed  ·  a bad publish falls back, never empties the picker")
exit(fail == 0 ? 0 : 1)
