// A chat's file shown in iOS's own previewer (Quick Look): PDFs, Office files, CSV, Markdown, text, code and pictures,
// full screen over the app, with Share in its corner and swipe down to close. src/shareFile.ts writes the file to a
// folder of its own and asks here; a file Quick Look can't show answers false, and the app offers the share sheet.
import ExpoModulesCore
import QuickLook

public final class QuickLookModule: Module {
  /// The previewer's one file, held while it shows: the controller keeps its data source weakly.
  private var shown: Shown?

  public func definition() -> ModuleDefinition {
    Name("FleetdQuickLook")

    /// Whether Quick Look shows the file at `uri` (a file: URL): it opens it and answers true once it is up.
    AsyncFunction("preview") { (uri: String, promise: Promise) in
      guard let url = URL(string: uri), url.isFileURL else {
        promise.resolve(false)
        return
      }
      let item = url as NSURL
      guard QLPreviewController.canPreview(item), let top = self.appContext?.utilities?.currentViewController() else {
        promise.resolve(false)
        return
      }
      let shown = Shown(item: item) { [weak self] in self?.shown = nil }
      self.shown = shown
      let controller = QLPreviewController()
      controller.dataSource = shown
      controller.delegate = shown
      top.present(controller, animated: true) { promise.resolve(true) }
    }.runOnQueue(.main)
  }
}

private final class Shown: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  let item: NSURL
  let closed: () -> Void

  init(item: NSURL, closed: @escaping () -> Void) {
    self.item = item
    self.closed = closed
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { item }

  func previewControllerDidDismiss(_ controller: QLPreviewController) { closed() }
}
