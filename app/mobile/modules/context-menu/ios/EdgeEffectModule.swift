// iOS 26's scroll edge effect under a bar the app draws itself (the chat's, its composer): the content scrolling under
// it blurs and fades away, as under Messages' bars, instead of a painted gradient. The view marks its whole frame as a
// bar over one edge of a scroll view (UIScrollEdgeElementContainerInteraction), and UIKit draws the effect there. An
// inverted list is flipped, so its edges are too: the caller names the edge as the scroll view sees it.
import ExpoModulesCore
import UIKit

public final class EdgeEffectModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FleetdEdgeEffect")

    View(EdgeEffectView.self) {
      Prop("scrollViewTag") { (view: EdgeEffectView, tag: Int?) in
        view.scrollViewTag = tag
      }
      Prop("edge") { (view: EdgeEffectView, edge: String) in
        view.edge = edge
      }
    }
  }
}

final class EdgeEffectView: ExpoView {
  var scrollViewTag: Int? {
    didSet { if scrollViewTag != oldValue { attach() } }
  }
  var edge = "top" {
    didSet { if edge != oldValue { attach() } }
  }

  private var interaction: NSObject?
  /**
   * UIKit shapes the effect around the bar's own elements (labels, images, controls), not its bare frame: one clear
   * image over the whole view makes all of it the bar. Kept last, as React Native mounts children by index.
   */
  private let element: UIImageView = {
    let view = UIImageView(image: UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1)).image { _ in })
    view.isUserInteractionEnabled = false
    view.isAccessibilityElement = false
    view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    return view
  }()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    element.frame = bounds
    addSubview(element)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    attach()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if subviews.last !== element { bringSubviewToFront(element) }
    // The list may mount after the bar: try again as layout settles.
    if interaction == nil { attach() }
  }

  private func attach() {
    guard #available(iOS 26.0, *) else { return }
    if let old = interaction as? UIScrollEdgeElementContainerInteraction { removeInteraction(old) }
    interaction = nil
    guard window != nil, let tag = scrollViewTag, let scrollView = scrollView(tag) else { return }
    let added = UIScrollEdgeElementContainerInteraction()
    added.scrollView = scrollView
    added.edge = edge == "bottom" ? .bottom : .top
    addInteraction(added)
    interaction = added
  }

  /** The list's UIScrollView: the view of its tag, or the one just inside it. */
  private func scrollView(_ tag: Int) -> UIScrollView? {
    guard let view = appContext?.findView(withTag: tag, ofType: UIView.self) else { return nil }
    if let scroll = view as? UIScrollView { return scroll }
    return view.subviews.lazy.compactMap { $0 as? UIScrollView }.first
  }
}
