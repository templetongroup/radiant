// Radiant desktop control helper — CGEvent-based mouse/keyboard/scroll.
// Coordinates are in global display POINTS (top-left origin), matching the
// logical screen size reported by `screensize`. Screenshots are captured by
// the caller via `screencapture` and normalized to that same point space.
//
// Build: swiftc -O native/RadiantControl.swift -o native/radiant-control
// Requires Accessibility permission at runtime to actually deliver events.

import Foundation
import CoreGraphics
import AppKit
import AVFoundation
import Speech

let args = CommandLine.arguments
func d(_ i: Int) -> Double { i < args.count ? (Double(args[i]) ?? 0) : 0 }
func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }
let src = CGEventSource(stateID: .combinedSessionState)

func mouseEvent(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton, clicks: Int64 = 1) {
    guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
    if clicks > 1 { e.setIntegerValueField(.mouseEventClickState, value: clicks) }
    e.post(tap: .cghidEventTap)
}

// name -> virtual keycode for keys that aren't plain characters
let KEYCODES: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32,
    "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29
]

func flagsFor(_ mods: [String]) -> CGEventFlags {
    var f = CGEventFlags()
    for m in mods {
        switch m {
        case "cmd", "command", "meta": f.insert(.maskCommand)
        case "shift": f.insert(.maskShift)
        case "alt", "option", "opt": f.insert(.maskAlternate)
        case "ctrl", "control": f.insert(.maskControl)
        default: break
        }
    }
    return f
}

guard args.count >= 2 else { print("usage: radiant-control <cmd> ..."); exit(1) }

switch args[1] {
// ⚠️ ASK macOS, DO NOT ASSUME. computerStatus() reported desktop control as
// "granted — ready to use" on the strength of this binary EXISTING on disk. It
// never asked about permissions at all, so the Settings screen said everything was
// fine while screencapture returned a wallpaper-only image and CGEvents went
// nowhere. Tony spent a session on that: "the agent is saying it cant control my
// active chrome because of settings but Radiant has access in privacy and disk
// access" — and an agent, told the same lie, invented tccutil commands for a bundle
// id that does not exist.
//
// CGPreflightScreenCaptureAccess and AXIsProcessTrusted are the real answers. Both
// are read-only: neither shows a prompt, so this is safe to call on every status
// poll. TCC attributes a bundled, co-signed helper to the app that spawned it, so
// these report Radiant's own grants rather than the helper's.
case "permissions":
    let screen = CGPreflightScreenCaptureAccess()
    let ax = AXIsProcessTrusted()
    print("{\"screenRecording\":\(screen),\"accessibility\":\(ax)}")

// ⚠️ DICTATION IS ON-DEVICE, AND THAT IS NOT THE DEFAULT. requiresOnDeviceRecognition
// defaults to false, which ships your microphone audio to Apple's servers for
// transcription. For a coding harness that is unacceptable — you dictate file paths,
// client names and half-formed ideas about unreleased work. supportsOnDeviceRecognition
// was probed true on this machine before any of this was written; if a locale ever
// reports false we refuse rather than quietly going online.
//
// Output is one JSON object per line on stdout, flushed immediately: ready, partial,
// final, error. The caller stops it by closing stdin or sending SIGTERM — there is no
// "stop" command, because a hung helper holding the microphone open is worse than a
// helper that dies with its parent.
case "dictate":
    let localeId = args.count > 2 ? args[2] : "en-US"

    func emit(_ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj),
              let line = String(data: d, encoding: .utf8) else { return }
        print(line)
        fflush(stdout)
    }
    func die(_ code: String, _ message: String) -> Never {
        emit(["type": "error", "code": code, "message": message])
        exit(1)
    }

    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
        die("no-recognizer", "Speech recognition is not available for \(localeId) on this Mac.")
    }
    guard recognizer.supportsOnDeviceRecognition else {
        die("not-on-device", "\(localeId) has no on-device speech model, and Radiant will not send your audio to Apple. Add the language under System Settings › Keyboard › Dictation.")
    }

    // Both prompts, resolved before a single sample is captured. Asking for the
    // microphone only when the audio engine starts produces a recogniser that is
    // authorised and an engine that is silent, which looks like a broken feature.
    // ⚠️ WAIT WITH A DEADLINE. requestAuthorization's callback simply never arrives
    // when nothing can present the prompt — spawned from a shell, this helper sat on
    // sem.wait() forever holding a pipe the caller was reading. A dictate button that
    // hangs is worse than one that says why it cannot start.
    let sem = DispatchSemaphore(value: 0)
    func waited(_ what: String) {
        if sem.wait(timeout: .now() + 25) == .timedOut {
            die("no-prompt", "macOS never answered the request for \(what). Open Radiant, try again, and allow it when asked.")
        }
    }
    var speechOK = false
    SFSpeechRecognizer.requestAuthorization { st in speechOK = (st == .authorized); sem.signal() }
    waited("Speech Recognition")
    if !speechOK {
        die("speech-denied", "Speech Recognition is off for Radiant. Turn it on in System Settings › Privacy & Security › Speech Recognition.")
    }
    var micOK = false
    AVCaptureDevice.requestAccess(for: .audio) { granted in micOK = granted; sem.signal() }
    waited("the microphone")
    if !micOK {
        die("mic-denied", "The microphone is off for Radiant. Turn it on in System Settings › Privacy & Security › Microphone.")
    }

    let engine = AVAudioEngine()
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = true

    var task: SFSpeechRecognitionTask?
    task = recognizer.recognitionTask(with: request) { result, error in
        if let r = result {
            // ⚠️ formattedString IS THE WHOLE UTTERANCE SO FAR, not the newest words.
            // Appending these would spell "hello hello there hello there world". The
            // caller replaces the current segment with it; see src/dictation.js.
            emit(["type": r.isFinal ? "final" : "partial", "text": r.bestTranscription.formattedString])
        }
        if error != nil || (result?.isFinal ?? false) {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
            if let e = error as NSError?, e.domain != "kLSRErrorDomain", e.code != 301, e.code != 216 {
                emit(["type": "error", "code": "recognition", "message": e.localizedDescription])
            }
            emit(["type": "stopped"])
            exit(0)
        }
    }

    let input = engine.inputNode
    // The tap format must be the hardware's own. Asking for a different one throws
    // an uncatchable ObjC exception at installTap.
    input.installTap(onBus: 0, bufferSize: 1024, format: input.inputFormat(forBus: 0)) { buf, _ in
        request.append(buf)
    }
    engine.prepare()
    do { try engine.start() } catch {
        die("audio-start", "Could not start the microphone: \(error.localizedDescription)")
    }
    emit(["type": "ready", "locale": localeId, "onDevice": true])

    // Closing stdin is the stop signal: it is delivered even if the parent is killed,
    // which SIGTERM is not.
    DispatchQueue.global().async {
        var b = [UInt8](repeating: 0, count: 256)
        while read(0, &b, 256) > 0 { }
        request.endAudio()
        task?.finish()
    }
    signal(SIGTERM) { _ in exit(0) }
    RunLoop.main.run()

case "screensize":
    let b = CGDisplayBounds(CGMainDisplayID())
    print("\(Int(b.width)) \(Int(b.height))")

case "move":
    mouseEvent(.mouseMoved, CGPoint(x: d(2), y: d(3)), .left)

case "click", "doubleclick", "rightclick":
    let p = CGPoint(x: d(2), y: d(3))
    let right = args[1] == "rightclick"
    let button: CGMouseButton = right ? .right : .left
    let downT: CGEventType = right ? .rightMouseDown : .leftMouseDown
    let upT: CGEventType = right ? .rightMouseUp : .leftMouseUp
    mouseEvent(.mouseMoved, p, .left)
    let clicks: Int64 = args[1] == "doubleclick" ? 2 : 1
    for i in 1...Int(clicks) {
        mouseEvent(downT, p, button, clicks: Int64(i))
        mouseEvent(upT, p, button, clicks: Int64(i))
    }

case "drag":
    let a = CGPoint(x: d(2), y: d(3)), b = CGPoint(x: d(4), y: d(5))
    mouseEvent(.mouseMoved, a, .left)
    mouseEvent(.leftMouseDown, a, .left)
    // a few intermediate moves so drag registers smoothly
    for t in stride(from: 0.0, through: 1.0, by: 0.2) {
        let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
        mouseEvent(.leftMouseDragged, p, .left)
    }
    mouseEvent(.leftMouseUp, b, .left)

case "scroll":
    // scroll dy (positive = up) at optional point
    let dy = Int32(d(4))
    if let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0) {
        e.post(tap: .cghidEventTap)
    }

case "type":
    let text = args.count > 2 ? args[2] : ""
    var utf16 = Array(text.utf16)
    if let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) {
        down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        down.post(tap: .cghidEventTap)
    }
    if let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) {
        up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        up.post(tap: .cghidEventTap)
    }

case "key":
    // e.g. "cmd+c", "shift+tab", "return"
    let spec = (args.count > 2 ? args[2] : "").lowercased()
    let parts = spec.split(separator: "+").map(String.init)
    guard let keyName = parts.last, let code = KEYCODES[keyName] else {
        FileHandle.standardError.write("unknown key: \(spec)\n".data(using: .utf8)!); exit(1)
    }
    let flags = flagsFor(Array(parts.dropLast()))
    if let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true) {
        down.flags = flags; down.post(tap: .cghidEventTap)
    }
    if let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) {
        up.flags = flags; up.post(tap: .cghidEventTap)
    }

// ⚠️ A FOLDER AT THE iCLOUD PATH IS NOT NECESSARILY IN iCLOUD.
//
// If iCloud Drive is off, or signed into a different Apple ID, the CloudDocs
// path can still exist as an ordinary local directory. Radiant would mkdir its
// hierarchy inside it and write there happily forever, syncing to nobody, while
// the checkbox said "Keep my setup in iCloud Drive". That is what happened to
// Tony's dev Mac: the same setup worked on two other Macs and that one stayed
// empty through reboots and reinstalls.
//
// Foundation is the only thing that can answer this. Counting `.icloud`
// sidecars does not work on current macOS — modern placeholders are File
// Provider entries — and brctl is a diagnostic tool, not something to ship.
// Reports one line of key=value so the Node side can parse it without a JSON
// dependency, and never exits non-zero for a plain "no": the caller needs the
// answer, not an error.
case "ubiquity":
    guard args.count >= 3 else { print("usage: radiant-control ubiquity <path>"); exit(1) }
    let u = URL(fileURLWithPath: args[2])
    guard FileManager.default.fileExists(atPath: args[2]) else {
        print("exists=false"); exit(0)
    }
    do {
        let v = try u.resourceValues(forKeys: [
            .isUbiquitousItemKey,
            .ubiquitousItemIsUploadedKey,
            .ubiquitousItemIsUploadingKey,
            .ubiquitousItemUploadingErrorKey,
            .ubiquitousItemDownloadingStatusKey,
            .ubiquitousItemIsExcludedFromSyncKey
        ])
        let err = v.ubiquitousItemUploadingError
        var status = "unknown"
        if let ds = v.ubiquitousItemDownloadingStatus { status = ds.rawValue }
        print([
            "exists=true",
            "ubiquitous=\(v.isUbiquitousItem ?? false)",
            "uploaded=\(v.ubiquitousItemIsUploaded ?? false)",
            "uploading=\(v.ubiquitousItemIsUploading ?? false)",
            "excluded=\(v.ubiquitousItemIsExcludedFromSync ?? false)",
            "download=\(status)",
            "error=\(err == nil ? "none" : "yes")"
        ].joined(separator: " "))
    } catch {
        print("exists=true ubiquitous=false uploaded=false uploading=false excluded=false download=unknown error=none")
    }

// ⚠️ IS iCLOUD AVAILABLE AT ALL? Asking whether the CloudDocs *root* is a
// ubiquitous item was a proxy, and it was wrong on Tony's dev Mac: System
// Settings plainly showed iCloud Drive → "Sync this Mac" ON while Radiant
// announced it was switched off. ubiquityIdentityToken is the documented answer
// — non-nil when iCloud is signed in and available to this process.
case "icloud":
    let fm = FileManager.default
    print("available=\(fm.ubiquityIdentityToken != nil)")

// Ask iCloud to fetch a placeholder. The supported call, not `brctl download`.
case "fetch":
    guard args.count >= 3 else { print("usage: radiant-control fetch <path>"); exit(1) }
    do {
        try FileManager.default.startDownloadingUbiquitousItem(at: URL(fileURLWithPath: args[2]))
        print("requested")
    } catch { print("failed: \(error.localizedDescription)") }

default:
    print("unknown command: \(args[1])"); exit(1)
}
