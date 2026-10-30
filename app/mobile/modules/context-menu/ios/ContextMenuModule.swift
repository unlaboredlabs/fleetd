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

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    addInteraction(UIContextMenuInteraction(delegate: self))
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
