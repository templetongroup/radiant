import Foundation
import Capacitor
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Apple's on-device model, as the thing that answers before anything is downloaded.
///
/// ⚠️ THE POINT IS THE FIRST CHAT. Radiant's own models are 0.7–4 GB and the
/// app is useless until one finishes downloading. Apple's model is already on
/// the phone, costs nothing, needs no key and no network — so a brand new
/// install can answer immediately and the download becomes a choice rather
/// than a toll gate.
///
/// ⚠️ WEAK-LINKED AND GATED TWICE. The deployment target is iOS 17 and
/// FoundationModels does not exist before iOS 26, so the import is behind
/// canImport and every use behind @available. A hard link would fail to launch
/// on every phone below 26 — silently, at dyld time, before any of our code
/// runs.
@objc(AppleModel)
public class AppleModel: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppleModel"
    public let jsName = "AppleModel"
    // ⚠️ Missing from this list = compiles, links, and is refused at runtime.
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "availability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private var live: Task<Void, Never>?

    /// Why it cannot answer, in words a person can act on.
    ///
    /// ⚠️ NEVER JUST "UNAVAILABLE". Each reason has a different fix — one is a
    /// settings toggle, one is a wait, one is the phone itself — and a single
    /// dead sentence would send the user looking for a switch that is not there.
    @objc func availability(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                call.resolve(["available": true, "reason": ""])
            case .unavailable(let why):
                var text: String
                switch why {
                case .deviceNotEligible:
                    text = "This iPhone does not support Apple Intelligence."
                case .appleIntelligenceNotEnabled:
                    text = "Turn on Apple Intelligence in Settings to use Apple's model."
                case .modelNotReady:
                    text = "Apple's model is still downloading in the background. Try again shortly."
                @unknown default:
                    text = "Apple's model is not available on this iPhone right now."
                }
                call.resolve(["available": false, "reason": text])
            @unknown default:
                call.resolve(["available": false, "reason": "Apple's model is not available on this iPhone right now."])
            }
            return
        }
        #endif
        call.resolve(["available": false, "reason": "Apple's model needs iOS 26 or later."])
    }

    @objc func send(_ call: CAPPluginCall) {
        let prompt = call.getString("prompt") ?? ""
        let instructions = call.getString("instructions") ?? ""
        guard !prompt.isEmpty else {
            call.reject("empty prompt")
            return
        }
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            guard case .available = SystemLanguageModel.default.availability else {
                call.reject("unavailable")
                return
            }
            live?.cancel()
            live = Task { [weak self] in
                guard let self else { return }
                do {
                    let session = instructions.isEmpty
                        ? LanguageModelSession()
                        : LanguageModelSession(instructions: instructions)
                    // ⚠️ SNAPSHOTS, NOT TOKENS. The stream yields the whole
                    // answer so far each time, while the chat appends what it
                    // is handed — so send only what is new, or every character
                    // arrives multiplied by the number of updates.
                    var sent = ""
                    for try await partial in session.streamResponse(to: prompt) {
                        if Task.isCancelled { break }
                        let text = String(describing: partial.content)
                        if text.hasPrefix(sent) {
                            let delta = String(text.dropFirst(sent.count))
                            if !delta.isEmpty { self.notifyListeners("appleToken", data: ["text": delta]) }
                        } else {
                            // the model revised what it had already said
                            self.notifyListeners("appleReset", data: ["text": text])
                        }
                        sent = text
                    }
                    if Task.isCancelled {
                        self.notifyListeners("appleDone", data: ["stopped": true])
                    } else {
                        self.notifyListeners("appleDone", data: [:])
                    }
                } catch {
                    self.notifyListeners("appleFailed", data: ["message": error.localizedDescription])
                }
            }
            call.resolve()
            return
        }
        #endif
        call.reject("unavailable")
    }

    @objc func stop(_ call: CAPPluginCall) {
        live?.cancel()
        live = nil
        call.resolve()
    }
}
