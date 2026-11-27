// Where the iPhone Duo's fold runs across the app's window, from iOS itself (iOS 27.1's division region: the reserved
// region where content should divide in two), so src/split.ts puts the list on one side of it and the chat on the
// other rather than the crease through the chat. A hidden view in the window watches it: its layout runs with every
// change of the window's size (a pose, a rotation, a split with another app) and its UIHingeInteraction with every
// move of the hinge. JS reads it once (`fold`) and on each change (`onFold`); null where nothing divides the window.
import ExpoModulesCore
import UIKit

public final class HingeModule: Module {
  private var watcher: HingeWatchView?

  public func definition() -> ModuleDefinition {
    Name("FleetdHinge")
    Events("onFold")

    /// The fold as it is now, in the window's points: { x, width }, or null.
    AsyncFunction("fold") { () -> [String: Double]? in
      Self.division(in: Self.window())
    }.runOnQueue(.main)

    OnStartObserving {
      DispatchQueue.main.async {
        guard self.watcher == nil, let window = Self.window() else { return }
        let view = HingeWatchView { [weak self] fold in self?.sendEvent("onFold", ["fold": fold as Any]) }
        view.frame = window.bounds
        window.insertSubview(view, at: 0)
        self.watcher = view
      }
    }

    OnStopObserving {
      DispatchQueue.main.async {
        self.watcher?.removeFromSuperview()
        self.watcher = nil
      }
    }
  }

  static func window() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.lazy.compactMap { $0.keyWindow }.first ?? scenes.first?.windows.first
  }

  /// The window's division region, the fold, where one runs across it from top to bottom. An active one first; else
  /// one iOS holds inactive: launched on the Duo lying open, iOS has its frame but marks it active only once the hinge
  /// has moved (measured on the simulator: 455.5 pt in, 40 wide, inactive, until a pose change).
  static func division(in window: UIWindow?) -> [String: Double]? {
    guard #available(iOS 27.1, *), let window else { return nil }
    let bounds = window.bounds
    let regions = window.reservedRegions(kind: .division, options: .includeInactive)
    for region in regions.filter(\.isActive) + regions.filter({ !$0.isActive }) {
      let frame = region.frame.intersection(bounds)
      // Only a fold down the window's height splits it into a left and a right.
      guard !frame.isNull, frame.height >= bounds.height - 1, frame.width < bounds.width / 2 else { continue }
      return ["x": Double(frame.minX), "width": Double(frame.width)]
    }
    return nil
  }
}

/** Sees the window's size and the hinge change, and says where the fold now is when it moved. */
final class HingeWatchView: UIView {
  private let changed: ([String: Double]?) -> Void
  private var last: [String: Double]??

  init(changed: @escaping ([String: Double]?) -> Void) {
    self.changed = changed
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    // Never drawn, but not hidden: UIKit may skip a hidden view's layout and hinge updates.
    alpha = 0
    isAccessibilityElement = false
    autoresizingMask = [.flexibleWidth, .flexibleHeight]
    if #available(iOS 27.1, *) {
      addInteraction(UIHingeInteraction { [weak self] _, _ in self?.check() })
    }
  }

  required init?(coder: NSCoder) { nil }

  override func layoutSubviews() {
    super.layoutSubviews()
    check()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    check()
  }

  private func check(tries: Int = 0) {
    // The regions follow the hinge and the window's new size a moment after they change: read on the next turn.
    DispatchQueue.main.async { [weak self] in
      guard let self, let window = self.window else { return }
      let fold = HingeModule.division(in: window)
      // At launch iOS may not have said where the fold is yet: a window wide enough for two looks again a few times.
      if fold == nil, window.bounds.width >= 700, tries < 8 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.check(tries: tries + 1) }
      }
      if let last = self.last, last == fold { return }
      self.last = .some(fold)
      self.changed(fold)
    }
  }
}
