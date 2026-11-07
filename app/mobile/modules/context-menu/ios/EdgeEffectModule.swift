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
    guard window != nil, let scrollView = scrollViewTag.flatMap(scrollView(tagged:)) ?? nearestList() else { return }
    let added = UIScrollEdgeElementContainerInteraction()
    added.scrollView = scrollView
    added.edge = edge == "bottom" ? .bottom : .top
    addInteraction(added)
    interaction = added
    // Messages' soft fade: UIKit picks the hard one, with its divider line, for a scroll view outside a bar it manages.
    (edge == "bottom" ? scrollView.bottomEdgeEffect : scrollView.topEdgeEffect).style = .soft
  }

  /** The list's UIScrollView: the view of its tag, or the first one inside it. */
  private func scrollView(tagged tag: Int) -> UIScrollView? {
    guard let view = appContext?.findView(withTag: tag, ofType: UIView.self) else { return nil }
    return firstScrollView(in: view, depth: 4)
  }

  /**
   The list beside the bar when its tag finds none (React Native's view for a tag isn't always the scroll view's
   parent): the nearest ancestor's scroll view, outside the bar, at least half the window's height.
   */
  private func nearestList() -> UIScrollView? {
    guard let window else { return nil }
    var level = superview
    while let ancestor = level {
      var queue = ancestor.subviews.filter { $0 !== self }
      while !queue.isEmpty {
        let view = queue.removeFirst()
        if let scroll = view as? UIScrollView, scroll.bounds.height >= window.bounds.height / 2 { return scroll }
        queue.append(contentsOf: view.subviews.filter { $0 !== self })
      }
      level = ancestor.superview
    }
    return nil
  }

  private func firstScrollView(in view: UIView, depth: Int) -> UIScrollView? {
    if let scroll = view as? UIScrollView { return scroll }
    guard depth > 0 else { return nil }
    for child in view.subviews {
      if let found = firstScrollView(in: child, depth: depth - 1) { return found }
    }
    return nil
  }
}
