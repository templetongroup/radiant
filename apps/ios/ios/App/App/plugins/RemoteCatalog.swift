import Foundation

/// The model list, fetched instead of frozen into the binary.
///
/// ⚠️ THE POINT IS THE GEMMA 4 BUG. v1.0 build 2 shipped pointing Gemma 4 at
/// `-qat-mobile` repos whose weights are packed 4-bit while their config declares
/// no quantization: MLX builds a dense model, the shapes disagree, and the user
/// gets `mismatched parameters` — after downloading 3.5 GB. It was fixed the same
/// day and could not reach anybody, because the catalogue was a Swift array and a
/// Swift array only changes through App Store review. This is what turns a
/// week-long fix into a five-minute one.
///
/// ⚠️ THE BUILT-IN ARRAY IS STILL THE SOURCE OF TRUTH. Everything here is an
/// override applied on top of it. Offline, first launch, a 500, a truncated body,
/// malformed JSON, an empty list — every one of those falls back to what shipped,
/// which is the list Apple reviewed. A model picker that can be emptied by a bad
/// deploy is worse than one that is merely out of date.
enum RemoteCatalog {

    static let url = URL(string: "https://www.templetongroup.dev/showcase/radiant/catalog.json")!

    /// One published row. Only `id`, `name` and `repo` are load-bearing; everything
    /// else has a sane default, so a future field cannot break an older app.
    struct Row: Codable, Equatable {
        let id: String
        let name: String
        var maker: String = ""
        var blurb: String = ""
        var gb: Double = 0
        let repo: String
        var stop: String? = nil
        var vision: Bool = false
        var video: Bool = false
    }

    struct Document: Codable {
        let schema: Int
        var generated: String = ""
        let models: [Row]
    }

    // MARK: - the pure part, which is where the mistakes live

    /// Decodes and validates. Returns nil for anything we should ignore in favour
    /// of the built-in list.
    ///
    /// ⚠️ A ROW WITH gb == 0 IS REJECTED, NOT DEFAULTED. The download progress bar
    /// divides by that number. Download progress has broken in production four
    /// times on this app — flatlining at 2%, starting at 100%, showing nothing, and
    /// calling a stopped download finished — and every one was arithmetic. A zero
    /// here would divide by zero on a phone, remotely, for everybody at once.
    static func decode(_ data: Data) -> [Row]? {
        guard let doc = try? JSONDecoder().decode(Document.self, from: data) else { return nil }
        guard doc.schema == 1 else { return nil }   // a newer schema is not ours to guess at
        var seen = Set<String>()
        var out: [Row] = []
        for row in doc.models {
            guard !row.id.isEmpty, !row.name.isEmpty, !row.repo.isEmpty else { continue }
            guard row.gb > 0, row.gb < 200 else { continue }   // 200 GB is not a phone model
            guard row.repo.contains("/"), !row.repo.hasPrefix("/") else { continue }
            guard seen.insert(row.id).inserted else { continue }
            out.append(row)
        }
        return out.isEmpty ? nil : out
    }

    /// What the picker should show.
    ///
    /// ⚠️ A MODEL YOU HAVE ALREADY DOWNLOADED NEVER DISAPPEARS. If a published
    /// catalogue drops a row — deliberately or by accident — someone with 4 GB of
    /// weights on disk would watch that model vanish from the app with no way to
    /// use or delete it. Anything on disk is kept, at the end, whatever the server
    /// says.
    ///
    /// Order follows the published list, because that is the curation; built-in
    /// survivors keep their relative order after it.
    static func merge(builtIn: [String], remote: [Row]?, onDisk: Set<String>) -> [String] {
        guard let remote, !remote.isEmpty else { return builtIn }
        let published = remote.map(\.id)
        let publishedSet = Set(published)
        let rescued = builtIn.filter { !publishedSet.contains($0) && onDisk.contains($0) }
        return published + rescued
    }
}
