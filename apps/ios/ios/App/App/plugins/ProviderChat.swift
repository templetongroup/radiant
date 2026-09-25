import Foundation
import Capacitor

/// Talking to a cloud provider, natively.
///
/// ⚠️ THE REQUEST IS MADE HERE, NOT IN JAVASCRIPT, and that is the whole point.
/// The key lives in the Keychain; handing it to the web layer so it can call
/// fetch() would put a credential into a WKWebView's memory, its console, and
/// any crash report or screenshot taken of it. This plugin reads the key, makes
/// the call, and streams back only the text — the web layer never sees it.
///
/// Two wire formats cover every provider in the list: OpenAI's /chat/completions
/// (which OpenRouter, xAI, Nous, DeepSeek, Kimi, GLM, Groq and Mistral all
/// speak) and Anthropic's /v1/messages. Both stream server-sent events, so the
/// token events below are the same shape LocalModels already emits and the chat
/// UI does not need to know which kind of model it is talking to.
@objc(ProviderChat)
public class ProviderChat: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ProviderChat"
    public let jsName = "ProviderChat"
    // ⚠️ Missing from this list = compiles, links, and is refused at runtime.
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "models", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private var live: Task<Void, Never>?

    // The Keychain read, the request and the stream parsing live in CloudStream
    // (Native/Engines.swift), shared with the native chat — one copy of the
    // code that holds the key.

    // MARK: - models

    /// The provider's own model list, so the picker shows what this key can
    /// actually reach rather than a list we hard-coded and let go stale.
    @objc func models(_ call: CAPPluginCall) {
        guard let provider = call.getString("provider"), let base = call.getString("baseUrl") else {
            return call.reject("provider and baseUrl are required")
        }
        Task {
            do { call.resolve(["models": try await CloudStream.models(provider: provider, baseUrl: base)]) }
            catch { call.reject(error.localizedDescription) }
        }
    }

    // MARK: - send

    @objc func send(_ call: CAPPluginCall) {
        guard let provider = call.getString("provider"),
              let base = call.getString("baseUrl"),
              let model = call.getString("model"),
              let messages = call.getArray("messages") as? [[String: String]] else {
            return call.reject("provider, baseUrl, model and messages are required")
        }
        live?.cancel()
        live = Task { [weak self] in
            guard let self else { return }
            do {
                try await CloudStream.stream(provider: provider, baseUrl: base, model: model, messages: messages) { text in
                    self.notifyListeners("cloudToken", data: ["text": text])
                }
                if Task.isCancelled {
                    self.notifyListeners("cloudDone", data: ["stopped": true])
                    call.resolve(["stopped": true])
                } else {
                    self.notifyListeners("cloudDone", data: [:])
                    call.resolve(["ok": true])
                }
            } catch {
                self.notifyListeners("cloudFailed", data: ["message": error.localizedDescription])
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        live?.cancel()
        live = nil
        call.resolve(["ok": true])
    }
}
