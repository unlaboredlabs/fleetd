// iOS's own context menu (UIContextMenuInteraction) around a React Native view, as Messages' bubbles and chats have:
// held, the view lifts in a shape of its own over a blurred screen, with the menu beside it, all drawn and timed by
// iOS on the main thread. An action fires once the menu is gone, so a sheet it opens (Share, Select Text) can come up.
import ExpoModulesCore
import UIKit

public final class ContextMenuModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FleetdContextMenu")

    View(ContextMenuView.self) {
      Events("onAction")

      Prop("actions") { (view: ContextMenuView, actions: [MenuAction]) in
        view.actions = actions
      }
      Prop("menuTitle") { (view: ContextMenuView, title: String?) in
        view.menuTitle = title ?? ""
      }
      Prop("previewRadius") { (view: ContextMenuView, radius: Double?) in
        view.previewRadius = CGFloat(radius ?? 0)
      }
      Prop("previewColor") { (view: ContextMenuView, color: UIColor?) in
        view.previewColor = color
      }
    }
  }
}

struct MenuAction: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  /** An SF Symbol's name. */
  @Field var systemImage: String? = nil
  @Field var destructive: Bool = false
}

final class ContextMenuView: ExpoView, UIContextMenuInteractionDelegate {
  let onAction = EventDispatcher()
  var actions: [MenuAction] = []
  var menuTitle = ""
  var previewRadius: CGFloat = 0
  var previewColor: UIColor?

  /** The action picked, sent once the menu has gone. */
  private var chosen: String?
  private var open = false
  /** The menu is up, not just the view pressed. */
  private var lifted = false
  /** The list the view is in: a finger that scrolls it lets go of the hold. */
  private weak var scrollView: UIScrollView?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    addInteraction(UIContextMenuInteraction(delegate: self))
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    scrollView?.panGestureRecognizer.removeTarget(self, action: #selector(scrolled(_:)))
    scrollView = nil
    guard window != nil else { return }
    var ancestor = superview
    while let view = ancestor, !(view is UIScrollView) { ancestor = view.superview }
    scrollView = ancestor as? UIScrollView
    scrollView?.panGestureRecognizer.addTarget(self, action: #selector(scrolled(_:)))
  }

  /**
   * As in Messages: a press that moves on into a scroll was a scroll, so the view goes back down and the list scrolls,
   * rather than the pressed view hanging over a list moving under it. Its gestures, switched off and on, let go.
   */
  @objc private func scrolled(_ pan: UIPanGestureRecognizer) {
    guard pan.state == .began, !lifted else { return }
    for gesture in gestureRecognizers ?? [] where gesture.isEnabled {
      gesture.isEnabled = false
      gesture.isEnabled = true
    }
  }

  /** Lifted, the list stays still under the menu: the finger that held the view no longer scrolls it. */
  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willDisplayMenuFor configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionAnimating?) {
    lifted = true
    guard let scrollView else { return }
    scrollView.panGestureRecognizer.isEnabled = false
    scrollView.panGestureRecognizer.isEnabled = true
    scrollView.setContentOffset(scrollView.contentOffset, animated: false)
  }

  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
    if actions.isEmpty { return nil }
    chosen = nil
    open = true
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      guard let self else { return nil }
      let items = self.actions.map { action in
        UIAction(
          title: action.title,
          image: action.systemImage.flatMap { UIImage(systemName: $0) },
          attributes: action.destructive ? .destructive : []
        ) { [weak self] _ in
          guard let self else { return }
          self.chosen = action.id
          if !self.open { self.fire() }
        }
      }
      return UIMenu(title: self.menuTitle, children: items)
    }
  }

  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
    preview()
  }

  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, previewForDismissingMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
    preview()
  }

  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionAnimating?) {
    lifted = false
    let done = { [weak self] in
      guard let self else { return }
      self.open = false
      self.fire()
    }
    if let animator { animator.addCompletion(done) } else { done() }
  }

  private func fire() {
    guard let id = chosen else { return }
    chosen = nil
    onAction(["id": id])
  }

  /**
   * The view itself, cut to its shape. Placed by its center in the window: an inverted list draws its rows flipped,
   * and the preview goes where the view shows, upright.
   */
  private func preview() -> UITargetedPreview? {
    guard let window else { return nil }
    let parameters = UIPreviewParameters()
    parameters.backgroundColor = previewColor ?? .clear
    parameters.visiblePath = UIBezierPath(roundedRect: bounds, cornerRadius: previewRadius)
    let center = convert(CGPoint(x: bounds.midX, y: bounds.midY), to: window)
    return UITargetedPreview(view: self, parameters: parameters, target: UIPreviewTarget(container: window, center: center))
  }
}
