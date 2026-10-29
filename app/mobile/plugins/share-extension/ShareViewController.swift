// The Share Extension's entry (plugins/share-extension): iOS presents it as a sheet over the app that shares, with
// the SwiftUI sheet (ShareView.swift) filling it.
import SwiftUI
import UIKit

final class ShareViewController: UIViewController {
  private lazy var model = ShareModel(items: extensionContext?.inputItems as? [NSExtensionItem] ?? [])

  override func viewDidLoad() {
    super.viewDidLoad()
    model.onDone = { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) }
    model.onCancel = { [weak self] in
      self?.extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }
    model.onOpenApp = { [weak self] in self?.openApp() }
    let host = UIHostingController(rootView: ShareSheet(model: model))
    addChild(host)
    host.view.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(host.view)
    NSLayoutConstraint.activate([
      host.view.topAnchor.constraint(equalTo: view.topAnchor),
      host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
    host.didMove(toParent: self)
    model.start()
  }

  /// Opens fleetd (its fleetd:// scheme, which the app opens to where it was) and closes the sheet. An extension has
  /// no UIApplication.shared: the app object is the end of the responder chain.
  private func openApp() {
    if let url = URL(string: "fleetd://") {
      var responder: UIResponder? = self
      while let next = responder {
        if let app = next as? UIApplication {
          app.open(url, options: [:], completionHandler: nil)
          break
        }
        responder = next.next
      }
    }
    extensionContext?.completeRequest(returningItems: nil)
  }
}
