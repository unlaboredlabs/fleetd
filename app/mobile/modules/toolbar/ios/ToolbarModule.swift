// iOS 26's bottom toolbar for the screen a view sits in, as Messages' and Mail's: a round Liquid Glass button on the
// left that opens a menu of filters, and the screen's search field (react-native-screens' UISearchController, placed
// "integrated") as a glass pill beside it, which iOS lifts over the keyboard while searching. The view itself draws
// nothing; it sets its screen's toolbarItems and shows the navigation controller's toolbar, and hides it again when it
// goes. Before iOS 26 there is no search in a toolbar: `supported` says so, and the JavaScript keeps its bar on top.
import ExpoModulesCore
import UIKit

public final class ToolbarModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FleetdToolbar")

    Constant("supported") { () -> Bool in
      if #available(iOS 26.0, *) { return true }
      return false
    }

    View(ToolbarView.self) {
      Events("onSelect")

      Prop("filters") { (view: ToolbarView, filters: [Filter]) in
        view.filters = filters
      }
      Prop("selected") { (view: ToolbarView, selected: String) in
        view.selected = selected
      }
      Prop("label") { (view: ToolbarView, label: String) in
        view.label = label
      }
      Prop("filtered") { (view: ToolbarView, filtered: Bool) in
        view.filtered = filtered
      }
    }
  }
}

struct Filter: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  /** A quiet second line: how many chats it holds that want you. */
  @Field var subtitle: String? = nil
  /** An SF Symbol's name. */
  @Field var systemImage: String? = nil
}

final class ToolbarView: ExpoView {
  let onSelect = EventDispatcher()
  var filters: [Filter] = [] { didSet { update() } }
  var selected = "" { didSet { update() } }
  var label = "" { didSet { update() } }
  /** A filter other than All is on: the button is tinted, as Mail's. */
  var filtered = false { didSet { update() } }

  private let button = UIBarButtonItem(image: UIImage(systemName: "line.3.horizontal.decrease"), menu: nil)
  /** The screen whose toolbar this is. */
  private weak var screen: UIViewController?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    update()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // Off screen (a chat pushed over the list) the toolbar goes with the screen; it's set again as it comes back.
    if window != nil { attach() }
  }

  override func willMove(toSuperview newSuperview: UIView?) {
    super.willMove(toSuperview: newSuperview)
    if newSuperview == nil { detach() }
  }

  private func attach() {
    guard #available(iOS 26.0, *), let vc = owner(), let nav = vc.navigationController else { return }
    screen = vc
    vc.toolbarItems = [button, .flexibleSpace(), vc.navigationItem.searchBarPlacementBarButtonItem]
    if nav.isToolbarHidden { nav.setToolbarHidden(false, animated: false) }
  }

  private func detach() {
    guard let vc = screen else { return }
    vc.toolbarItems = nil
    vc.navigationController?.setToolbarHidden(true, animated: false)
    screen = nil
  }

  /** The nearest view controller up the responder chain that a navigation controller holds: the screen. */
  private func owner() -> UIViewController? {
    var next: UIResponder? = self
    while let r = next {
      if let vc = r as? UIViewController, vc.navigationController != nil { return vc }
      next = r.next
    }
    return nil
  }

  private func update() {
    let actions = filters.map { f in
      UIAction(title: f.title, subtitle: f.subtitle, image: f.systemImage.flatMap { UIImage(systemName: $0) }, state: f.id == selected ? .on : .off) { [weak self] _ in
        self?.onSelect(["id": f.id])
      }
    }
    button.menu = UIMenu(options: .singleSelection, children: actions)
    button.accessibilityLabel = label
    button.accessibilityValue = filters.first { $0.id == selected }?.title
    if #available(iOS 26.0, *) {
      button.style = filtered ? .prominent : .plain
    }
  }
}
