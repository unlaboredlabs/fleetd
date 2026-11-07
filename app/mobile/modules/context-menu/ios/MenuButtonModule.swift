// A round Liquid Glass button whose tap opens iOS's own menu, as the + beside Messages' field does on iOS 26: the glass
// presses as the system's, the menu grows out of it with its symbols leading, and nothing blurs the screen behind it.
// A picked action fires once the menu is gone, so the picker or sheet it opens can come up.
import ExpoModulesCore
import UIKit

public final class MenuButtonModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FleetdMenuButton")

    View(MenuButtonView.self) {
      Events("onAction")

      Prop("actions") { (view: MenuButtonView, actions: [MenuAction]) in
        view.actions = actions
      }
      Prop("systemImage") { (view: MenuButtonView, name: String) in
        view.systemImage = name
      }
      Prop("label") { (view: MenuButtonView, label: String) in
        view.button.accessibilityLabel = label
      }
      Prop("hint") { (view: MenuButtonView, hint: String?) in
        view.button.accessibilityHint = hint
      }
    }
  }
}

final class MenuButtonView: ExpoView {
  let onAction = EventDispatcher()
  let button = MenuButton(type: .system)

  var actions: [MenuAction] = [] {
    didSet { button.menu = menu() }
  }
  var systemImage = "plus" {
    didSet { configure() }
  }

  /** The action picked, sent once the menu has gone. */
  private var chosen: String?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    button.showsMenuAsPrimaryAction = true
    button.onEnd = { [weak self] in self?.fire() }
    configure()
    addSubview(button)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    button.frame = bounds
  }

  private func configure() {
    var config: UIButton.Configuration
    if #available(iOS 26.0, *) {
      config = .glass()
    } else {
      config = .gray()
    }
    config.cornerStyle = .capsule
    config.baseForegroundColor = .label
    config.image = UIImage(systemName: systemImage, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .medium))
    button.configuration = config
  }

  private func menu() -> UIMenu {
    UIMenu(children: actions.map { action in
      UIAction(
        title: action.title,
        image: action.systemImage.flatMap { UIImage(systemName: $0) },
        attributes: action.destructive ? .destructive : []
      ) { [weak self] _ in
        self?.chosen = action.id
      }
    })
  }

  private func fire() {
    guard let id = chosen else { return }
    chosen = nil
    onAction(["id": id])
  }
}

/** UIKit's button, saying when its menu has gone. */
final class MenuButton: UIButton {
  var onEnd: (() -> Void)?

  override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionAnimating?) {
    super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
    guard let animator else {
      onEnd?()
      return
    }
    animator.addCompletion { [weak self] in self?.onEnd?() }
  }
}
