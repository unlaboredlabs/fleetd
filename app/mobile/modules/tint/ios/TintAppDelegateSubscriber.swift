// The app's accent (src/theme.ts) as iOS's tint color, so what UIKit draws itself takes it rather than system blue: an
// alert's buttons, a menu's check marks, a prominent bar button. React Native's text fields don't inherit it (they
// keep the blue they were made with), so each sets selectionColor. Near-black in light and near-white in dark, as the
// theme's accent, and black or white with Increase Contrast on.
import ExpoModulesCore
import UIKit

public final class TintAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  static let accent = UIColor { traits in
    let strong = traits.accessibilityContrast == .high
    if traits.userInterfaceStyle == .dark { return strong ? .white : UIColor(red: 0xF5 / 255, green: 0xF5 / 255, blue: 0xF7 / 255, alpha: 1) }
    return strong ? .black : UIColor(red: 0x1D / 255, green: 0x1D / 255, blue: 0x1F / 255, alpha: 1)
  }

  private var shown: NSObjectProtocol?

  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    // The app's window comes later, from its scene, and an alert brings its own: each takes the tint as it shows. The
    // keyboard's windows keep theirs.
    shown = NotificationCenter.default.addObserver(forName: UIWindow.didBecomeVisibleNotification, object: nil, queue: .main) { note in
      guard let window = note.object as? UIWindow else { return }
      let kind = NSStringFromClass(type(of: window))
      if kind.contains("Keyboard") || kind.contains("TextEffects") { return }
      window.tintColor = Self.accent
    }
    return true
  }
}
