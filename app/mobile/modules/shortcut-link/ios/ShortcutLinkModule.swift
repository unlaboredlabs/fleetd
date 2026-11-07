// Where a Shortcuts action opens the app (plugins/app-intents: Open Chat, Open Approvals). iOS opens no app's own
// scheme for an App Intent (OpenURLIntent takes web links only), and a link sent before React Native listens is lost on
// a cold start, so the action, run in the app's process, leaves its link in the app's defaults and says so; JS takes it
// at start and at each new one (App.tsx), and src/shortcutLink.ts reads it.
import ExpoModulesCore
import Foundation

public final class ShortcutLinkModule: Module {
  /// Intents.swift's Opened writes these; the app target can't import this module.
  static let key = "fleetd.shortcuts.opened"
  static let left = Notification.Name("fleetd.shortcuts.opened")

  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("FleetdShortcutLink")
    Events("onOpened")

    /// The link left, once: nil when there's none.
    Function("take") { () -> String? in
      let defaults = UserDefaults.standard
      let link = defaults.string(forKey: Self.key)
      defaults.removeObject(forKey: Self.key)
      return link
    }

    OnStartObserving {
      self.observer = NotificationCenter.default.addObserver(forName: Self.left, object: nil, queue: .main) { [weak self] _ in
        self?.sendEvent("onOpened")
      }
    }

    OnStopObserving {
      if let observer = self.observer { NotificationCenter.default.removeObserver(observer) }
      self.observer = nil
    }
  }
}
