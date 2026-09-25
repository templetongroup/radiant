import SwiftUI
import UIKit

// The native app's foundation: the shared store, the theme, and small helpers.
//
// ⚠️ ONE STORE, TWO FRONTS, DURING THE REBUILD. The web screens keep their data
// in localStorage under `radiant.phone.*` and `rx.*`. Until every screen is
// native, the native screens read and write THOSE SAME KEYS, in THOSE SAME
// SHAPES, through this mirror: the web hands over a snapshot when the native
// app opens, and every write goes straight back (NativeApp.swift's "kv" event).
// So either design can be used at any moment and neither loses the other's
// work. When the web screens are gone, KV's backing changes to a file and
// nothing above it moves.

/// The mirror of the web store's keys. Values are the raw strings localStorage holds.
@MainActor
final class KV: ObservableObject {
    @Published private(set) var raw: [String: String]
    /// Sends a write back to the web store (nil value = remove).
    var onWrite: (String, String?) -> Void = { _, _ in }

    init(_ snapshot: [String: String]) { raw = snapshot }

    func string(_ key: String) -> String? { raw[key] }

    func json(_ key: String) -> Any? {
        guard let s = raw[key], let d = s.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: d, options: [.fragmentsAllowed])
    }

    func set(_ key: String, string value: String?) {
        if let value { raw[key] = value } else { raw.removeValue(forKey: key) }
        onWrite(key, value)
    }

    func set(_ key: String, json value: Any?) {
        guard let value else { return set(key, string: nil) }
        guard let d = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
              let s = String(data: d, encoding: .utf8) else { return }
        set(key, string: s)
    }
}

// MARK: - theme (src/mobile/theme.js and mobile.css, in Swift)

/// Colors the screens draw with. Mirrors the web tokens (--rx-bg, --rx-cell, …)
/// so a theme looks the same in both designs.
struct Palette {
    var bg: Color, grouped: Color, cell: Color, cell2: Color
    var separator: Color
    var label: Color, label2: Color, label3: Color
    var tint: Color, onTint: Color, tintText: Color
    var dark: Bool
}

struct RXTheme {
    let id: String, name: String, hue: Double, chroma: Double
    /// Pinned surfaces and labels, for the themes whose identity is their ground.
    var pinned: [String: String] = [:]
}

/// Appearance, from `radiant.phone.appearance`: {themeId, textScale, mode, openTo}.
struct Appearance: Equatable {
    var themeId = "radiant"
    var textScale = 1.0
    var mode = "dark"        // dark | medium | light | system
    var openTo = "home"      // home | chat

    static let key = "radiant.phone.appearance"

    init() {}
    init(_ any: Any?) {
        guard let d = any as? [String: Any] else { return }
        if let t = d["themeId"] as? String, Themes.all.contains(where: { $0.id == t }) { themeId = t }
        if let s = d["textScale"] as? Double, [0.92, 1, 1.1, 1.2].contains(s) { textScale = s }
        if let m = d["mode"] as? String, ["dark", "medium", "light", "system"].contains(m) { mode = m }
        if let o = d["openTo"] as? String, ["home", "chat"].contains(o) { openTo = o }
    }

    var json: [String: Any] { ["themeId": themeId, "textScale": textScale, "mode": mode, "openTo": openTo] }
}

enum Themes {
    // Hues and chromas copied from src/mobile/theme.js, which copies the Mac's.
    static let all: [RXTheme] = [
        RXTheme(id: "radiant", name: "Radiant", hue: 258, chroma: 0.11),
        RXTheme(id: "ember", name: "Ember", hue: 55, chroma: 0.17),
        RXTheme(id: "tokyonight", name: "Tokyo Night", hue: 265, chroma: 0.14),
        RXTheme(id: "catppuccin", name: "Catppuccin", hue: 310, chroma: 0.11),
        RXTheme(id: "everforest", name: "Everforest", hue: 150, chroma: 0.09, pinned: [
            "bg": "#222A30", "grouped": "#2D353B", "cell": "#363E44", "cell2": "#3F474D",
            "separator": "rgba(211,198,170,0.26)", "label": "#D3C6AA", "label2": "rgba(211,198,170,0.72)",
            "label3": "rgba(211,198,170,0.42)", "tint": "#A7C080", "onTint": "#22282A"]),
        RXTheme(id: "templeton", name: "Templeton", hue: 89.4, chroma: 0.02, pinned: [
            "bg": "#4f5b4c", "grouped": "#576354", "cell": "#606d5d", "cell2": "#6a7666",
            "separator": "rgba(242,244,248,0.26)", "label": "#f2f4f8", "label2": "rgba(242,244,248,0.72)",
            "label3": "rgba(242,244,248,0.42)", "tint": "#8b8679", "tintText": "#fef8ea", "onTint": "#0e0b03"]),
        RXTheme(id: "gruvbox", name: "Gruvbox", hue: 60, chroma: 0.13),
        RXTheme(id: "nord", name: "Nord", hue: 240, chroma: 0.08),
        RXTheme(id: "dracula", name: "Dracula", hue: 290, chroma: 0.15),
        RXTheme(id: "rosepine", name: "Rosé Pine", hue: 350, chroma: 0.10),
        RXTheme(id: "solarized", name: "Solarized", hue: 195, chroma: 0.10),
        RXTheme(id: "moss", name: "Moss", hue: 150, chroma: 0.12),
        RXTheme(id: "graphite", name: "Graphite", hue: 260, chroma: 0.01),
        RXTheme(id: "nousclassic", name: "Nous Classic", hue: 250, chroma: 0.16, pinned: [
            "bg": "#0E1F52", "grouped": "#182B5F", "cell": "#203469", "cell2": "#293E73",
            "separator": "rgba(244,221,197,0.26)", "label": "#F4DDC5", "label2": "rgba(244,221,197,0.72)",
            "label3": "rgba(244,221,197,0.42)", "tint": "#F4DDC5", "onTint": "#182B5F"])
    ]

    static func theme(_ id: String) -> RXTheme { all.first { $0.id == id } ?? all[0] }

    /// The palette for an appearance and the phone's current light/dark.
    static func palette(_ a: Appearance, systemDark: Bool) -> Palette {
        let t = theme(a.themeId)
        let h = t.hue, c = t.chroma
        let dark = a.mode == "dark" || a.mode == "medium" || (a.mode == "system" && systemDark) || !t.pinned.isEmpty
        var p: Palette
        if !dark {
            p = Palette(bg: .white, grouped: Color(hex: "#F2F2F7"), cell: .white, cell2: Color(hex: "#F2F2F7"),
                        separator: Color(css: "rgba(60,60,67,0.29)"),
                        label: .black, label2: Color(css: "rgba(60,60,67,0.60)"), label3: Color(css: "rgba(60,60,67,0.30)"),
                        tint: Color(oklch: 0.52, c, h), onTint: .white, tintText: Color(oklch: 0.52, c, h), dark: false)
        } else {
            p = Palette(bg: .black, grouped: .black, cell: Color(hex: "#1C1C1E"), cell2: Color(hex: "#2C2C2E"),
                        separator: Color(css: "rgba(84,84,88,0.65)"),
                        label: .white, label2: Color(css: "rgba(235,235,245,0.60)"), label3: Color(css: "rgba(235,235,245,0.30)"),
                        tint: Color(oklch: 0.72, c, h), onTint: Color(hex: "#050911"), tintText: Color(oklch: 0.72, c, h), dark: true)
            if a.mode == "medium" {
                p.bg = Color(oklch: 0.30, 0.008, h); p.grouped = p.bg
                p.cell = Color(oklch: 0.36, 0.010, h); p.cell2 = Color(oklch: 0.40, 0.012, h)
                p.separator = Color.white.opacity(0.14)
                p.label = Color(oklch: 0.96, 0.003, h); p.label2 = Color(oklch: 0.78, 0.006, h); p.label3 = Color(oklch: 0.62, 0.005, h)
            }
        }
        // Pinned palettes beat the mode, exactly as the inline styles do on the web.
        let pin = t.pinned
        if let v = pin["bg"] { p.bg = Color(css: v) }
        if let v = pin["grouped"] { p.grouped = Color(css: v) }
        if let v = pin["cell"] { p.cell = Color(css: v) }
        if let v = pin["cell2"] { p.cell2 = Color(css: v) }
        if let v = pin["separator"] { p.separator = Color(css: v) }
        if let v = pin["label"] { p.label = Color(css: v) }
        if let v = pin["label2"] { p.label2 = Color(css: v) }
        if let v = pin["label3"] { p.label3 = Color(css: v) }
        if let v = pin["tint"] { p.tint = Color(css: v); p.tintText = Color(css: v) }
        if let v = pin["tintText"] { p.tintText = Color(css: v) }
        if let v = pin["onTint"] { p.onTint = Color(css: v) }
        return p
    }

    /// The swatch the picker shows: the pinned tint, or the dark-mode tint.
    static func swatch(_ t: RXTheme) -> Color {
        t.pinned["tint"].map { Color(css: $0) } ?? Color(oklch: 0.72, t.chroma, t.hue)
    }
}

private struct PaletteKey: EnvironmentKey {
    static let defaultValue = Themes.palette(Appearance(), systemDark: true)
}
extension EnvironmentValues {
    var rx: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}

/// Applies an appearance to a screen tree: palette, light/dark, and the user's
/// text size on top of Dynamic Type (one step down, or one or two up).
struct Themed: ViewModifier {
    let appearance: Appearance
    @Environment(\.colorScheme) private var system
    @Environment(\.dynamicTypeSize) private var type

    func body(content: Content) -> some View {
        let p = Themes.palette(appearance, systemDark: system == .dark)
        let steps = appearance.textScale < 1 ? -1 : appearance.textScale >= 1.2 ? 2 : appearance.textScale > 1 ? 1 : 0
        let all = DynamicTypeSize.allCases
        let i = min(max((all.firstIndex(of: type) ?? 3) + steps, 0), all.count - 1)
        return content
            .environment(\.rx, p)
            .tint(p.tint)
            .preferredColorScheme(appearance.mode == "system" && Themes.theme(appearance.themeId).pinned.isEmpty ? nil : (p.dark ? .dark : .light))
            .dynamicTypeSize(all[i])
    }
}

// MARK: - colors from the web's notations

extension Color {
    /// OKLCH → sRGB, the conversion CSS does for `oklch(L C H)`.
    init(oklch L: Double, _ C: Double, _ H: Double, opacity: Double = 1) {
        let hr = H * .pi / 180, a = C * cos(hr), b = C * sin(hr)
        let l_ = L + 0.3963377774 * a + 0.2158037573 * b
        let m_ = L - 0.1055613458 * a - 0.0638541728 * b
        let s_ = L - 0.0894841775 * a - 1.2914855480 * b
        let l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_
        func g(_ x: Double) -> Double {
            let v = x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055
            return min(max(v, 0), 1)
        }
        self.init(.sRGB,
                  red: g(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
                  green: g(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
                  blue: g(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
                  opacity: opacity)
    }

    init(hex: String) {
        let h = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let v = UInt64(h, radix: 16) ?? 0
        self.init(.sRGB, red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }

    /// `#rrggbb` or `rgba(r, g, b, a)`.
    init(css: String) {
        let s = css.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { self.init(hex: s); return }
        let nums = s.components(separatedBy: CharacterSet(charactersIn: "0123456789.").inverted).compactMap(Double.init)
        guard nums.count >= 3 else { self = .gray; return }
        self.init(.sRGB, red: nums[0] / 255, green: nums[1] / 255, blue: nums[2] / 255, opacity: nums.count > 3 ? nums[3] : 1)
    }
}

// MARK: - small shared pieces

enum Relative {
    static func label(_ ms: Double) -> String {
        guard ms > 0 else { return "" }
        let d = Date(timeIntervalSince1970: ms / 1000)
        if Date().timeIntervalSince(d) < 60 { return "Just now" }
        return d.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }
}

/// Liquid Glass on iOS 26 and later; a material with a hairline everywhere else.
struct Glass<S: Shape>: ViewModifier {
    let shape: S
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: shape)
        } else {
            content
                .background(.regularMaterial, in: shape)
                .overlay(shape.stroke(.quaternary))
                .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
        }
    }
}

struct Pulse: ViewModifier {
    @State private var dim = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content.opacity(dim ? 0.45 : 1)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
            }
    }
}

/// Navigation titles are drawn by UIKit, so a theme change has to reach them
/// directly: the appearance proxy for bars not made yet, and every bar on screen.
enum NavTitles {
    @MainActor static func recolor(_ color: Color) {
        let attrs: [NSAttributedString.Key: Any] = [.foregroundColor: UIColor(color)]
        UINavigationBar.appearance().largeTitleTextAttributes = attrs
        UINavigationBar.appearance().titleTextAttributes = attrs
        func walk(_ vc: UIViewController?) {
            guard let vc else { return }
            if let nav = vc as? UINavigationController {
                nav.navigationBar.largeTitleTextAttributes = attrs
                nav.navigationBar.titleTextAttributes = attrs
            }
            vc.children.forEach(walk)
            walk(vc.presentedViewController)
        }
        for scene in UIApplication.shared.connectedScenes {
            (scene as? UIWindowScene)?.windows.forEach { walk($0.rootViewController) }
        }
    }
}
