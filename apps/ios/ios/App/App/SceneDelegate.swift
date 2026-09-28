import UIKit
import SwiftUI

// ⚠️ WITHOUT A SCENE DELEGATE THE APP DIES AT LAUNCH ON iOS 27. Build 23
// (2026-09-18), the first compiled against the iOS 27 SDK, trapped before the
// first frame in UIKit's __UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption.
//
// Since build 42 the window's root is the native app itself (Launch.swift).
// There is no storyboard and no web view: the old web design is gone.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        self.window = window
        if let raw = DiskStore.load(), raw[DiskStore.importedKey] == "1" {
            window.rootViewController = Launch.root(window: window, raw: raw)
        } else {
            // First launch of a native-only build: copy the old store, then open.
            window.rootViewController = UIHostingController(rootView: LaunchCover())
            Task { @MainActor in
                let raw = await Launch.store()
                window.rootViewController = Launch.root(window: window, raw: raw)
            }
        }
        window.makeKeyAndVisible()
    }

    func sceneDidEnterBackground(_ scene: UIScene) { DiskStore.flush() }
}
