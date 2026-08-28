import Foundation
import Capacitor
import os   // os_proc_available_memory()
import UIKit
import CoreImage   // CIImage, for a photo on its way to a vision model

import MLXLLM
// ⚠️ IMPORTING IT IS WHAT REGISTERS IT. loadModelContainer walks
// ModelFactoryRegistry.shared and tries each factory in turn, so a vision model
// only loads if MLXVLM has been linked AND imported — otherwise it fails at
// runtime with "no model factory available", not at build time.
import MLXVLM
import MLXLMCommon
import MLXHuggingFace
import HuggingFace
import Tokenizers

/// Running a model ON THE PHONE.
///
/// This is the app's primary mode, not a fallback: someone installs Radiant,
/// picks a model, downloads it, and starts talking — no Mac, no account, no
/// network after the download. Connecting to Radiant on a Mac is the secondary
/// path for people who have one.
///
/// The web UI drives this over Capacitor. Downloads and generation both report
/// progress as events rather than blocking, because a 1–4 GB download and a
/// token stream both need to show something while they work.
/// A catalogue row for a HuggingFace repo MLX has no registry entry for.
///
/// `stop` is the chat template's turn-end token, passed as an extra EOS. Omit
/// it only when the repo's own `eos_token` is already that token — true for the
/// Qwen, LFM2, Llama, Granite, Mistral and DeepSeek rows, and false for every
/// Gemma and for Phi.
///
/// File scope rather than a method: `catalog` is a stored property, and its
/// initialiser runs before there is a `self` to call a method on.
private func rxRepo(_ id: String, stop: String? = nil) -> ModelConfiguration {
    ModelConfiguration(id: id, extraEOSTokens: stop.map { Set([$0]) } ?? [])
}


/// This process's memory LIMIT, not the headroom left in it.
///
/// ⚠️ `os_proc_available_memory()` ALONE IS THE WRONG BUDGET, and using it as
/// one is a bug I shipped. It returns what is left AFTER everything the app has
/// already allocated — at launch the WebView, React and the model list are
/// already resident — so it under-reports the ceiling by however much Radiant
/// happens to be using at the moment you ask. Worse, it moves: the same model
/// could read "runs well" on a fresh launch and "won't run" after a long
/// conversation, with nothing about the model or the phone having changed.
///
/// The ceiling is what is left PLUS what is already used. `phys_footprint` is
/// the same figure iOS itself judges against for jetsam, so the sum is the real
/// limit rather than an estimate of it.
private func rxMemoryLimit() -> Int64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let kerr = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
        }
    }
    let available = Int64(os_proc_available_memory())
    let limit = (kerr == KERN_SUCCESS) ? available + Int64(info.phys_footprint) : available

    // ⚠️ os_proc_available_memory() RETURNS 0 IN THE SIMULATOR, and a zero
    // budget is not a small budget — it is no answer at all. Shipped, it read:
    //     "iOS gives one app about 0.0 GB of that"
    //     "Models up to roughly -0.4 GB run well here"
    //     every maker: "none run here"
    // A NEGATIVE GIGABYTE FIGURE on screen, and all 44 models refused. Caught by
    // running the app, not by reading it.
    //
    // Anything implausibly small means the API could not answer, so fall back to
    // a conservative share of physical memory — near what iOS actually grants an
    // app with the increased-memory-limit entitlement, and always a real number.
    let floor: Int64 = 512 * 1024 * 1024
    guard limit > floor else {
        return Int64(Double(ProcessInfo.processInfo.physicalMemory) * 0.45)
    }
    return limit
}

@objc(LocalModels)
public class LocalModels: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LocalModels"
    public let jsName = "LocalModels"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "downloaded", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        // ⚠️ A method missing from THIS list compiles, links, and has a live
        // ObjC selector — and Capacitor still refuses the call at runtime. It
        // is how you ship a button that does nothing. Add here as well as below.
        CAPPluginMethod(name: "cancelDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "diskInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deviceInfo", returnType: CAPPluginReturnPromise)
    ]

    /// A short, curated list rather than every model on Hugging Face.
    /// Picking a model is the first thing a new user does, and a wall of
    /// 200 names with quantisation suffixes is where they give up. Sizes are
    /// the download, measured, so nobody starts a 4 GB pull on cellular by
    /// accident.
    private struct Entry {
        let id: String, name: String, maker: String, blurb: String, gb: Double
        let config: ModelConfiguration
        /// Reads pictures. The composer only offers an image when this is true,
        /// because a text-only model handed one silently ignores it.
        var vision: Bool = false
        /// Reads short clips as well as stills.
        var video: Bool = false
    }
    /// ⚠️ SIZES ARE MEASURED, NOT ESTIMATED. Each is the summed blob size from
    /// huggingface.co/api/models/<id>?blobs=true, because the download progress
    /// bar divides by this number — a guessed size shows a wrong percentage.
    ///
    /// ⚠️ AND SO ARE THE STOP TOKENS. `stop:` is the token the model's CHAT
    /// TEMPLATE ends a turn with, which is frequently NOT the `eos_token` in its
    /// tokenizer config: every Gemma declares `<eos>` and then ends turns with
    /// `<end_of_turn>` (Gemma 3) or `<turn|>` (Gemma 4). Get it wrong and the
    /// model never stops — it answers, then writes the user's next turn for
    /// them. Each was read from that repo's own chat template.
    ///
    /// Both are generated, not typed: scripts/catalog-verify.py probes every
    /// repo and regenerates this array. Re-run it when the catalogue changes
    /// rather than editing sizes by hand.
    ///
    /// ⚠️ LLMRegistry IS NOT THE MENU. It is MLX's SAMPLE list; what actually
    /// gates a model is `LLMTypeRegistry`, the 62 ARCHITECTURES MLX implements.
    /// Any repo whose config.json names one of those loads through
    /// `ModelConfiguration(id:)`. Reading the sample list as the capability list
    /// is what once made this catalogue six models. Registry constants are still
    /// preferred where one exists, because MLX curates their stop tokens.
    ///
    /// What is NOT loadable, whatever its name: GGUF (llama.cpp's format) and
    /// bitsandbytes 4-bit — which is everything Unsloth publishes. MLX needs
    /// safetensors with MLX quantization metadata.
    ///
    /// THE LIST RUNS PAST WHAT A PHONE CAN HOLD, deliberately. Radiant labels
    /// every model runs well / runs tight / won't run against THIS device's
    /// memory, and a list pre-filtered to what fits would make that label
    /// meaningless — and would hide from a 12 GB iPhone that it can run things a
    /// 6 GB one cannot. Ordered smallest first within each maker.
    private let catalog: [Entry] = [

        // ---- Google ----
        Entry(id: "gemma3-270m", name: "Gemma 3 270M", maker: "Google",
              blurb: "The smallest model here. Instant, for simple rewrites.",
              gb: 0.19, config: rxRepo("mlx-community/gemma-3-270m-it-4bit", stop: "<end_of_turn>")),
        Entry(id: "gemma3-1b", name: "Gemma 3 1B", maker: "Google",
              blurb: "Trained for its quantization, so it holds up small. Steady writer.",
              gb: 0.77, config: LLMRegistry.gemma3_1B_qat_4bit),
        Entry(id: "gemma2-2b", name: "Gemma 2 2B", maker: "Google",
              blurb: "The older generation, still a dependable everyday model.",
              gb: 1.49, config: LLMRegistry.gemma_2_2b_it_4bit),
        Entry(id: "gemma4-e2b", name: "Gemma 4 E2B", maker: "Google",
              blurb: "Google's newest, in the build they made for phones.",
              gb: 2.43, config: rxRepo("mlx-community/gemma-4-E2B-it-qat-mobile", stop: "<turn|>")),
        Entry(id: "gemma3n-e2b", name: "Gemma 3n E2B", maker: "Google",
              blurb: "Built for on-device use. Good general knowledge.",
              gb: 2.55, config: LLMRegistry.gemma3n_E2B_it_lm_4bit),
        Entry(id: "gemma3-4b", name: "Gemma 3 4B", maker: "Google",
              blurb: "Strong at long answers and summarizing.",
              gb: 3.03, config: rxRepo("mlx-community/gemma-3-4b-it-qat-4bit", stop: "<end_of_turn>")),
        Entry(id: "gemma4-e4b", name: "Gemma 4 E4B", maker: "Google",
              blurb: "Google's phone flagship, and one of the best here.",
              gb: 3.49, config: rxRepo("mlx-community/gemma-4-E4B-it-qat-mobile", stop: "<turn|>")),
        Entry(id: "gemma3n-e4b", name: "Gemma 3n E4B", maker: "Google",
              blurb: "The larger on-device Gemma. Wants room.",
              gb: 3.9, config: LLMRegistry.gemma3n_E4B_it_lm_4bit),
        Entry(id: "gemma2-9b", name: "Gemma 2 9B", maker: "Google",
              blurb: "Desktop-class. Only a 12 GB iPhone gets near it.",
              gb: 5.22, config: LLMRegistry.gemma_2_9b_it_4bit),

        // ---- Alibaba ----
        Entry(id: "qwen3-0.6b", name: "Qwen 3 0.6B", maker: "Alibaba",
              blurb: "Tiny and instant. Quick questions and rewriting.",
              gb: 0.35, config: LLMRegistry.qwen3_0_6b_4bit),
        Entry(id: "qwen2.5-1.5b", name: "Qwen 2.5 1.5B", maker: "Alibaba",
              blurb: "The proven older generation. Reliable, well understood.",
              gb: 0.88, config: LLMRegistry.qwen2_5_1_5b),
        Entry(id: "qwen3-1.7b", name: "Qwen 3 1.7B", maker: "Alibaba",
              blurb: "The best all-rounder on any recent iPhone.",
              gb: 0.98, config: LLMRegistry.qwen3_1_7b_4bit),
        // ── models that can SEE ────────────────────────────────────────────
        // ⚠️ SIZES MEASURED THE SAME WAY AS EVERY OTHER ROW — summed blobs from
        // huggingface.co/api/models/<id>?blobs=true, because the progress bar
        // divides by this number.
        Entry(id: "fastvlm-0.5b", name: "FastVLM 0.5B", maker: "Apple",
              blurb: "Apple's own. The quickest way to ask about a picture.",
              gb: 1.27, config: rxRepo("mlx-community/FastVLM-0.5B-bf16"), vision: true),
        Entry(id: "qwen2-vl-2b", name: "Qwen 2 VL 2B", maker: "Alibaba",
              blurb: "Reads screenshots, receipts and handwriting well for its size.",
              gb: 1.26, config: rxRepo("mlx-community/Qwen2-VL-2B-Instruct-4bit"), vision: true),
        Entry(id: "lfm2-vl-1.6b", name: "LFM2 VL 1.6B", maker: "Liquid AI",
              blurb: "Built for phones. Fast at describing what is in a photo.",
              gb: 1.47, config: rxRepo("mlx-community/LFM2-VL-1.6B-4bit"), vision: true),
        Entry(id: "qwen2.5-vl-3b", name: "Qwen 2.5 VL 3B", maker: "Alibaba",
              blurb: "The most capable of the picture models here. Good at charts and dense text.",
              gb: 3.09, config: rxRepo("mlx-community/Qwen2.5-VL-3B-Instruct-4bit"), vision: true),
        Entry(id: "smolvlm2-video", name: "SmolVLM2 Video 500M", maker: "Hugging Face",
              blurb: "Watches a short clip and tells you what happened in it.",
              gb: 1.02, config: rxRepo("HuggingFaceTB/SmolVLM2-500M-Video-Instruct-mlx"), vision: true, video: true),

        Entry(id: "qwen2.5-3b", name: "Qwen 2.5 3B", maker: "Alibaba",
              blurb: "More knowledge than the 1.5B, same steady behavior.",
              gb: 1.75, config: rxRepo("mlx-community/Qwen2.5-3B-Instruct-4bit")),
        Entry(id: "qwen3.5-2b", name: "Qwen 3.5 2B", maker: "Alibaba",
              blurb: "Newest generation. Sharper reasoning for its size.",
              gb: 1.75, config: LLMRegistry.qwen3_5_2b_4bit),
        Entry(id: "qwen3-4b", name: "Qwen 3 4B", maker: "Alibaba",
              blurb: "Noticeably smarter, and good at code.",
              gb: 2.28, config: rxRepo("mlx-community/Qwen3-4B-Instruct-2507-4bit")),
        Entry(id: "qwen3.5-4b", name: "Qwen 3.5 4B", maker: "Alibaba",
              blurb: "The most capable all-rounder that still fits a phone.",
              gb: 3.06, config: rxRepo("mlx-community/Qwen3.5-4B-MLX-4bit")),
        Entry(id: "qwen3-8b", name: "Qwen 3 8B", maker: "Alibaba",
              blurb: "Desktop-class reasoning. Needs a 12 GB iPhone.",
              gb: 4.62, config: LLMRegistry.qwen3_8b_4bit),

        // ---- Meta ----
        Entry(id: "llama3.2-1b", name: "Llama 3.2 1B", maker: "Meta",
              blurb: "Small and fast. Fine for short answers.",
              gb: 0.71, config: LLMRegistry.llama3_2_1B_4bit),
        Entry(id: "llama3.2-3b", name: "Llama 3.2 3B", maker: "Meta",
              blurb: "Strong at everyday writing and rewriting.",
              gb: 1.82, config: LLMRegistry.llama3_2_3B_4bit),
        Entry(id: "llama3.1-8b", name: "Llama 3.1 8B", maker: "Meta",
              blurb: "The full-size Llama. Only for the largest iPhones.",
              gb: 4.53, config: LLMRegistry.llama3_1_8B_4bit),

        // ---- Mistral ----
        Entry(id: "ministral3-3b", name: "Ministral 3 3B", maker: "Mistral",
              blurb: "Mistral's edge model. Fluent, and good in French.",
              gb: 2.78, config: rxRepo("mlx-community/Ministral-3-3B-Instruct-2512-4bit")),
        Entry(id: "mistral-7b", name: "Mistral 7B", maker: "Mistral",
              blurb: "The classic. Even-handed and hard to trip up.",
              gb: 4.08, config: LLMRegistry.mistral7B4bit),
        Entry(id: "mistral-nemo", name: "Mistral NeMo 12B", maker: "Mistral",
              blurb: "Large and multilingual. Past what any iPhone can hold.",
              gb: 6.91, config: LLMRegistry.mistralNeMo4bit),

        // ---- Microsoft ----
        Entry(id: "bitnet-2b", name: "BitNet b1.58 2B", maker: "Microsoft",
              blurb: "An experiment: barely over one bit per weight. Tiny for its size.",
              gb: 0.72, config: LLMRegistry.bitnet_b1_58_2b_4t_4bit),
        Entry(id: "phi3.5-mini", name: "Phi 3.5 mini", maker: "Microsoft",
              blurb: "Trained on textbook-style data. Careful and precise.",
              gb: 2.15, config: LLMRegistry.phi3_5_4bit),
        Entry(id: "phi4-mini", name: "Phi 4 mini", maker: "Microsoft",
              blurb: "Punches above its size at math and code.",
              gb: 2.18, config: rxRepo("mlx-community/Phi-4-mini-instruct-4bit", stop: "<|end|>")),

        // ---- IBM ----
        Entry(id: "granite4-micro", name: "Granite 4.0 Micro", maker: "IBM",
              blurb: "Built for work: summarizing, extraction, tool use.",
              gb: 1.81, config: rxRepo("mlx-community/granite-4.0-h-micro-4bit")),
        Entry(id: "granite4.1-3b", name: "Granite 4.1 3B", maker: "IBM",
              blurb: "IBM's newest small model. Business documents and data.",
              gb: 1.82, config: rxRepo("mlx-community/granite-4.1-3b-mxfp4")),
        Entry(id: "granite4-tiny", name: "Granite 4.0 Tiny", maker: "IBM",
              blurb: "The larger Granite. Long documents, if you have the room.",
              gb: 3.92, config: rxRepo("mlx-community/granite-4.0-h-tiny-4bit")),

        // ---- Liquid AI ----
        Entry(id: "lfm2-350m", name: "LFM2 350M", maker: "Liquid AI",
              blurb: "The lightest model here. Runs on anything, answers instantly.",
              gb: 0.2, config: rxRepo("mlx-community/LFM2-350M-4bit")),
        Entry(id: "lfm2.5-1.2b", name: "LFM2.5 1.2B", maker: "Liquid AI",
              blurb: "Designed for phones. Fastest of the genuinely capable ones.",
              gb: 0.66, config: rxRepo("mlx-community/LFM2.5-1.2B-Instruct-4bit")),
        Entry(id: "lfm2.5-2.6b", name: "LFM2.5 2.6B", maker: "Liquid AI",
              blurb: "Still quick, and noticeably more able.",
              gb: 1.45, config: rxRepo("mlx-community/LFM2.5-2.6B-mxfp4")),
        Entry(id: "lfm2-8b-a1b", name: "LFM2 8B A1B", maker: "Liquid AI",
              blurb: "Only part of it runs per word, so it is faster than its size.",
              gb: 4.18, config: LLMRegistry.lfm2_8b_a1b_3bit_mlx),

        // ---- DeepSeek ----
        Entry(id: "deepseek-r1-1.5b", name: "DeepSeek R1 1.5B", maker: "DeepSeek",
              blurb: "Thinks before it answers. Slower, better at problems.",
              gb: 1.01, config: rxRepo("mlx-community/DeepSeek-R1-Distill-Qwen-1.5B-4bit")),
        Entry(id: "deepseek-r1-7b", name: "DeepSeek R1 7B", maker: "DeepSeek",
              blurb: "The same reasoning, with far more knowledge behind it.",
              gb: 4.3, config: LLMRegistry.deepSeekR1_7B_4bit),

        // ---- Hugging Face ----
        Entry(id: "smollm2-360m", name: "SmolLM2 360M", maker: "Hugging Face",
              blurb: "Very small, and honest about it. Good for quick tasks.",
              gb: 0.73, config: rxRepo("mlx-community/SmolLM2-360M-Instruct")),
        Entry(id: "smollm3-3b", name: "SmolLM3 3B", maker: "Hugging Face",
              blurb: "Open training data end to end. Strong at chat.",
              gb: 1.75, config: LLMRegistry.smollm3_3b_4bit),

        // ---- NVIDIA ----
        Entry(id: "nemotron3-4b", name: "Nemotron 3 Nano 4B", maker: "NVIDIA",
              blurb: "Built for reasoning and calling tools.",
              gb: 2.25, config: rxRepo("mlx-community/NVIDIA-Nemotron-3-Nano-4B-4bit")),

        // ---- LG ----
        Entry(id: "exaone4-1.2b", name: "EXAONE 4.0 1.2B", maker: "LG",
              blurb: "Small, and unusually good at following instructions.",
              gb: 0.73, config: LLMRegistry.exaone_4_0_1_2b_4bit),

        // ---- Allen AI ----
        Entry(id: "olmo3-7b", name: "Olmo 3 7B", maker: "Allen AI",
              blurb: "Fully open: data, code, weights. A research favorite.",
              gb: 4.12, config: rxRepo("mlx-community/Olmo-3-7B-Instruct-4bit", stop: "<|im_end|>")),

        // ---- TII ----
        Entry(id: "falcon-h1-0.5b", name: "Falcon H1 0.5B", maker: "TII",
              blurb: "Tiny, with a long memory for its size.",
              gb: 0.3, config: rxRepo("mlx-community/Falcon-H1-0.5B-Instruct-4bit", stop: "<|im_end|>")),
        Entry(id: "falcon-h1-1.5b", name: "Falcon H1 1.5B", maker: "TII",
              blurb: "Handles long inputs better than most at this size.",
              gb: 0.88, config: rxRepo("mlx-community/Falcon-H1-1.5B-Instruct-4bit", stop: "<|im_end|>")),
        Entry(id: "falcon-h1-3b", name: "Falcon H1 3B", maker: "TII",
              blurb: "The largest Falcon that still suits a phone.",
              gb: 1.78, config: rxRepo("mlx-community/Falcon-H1-3B-Instruct-4bit", stop: "<|im_end|>")),

        // ---- OpenAI ----
        Entry(id: "gpt-oss-20b", name: "gpt-oss 20B", maker: "OpenAI",
              blurb: "OpenAI's open model. Listed so you can see the ceiling.",
              gb: 12.1, config: LLMRegistry.gpt_oss_20b_MXFP4_Q8)
    ]

    /// Print the real memory numbers at launch.
    ///
    /// ⚠️ KEEP THIS. It is how the "why won't this model run" question gets
    /// answered without guessing: launch with
    ///     xcrun devicectl device process launch --console --terminate-existing \
    ///         --device <udid> com.templetongroup.radiant
    /// and grep RADIANT-MEM. The Simulator cannot answer it — MLX will not even
    /// initialise there — so a physical device and this line are the only
    /// route. Measured on an iPhone 17 Pro Max, 2026-08-24:
    ///     physical=12.26GB  available-to-this-app=3.49GB
    /// which is 28% of the device, and is the whole reason a 3 GB model reports
    /// "won't run" on a 12 GB phone.
    override public func load() {
        // ⚠️ DEBUG ONLY. It prints no user data, but a Release build should not
        // narrate itself in the device console — and device installs are Debug
        // config, so the diagnostic survives exactly where it is used.
        #if DEBUG
        let p = ProcessInfo.processInfo
        NSLog("RADIANT-MEM physical=%.2fGB headroom-now=%.2fGB app-limit=%.2fGB",
              Double(p.physicalMemory) / 1e9,
              Double(os_proc_available_memory()) / 1e9,
              Double(rxMemoryLimit()) / 1e9)
        #endif
    }

    private var loaded: (id: String, container: ModelContainer)?
    private var task: Task<Void, Never>?

    // MARK: - catalog

    /// Is this model actually on the phone? MEASURED, not remembered.
    ///
    /// ⚠️ A UserDefaults flag lies in BOTH directions, and both have bitten:
    ///  · it said no while a 663 MB Llama sat in the cache, so Settings read
    ///    "Nothing downloaded yet" over a model the user had just downloaded;
    ///  · and it can say yes after iOS purges Caches under storage pressure —
    ///    which it is entitled to do, since that is where the weights live —
    ///    leaving the app offering a model that is no longer there.
    ///
    /// ⚠️ AND, NOT OR — both halves are load-bearing.
    ///
    /// A size threshold ALONE says yes to a download the user stopped: cancel
    /// deliberately leaves partial bytes so a restart can resume, and a stop at
    /// 60% then reads as a finished model — hero says "Ready on this iPhone",
    /// the row shows a tick, and tapping it opens a chat with weights that are
    /// not all there. That is the same defect as the flag, inverted: the flag
    /// lied about absence, a bare threshold lies about presence.
    ///
    /// So: the RECEIPT says the load once completed (written only after
    /// `#huggingFaceLoadModelContainer` returns), and the FILES say it is still
    /// there (iOS may purge Caches under storage pressure, which is where the
    /// weights live). Either one alone is a lie in one direction.
    private func isOnDisk(_ entry: Entry) -> Bool {
        DownloadMath.isPresent(
            hasReceipt: downloadedIds().contains(entry.id),
            bytesInCache: bytesInCache(for: entry.config.name),
            expected: Int64(entry.gb * 1_000_000_000)
        )
    }

    @objc func list(_ call: CAPPluginCall) {
        call.resolve(["models": catalog.map { [
            "id": $0.id, "name": $0.name, "maker": $0.maker, "blurb": $0.blurb,
            "sizeGB": $0.gb, "downloaded": isOnDisk($0),
            "vision": $0.vision, "video": $0.video
        ] }])
    }

    @objc func downloaded(_ call: CAPPluginCall) {
        call.resolve(["ids": catalog.filter { isOnDisk($0) }.map(\.id)])
    }

    /// Which models are on the device.
    ///
    /// Recorded here rather than probed from the Hugging Face cache: the
    /// downloader's on-disk layout is its own business and has already changed
    /// once (HubApi -> HubClient). A flag we set after a successful download is
    /// both simpler and harder to get wrong.
    private let key = "radiant.localModels.downloaded"
    private func downloadedIds() -> [String] {
        UserDefaults.standard.stringArray(forKey: key) ?? []
    }
    private func markDownloaded(_ id: String) {
        var ids = Set(downloadedIds()); ids.insert(id)
        UserDefaults.standard.set(Array(ids), forKey: key)
    }
    private func forget(_ id: String) {
        UserDefaults.standard.set(downloadedIds().filter { $0 != id }, forKey: key)
    }
    /// Where swift-huggingface ACTUALLY puts model files on iOS.
    ///
    /// ⚠️ MEASURED ON A DEVICE, NOT ASSUMED. This used to return
    /// `Documents/huggingface/models/<org>/<name>`, which is wrong twice over,
    /// and listing a real phone's container settled it:
    ///
    ///   Library/Caches/huggingface/hub/models--mlx-community--Llama-3.2-1B-Instruct-4bit/blobs/…
    ///
    /// Caches, not Documents — and HuggingFace's own folder convention, where
    /// the repo id is prefixed with `models--` and every slash becomes `--`.
    ///
    /// The cost of getting this wrong was two invisible bugs: the download
    /// progress poller measured an empty directory and so reported nothing at
    /// all (three "fixes" chased that symptom elsewhere), and `remove` deleted a
    /// path that never existed, so freeing space silently freed none.
    ///
    /// It also means the weights live in Caches, which iOS may purge under
    /// storage pressure. That is survivable — the app re-downloads — but it is
    /// the loader's choice, not ours.
    private func cacheDir(for repo: String) -> URL? {
        let folder = DownloadMath.cacheFolderName(for: repo)
        return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("huggingface/hub/\(folder)")
    }

    /// Bytes currently on disk for a model. Walking the directory is cheap next
    /// to a multi-gigabyte download, and unlike a progress callback it cannot
    /// fail to fire.
    private func size(of dir: URL) -> Int64 {
        let fm = FileManager.default
        guard let en = fm.enumerator(at: dir, includingPropertiesForKeys: [.fileSizeKey],
                                     options: [.skipsHiddenFiles]) else { return 0 }
        var total: Int64 = 0
        for case let url as URL in en {
            let sz = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            total += Int64(sz)
        }
        return total
    }

    /// Bytes landed for a model — INCLUDING the one still in flight.
    ///
    /// ⚠️ THE BIG FILE IS NOT IN THE CACHE DIRECTORY WHILE IT DOWNLOADS.
    /// swift-huggingface fetches each blob with `URLSession.download(for:delegate:)`,
    /// which writes to a temporary file and only moves it into `blobs/` on
    /// completion (HubClient+Files.swift, "Download or resume into incomplete
    /// blob until success"). So watching only the cache directory shows the few
    /// small config files land — about 2% of a Llama — then nothing at all for
    /// the entire 663 MB, then everything at once. Which is exactly what Tony
    /// saw: "went to 2% stayed there whole time and then went to 100%".
    ///
    /// The app's own tmp/ is where that in-flight file lives, and it is
    /// otherwise empty in this app, so its size IS the current transfer.
    private func bytesInCache(for repo: String) -> Int64 {
        guard let dir = cacheDir(for: repo) else { return 0 }
        return size(of: dir)
    }

    private func bytesInFlight() -> Int64 {
        size(of: FileManager.default.temporaryDirectory)
    }

    private func bytesOnDisk(for repo: String) -> Int64 {
        bytesInCache(for: repo) + bytesInFlight()
    }

    // MARK: - download

    /// Running downloads, so they can be cancelled. Capacitor calls plugin
    /// methods off the main thread, and cancelDownload can land while the job
    /// is clearing its own entry — hence the lock rather than a bare dictionary.
    private let jobLock = NSLock()
    private var jobs: [String: Task<Void, Never>] = [:]

    private func setJob(_ id: String, _ task: Task<Void, Never>?) {
        jobLock.lock(); defer { jobLock.unlock() }
        jobs[id] = task
    }
    private func job(_ id: String) -> Task<Void, Never>? {
        jobLock.lock(); defer { jobLock.unlock() }
        return jobs[id]
    }

    @objc func download(_ call: CAPPluginCall) {
        guard let entry = catalog.first(where: { $0.id == call.getString("id") }) else {
            return call.reject("Unknown model")
        }
        let id = entry.id
        // A second tap must not start a second download of the same weights.
        if job(id) != nil { return call.resolve(["id": id, "alreadyRunning": true]) }
        let task = Task {
            // The progress overload's handler is @Sendable, so it cannot touch
            // the plugin — that is what blocked real percentages. It can hold an
            // AsyncStream continuation, which IS Sendable, so the continuation
            // becomes the relay: the handler yields fractions from whatever
            // thread the download is on, and the pump below — which does have
            // self — turns them into plugin events.
            // Carry BYTES as well as the fraction. `Progress.fractionCompleted`
            // sits at 0 for the whole transfer whenever the total size is not
            // known up front, which is exactly what happens pulling a repo of
            // shards — so a relay that only forwarded the fraction emitted
            // nothing at all, and the phone showed a bare "Downloading…" for
            // 2.3 GB. Bytes are always real, so the UI always has something
            // true to print.
            let (ticks, feed) = AsyncStream<(Double, Int64, Int64)>.makeStream(
                bufferingPolicy: .bufferingNewest(1)
            )
            // A multi-gigabyte download reports constantly. Throttle to a whole
            // percent, or — when there is no percent to be had — to each new
            // megabyte, so the number on screen still moves.
            let pump = Task { [weak self] in
                var lastPct = -1
                var lastMB: Int64 = -1
                for await (f, done, total) in ticks {
                    let pct = total > 0 ? Int(f * 100) : -1
                    let mb = done / 1_000_000
                    if pct >= 0 {
                        guard pct != lastPct else { continue }
                        lastPct = pct
                    } else {
                        guard mb != lastMB else { continue }
                        lastMB = mb
                    }
                    self?.notifyListeners("downloadProgress", data: [
                        "id": id,
                        "progress": total > 0 ? f : -1,
                        "completedBytes": done,
                        "totalBytes": total
                    ])
                }
            }

            // ⚠️ THE CALLBACK CANNOT BE TRUSTED TO FIRE.
            // Shipped twice on the belief that it would: first reading only
            // `fractionCompleted`, then adding byte counts. On a real device
            // neither produced a single event — `downloadStarted` arrived and
            // then nothing, so the phone read "Downloading…" for gigabytes.
            //
            // So progress is MEASURED instead of reported: poll the bytes that
            // have actually landed in the HuggingFace cache, against the
            // catalog's own size for this model. It cannot silently do nothing,
            // it survives the loader changing its progress plumbing, and it is
            // the number the user actually cares about.
            let expected = Int64(entry.gb * 1_000_000_000)
            let repo = entry.config.name
            // ⚠️ MEASURE THE DELTA, NOT THE TOTAL. Whatever is already cached
            // counts toward the folder's size, so a model that is partly — or
            // entirely — present made the very first tick read 100% and stay
            // there. Tony: "now downloading llama starts at 100% and doesnt
            // change." Progress is what THIS download adds, from here.
            // ⚠️ TWO BASELINES, because the two places bytes live are not the
            // same kind of thing. The cache holds what is already downloaded;
            // tmp holds the file currently in flight AND, crucially, whatever a
            // previous download left behind. Folding both into one baseline let
            // stale tmp leftovers inflate it past the expected size, which made
            // `remaining` zero, which broke out of the poller before it emitted
            // anything — no number at all, which is what Tony saw. Count only
            // what GROWS from here, on each independently.
            let start = DownloadMath.Sizes(
                cache: bytesInCache(for: repo),
                inFlight: bytesInFlight()
            )
            let poller = Task { [weak self] in
                var lastPct = -1
                var lastMB: Int64 = -1
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 500_000_000)
                    if Task.isCancelled { break }
                    guard let self else { break }
                    let now = DownloadMath.Sizes(
                        cache: self.bytesInCache(for: repo),
                        inFlight: self.bytesInFlight()
                    )
                    // ⚠️ The arithmetic lives in DownloadMath and is covered by
                    // scripts/test-download-math.sh. It broke four times in
                    // production while it lived inline here, because nothing
                    // could run it without a device. Change it THERE, with a
                    // test, not here.
                    guard let f = DownloadMath.fraction(expected: expected, start: start, now: now)
                    else { continue }
                    let done = now.cache + now.inFlight
                    var mb: Int64 = lastMB
                    guard DownloadMath.shouldEmit(fraction: f, bytes: done,
                                                  lastPercent: &lastPct, lastMegabytes: &mb)
                    else { continue }
                    lastMB = mb
                    self.notifyListeners("downloadProgress", data: [
                        "id": id, "progress": f,
                        "completedBytes": done, "totalBytes": expected
                    ])
                }
            }
            do {
                self.notifyListeners("downloadStarted", data: ["id": id])
                _ = try await #huggingFaceLoadModelContainer(
                    configuration: entry.config
                ) { progress in
                    feed.yield((
                        progress.fractionCompleted,
                        progress.completedUnitCount,
                        progress.totalUnitCount
                    ))
                }
                feed.finish()
                poller.cancel()
                await pump.value
                self.setJob(id, nil)
                self.markDownloaded(id)
                self.notifyListeners("downloadDone", data: ["id": id])
                call.resolve(["id": id])
            } catch {
                feed.finish()
                poller.cancel()
                await pump.value
                self.setJob(id, nil)
                // A download the user stopped is not a failure, and must never
                // surface as a red error. URLSession surfaces cancellation as
                // CancellationError from the async API and as URLError.cancelled
                // from the older path, so both count.
                let cancelled = error is CancellationError
                    || (error as? URLError)?.code == .cancelled
                    || Task.isCancelled
                if cancelled {
                    self.notifyListeners("downloadCancelled", data: ["id": id])
                    call.resolve(["id": id, "cancelled": true])
                } else {
                    self.notifyListeners("downloadFailed", data: [
                        "id": id, "message": error.localizedDescription
                    ])
                    call.reject("Download failed: \(error.localizedDescription)")
                }
            }
        }
        setJob(id, task)
    }

    /// Stop a running download. Cancellation propagates through the Swift Task
    /// into swift-huggingface's URLSession calls, so this really does stop the
    /// transfer rather than only hiding the UI.
    ///
    /// Whatever bytes already landed stay in the HuggingFace cache — starting
    /// the same model again picks up from there rather than from zero. Removing
    /// them here would turn "I tapped that by mistake" into "and now do the
    /// whole 2.3 GB again."
    @objc func cancelDownload(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            return call.reject("Missing id")
        }
        guard let running = job(id) else {
            // Already finished or never started. Not an error — the UI may have
            // been a frame behind the download.
            return call.resolve(["id": id, "running": false])
        }
        running.cancel()
        call.resolve(["id": id, "running": true])
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let entry = catalog.first(where: { $0.id == call.getString("id") }) else {
            return call.reject("Unknown model")
        }
        if loaded?.id == entry.id { loaded = nil }
        if let dir = cacheDir(for: entry.config.name) {
            try? FileManager.default.removeItem(at: dir)
        }
        forget(entry.id)
        call.resolve()
    }

    // MARK: - generation

    @objc func generate(_ call: CAPPluginCall) {
        guard let entry = catalog.first(where: { $0.id == call.getString("id") }) else {
            return call.reject("Unknown model")
        }
        let prompt = call.getString("prompt") ?? ""
        // ⚠️ THE PICTURE ARRIVES AS BASE64 AND MUST NOT REACH A TEXT MODEL. A
        // model without a vision tower handed images: [] behaves; handed a real
        // one it either throws or quietly ignores it, and "quietly ignores" is
        // the worse of the two — the user gets a confident answer about a photo
        // nothing ever looked at.
        var images: [UserInput.Image] = []
        if entry.vision, let b64 = call.getString("imageB64"), !b64.isEmpty,
           let data = Data(base64Encoded: b64), let ci = CIImage(data: data) {
            images = [.ciImage(ci)]
        }
        task?.cancel()
        task = Task {
            do {
                let container: ModelContainer
                if let l = loaded, l.id == entry.id {
                    container = l.container
                } else {
                    // loading evicts the previous model: two multi-GB models
                    // will not fit in a phone's memory at once
                    loaded = nil
                    container = try await #huggingFaceLoadModelContainer(configuration: entry.config)
                    loaded = (entry.id, container)
                }
                let session = ChatSession(container)
                for try await chunk in session.streamResponse(to: prompt, images: images) {
                    if Task.isCancelled { break }
                    self.notifyListeners("token", data: ["id": entry.id, "text": chunk])
                }
                self.notifyListeners("done", data: ["id": entry.id])
                call.resolve()
            } catch {
                self.notifyListeners("failed", data: ["message": error.localizedDescription])
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        task?.cancel(); task = nil
        call.resolve()
    }

    // MARK: - storage

    /// Free and total bytes on the device, for the storage line on the root
    /// screen ("2.5 GB of 128 GB used by models").
    ///
    /// ⚠️ This lives here rather than coming from @capacitor/device on purpose.
    /// Adding that plugin means `npx cap sync ios`, and sync rewrites
    /// CapApp-SPM/Package.swift — which is where the MLX dependencies this app
    /// cannot run without are hand-added. Trading a working inference stack for
    /// two numbers Foundation already has is not a trade worth making.
    ///
    /// volumeAvailableCapacityForImportantUsage is the figure Settings shows,
    /// which is the whole point: a number the user can go and check.
    /// What this iPhone is, for the panel above the model list.
    ///
    /// ⚠️ iOS DOES NOT TELL YOU THE PHONE'S NAME. `UIDevice.current.model` says
    /// "iPhone" and nothing more; the only identity available is the kernel's
    /// machine string ("iPhone18,2"), which is right but unreadable. The map
    /// below is the only way to say "iPhone 17 Pro Max", and it therefore GOES
    /// STALE — a phone released after this build falls through to plain
    /// "iPhone", which is honest and readable. It must never guess: showing the
    /// wrong phone name is worse than showing a generic one, so unknown
    /// identifiers are not pattern-matched into a family.
    ///
    /// Everything else here is measured, not mapped.
    @objc func deviceInfo(_ call: CAPPluginCall) {
        var sys = utsname()
        uname(&sys)
        let machine = withUnsafePointer(to: &sys.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(validatingUTF8: $0) ?? "" }
        }
        let p = ProcessInfo.processInfo
        call.resolve([
            "name": Self.marketingNames[machine] ?? "iPhone",
            "identifier": machine,
            "cores": p.activeProcessorCount,
            "osVersion": UIDevice.current.systemVersion,
            "ramTotal": Double(p.physicalMemory),
            "ramAvailable": Double(rxMemoryLimit())
        ])
    }

    /// Machine identifier -> the name on the box. Incomplete on purpose: only
    /// phones that can plausibly run a model are listed, and anything missing
    /// falls back to "iPhone" rather than being guessed at.
    private static let marketingNames: [String: String] = [
        "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12",
        "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
        "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13",
        "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max",
        "iPhone14,6": "iPhone SE (3rd generation)",
        "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
        "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max",
        "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus",
        "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
        "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus",
        "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max",
        "iPhone17,5": "iPhone 16e",
        "iPhone18,3": "iPhone 17", "iPhone18,4": "iPhone 17 Plus",
        "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max",
        "iPhone18,5": "iPhone Air",
        "arm64": "Simulator", "x86_64": "Simulator"
    ]

    /// Disk AND memory, because "will this model run" is two different questions.
    ///
    /// ⚠️ `physicalMemory` IS THE WRONG NUMBER TO PLAN AGAINST, and it is the
    /// obvious one to reach for. iOS never lets one app have the whole device:
    /// it kills an app that crosses a per-process limit well below the RAM in
    /// the spec sheet. On a 12 GB iPhone an app may get roughly half. Sizing a
    /// model against 12 GB would promise the user a load that jetsam ends —
    /// which does not look like a memory limit, it looks like Radiant crashing.
    ///
    /// `os_proc_available_memory()` is the number that matters: the bytes THIS
    /// process may still allocate before it is killed. It already accounts for
    /// what the app is holding, so it is a live figure rather than a constant —
    /// which is why the fit labels are computed on the phone, at the moment the
    /// list is drawn, and not baked into the catalogue.
    @objc func diskInfo(_ call: CAPPluginCall) {
        let url = URL(fileURLWithPath: NSHomeDirectory())
        do {
            let v = try url.resourceValues(forKeys: [
                .volumeTotalCapacityKey,
                .volumeAvailableCapacityForImportantUsageKey
            ])
            let total = v.volumeTotalCapacity.map(Double.init) ?? 0
            let free = v.volumeAvailableCapacityForImportantUsage.map(Double.init) ?? 0
            call.resolve([
                "total": total,
                "free": free,
                "ramTotal": Double(ProcessInfo.processInfo.physicalMemory),
                "ramAvailable": Double(rxMemoryLimit())
            ])
        } catch {
            call.reject(error.localizedDescription)
        }
    }
}
