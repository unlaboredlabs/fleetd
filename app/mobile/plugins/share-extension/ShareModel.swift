// The share sheet's state: what was shared, read from the extension's items; the paired hub and its chats; and the
// send. Images the hub doesn't take as they are (HEIC, TIFF and the like) go as JPEG. A retry after a failure sends
// the files already uploaded only once, and chat_send's request id makes the message one, however often it's tried.
import Foundation
import ImageIO
import LinkPresentation
import Security
import UIKit
import UniformTypeIdentifiers

@MainActor
final class ShareModel: ObservableObject {
  enum Phase: Equatable {
    case connecting
    case choosing
    /// How much has gone up, 0 to 1.
    case sending(Double)
    case sent
    case failed(Problem)
  }

  struct Preview {
    var images: [UIImage] = []
    var link: SharedLink?
    var icon: UIImage?
    var text: String?
    var loading = true
  }

  @Published private(set) var phase = Phase.connecting
  @Published private(set) var chats: [ChatTarget] = []
  @Published private(set) var preview = Preview()
  @Published var selected: ChatTarget?
  @Published var note = ""
  @Published var query = ""
  /// Why what was shared can't go (too large, too many), shown under it.
  @Published private(set) var itemProblem: String?
  /// Why the last send failed, until the next try.
  @Published var sendProblem: Problem?

  var onDone: () -> Void = {}
  var onCancel: () -> Void = {}
  var onOpenApp: () -> Void = {}

  private let items: [NSExtensionItem]
  private var pairing: Pairing?
  private var link: HubLink?
  private var texts: [String] = []
  private var links: [SharedLink] = []
  private var uploads: [Upload] = []
  /// Attachment ids of what went up already, by upload index.
  private var uploaded: [Int: String] = [:]
  private let requestId = "share-" + UUID().uuidString.lowercased()

  init(items: [NSExtensionItem]) {
    self.items = items
  }

  var hubName: String { pairing?.hubName ?? "your hub" }

  /// The most recent chats, for the row on top.
  var recent: [ChatTarget] { Array(chats.prefix(8)) }

  var navis: [ChatTarget] { ChatTarget.search(chats, query).filter(\.navi) }
  var projects: [ChatTarget] { ChatTarget.search(chats, query).filter { !$0.navi } }

  var canSend: Bool {
    phase == .choosing && selected != nil && !preview.loading && itemProblem == nil
  }

  var failed: Bool {
    if case .failed = phase { return true }
    return false
  }

  var sending: Bool {
    switch phase {
    case .sending, .sent: return true
    default: return false
    }
  }

  func start() {
    Task { await load() }
    Task { await connect() }
  }

  func connect() async {
    phase = .connecting
    guard let pairing = Pairing.parse(Keychain.pairing()) else {
      phase = .failed(.notPaired)
      return
    }
    self.pairing = pairing
    guard let link = HubLink(pairing) else {
      phase = .failed(.unreachable(pairing))
      return
    }
    do {
      chats = try await link.open()
      self.link = link
      if let chosen = selected { selected = chats.first { $0.id == chosen.id } }
      phase = .choosing
    } catch {
      phase = .failed(error as? Problem ?? .unreachable(pairing))
    }
  }

  func retry() {
    Task { await connect() }
  }

  func select(_ chat: ChatTarget) {
    guard !sending else { return }
    UISelectionFeedbackGenerator().selectionChanged()
    selected = selected == chat ? nil : chat
  }

  func cancel() {
    link?.close()
    onCancel()
  }

  func openApp() {
    link?.close()
    onOpenApp()
  }

  func send() {
    guard canSend, let chat = selected else { return }
    sendProblem = nil
    Task { await send(to: chat) }
  }

  private func send(to chat: ChatTarget) async {
    let out = Outgoing.build(note: note, texts: texts, links: links, images: uploads.count)
    let files = uploads + (out.textFile.map { [$0] } ?? [])
    let total = max(1, files.reduce(0) { $0 + $1.data.count })
    var done = files.indices.filter { uploaded[$0] != nil }.reduce(0) { $0 + files[$1].data.count }
    phase = .sending(Double(done) / Double(total))
    do {
      if link == nil, let pairing, let fresh = HubLink(pairing) {
        _ = try await fresh.open()
        link = fresh
      }
      guard let link else { throw Problem.notPaired }
      for (i, file) in files.enumerated() where uploaded[i] == nil {
        var uploadId: String?
        var offset = 0
        let pieces = file.pieces
        for piece in pieces.dropLast() {
          uploadId = try await link.call("attachment_part", Calls.part(piece, uploadId: uploadId, offset: offset))["uploadId"] as? String
          offset += piece.count
          done += piece.count
          phase = .sending(Double(done) / Double(total))
        }
        let last = pieces.last ?? Data()
        guard let id = try await link.call("attachment_put", Calls.put(file, last: last, uploadId: uploadId))["attachmentId"] as? String else {
          throw Problem.hub(code: "", message: "The hub didn't store \(file.name).", fix: nil)
        }
        uploaded[i] = id
        done += last.count
        phase = .sending(Double(done) / Double(total))
      }
      let ids = files.indices.compactMap { uploaded[$0] }
      _ = try await link.call("chat_send", Calls.send(chat, text: out.text, attachments: ids, requestId: requestId))
      phase = .sent
      UINotificationFeedbackGenerator().notificationOccurred(.success)
      link.close()
      try? await Task.sleep(nanoseconds: 900_000_000)
      onDone()
    } catch {
      // A dropped link is gone: the next try opens another.
      link?.close()
      link = nil
      UINotificationFeedbackGenerator().notificationOccurred(.error)
      sendProblem = error as? Problem ?? pairing.map(Problem.dropped) ?? .notPaired
      phase = .choosing
    }
  }

  // MARK: What was shared

  private func load() async {
    var images: [(Data, String?)] = []
    for item in items {
      let title = item.attributedContentText?.string ?? item.attributedTitle?.string
      for provider in item.attachments ?? [] {
        if let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) {
          if let image = await Self.imageData(provider, type: type) { images.append(image) }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
          if let url = try? await Self.item(provider, type: UTType.url.identifier) as? URL, !url.isFileURL {
            links.append(SharedLink(url: url, title: title.flatMap { $0.isEmpty ? nil : $0 }))
          }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
          if let text = try? await Self.item(provider, type: UTType.plainText.identifier) as? String { texts.append(text) }
        }
      }
    }
    if images.count > Limits.files {
      itemProblem = "fleetd takes up to \(Limits.files) images at once; pick fewer."
    }
    for (i, (data, name)) in images.prefix(Limits.files).enumerated() {
      let prepared = await Task.detached(priority: .userInitiated) { Self.prepare(data, name: name, index: i) }.value
      guard let prepared else {
        itemProblem = "\(name ?? "An image") isn't an image fleetd can read."
        continue
      }
      uploads.append(prepared.upload)
      if let thumbnail = prepared.thumbnail { preview.images.append(UIImage(cgImage: thumbnail)) }
      if let tooLarge = prepared.upload.tooLarge { itemProblem = tooLarge }
    }
    preview.link = links.first
    let text = texts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: "\n\n")
    preview.text = text.isEmpty ? nil : text
    if images.isEmpty && links.isEmpty && preview.text == nil && itemProblem == nil {
      itemProblem = "There's nothing here fleetd can send: it takes text, links and images."
    }
    preview.loading = false
    if let link = links.first { await describe(link) }
  }

  /// The page's title and icon, as Messages shows a link; the address alone when it doesn't answer.
  private func describe(_ link: SharedLink) async {
    let provider = LPMetadataProvider()
    provider.timeout = 6
    guard let meta = try? await provider.startFetchingMetadata(for: link.url) else { return }
    if link.title == nil, let title = meta.title, !title.isEmpty, let i = links.firstIndex(of: link) {
      links[i] = SharedLink(url: link.url, title: title)
      preview.link = links[i]
    }
    if let icon = meta.iconProvider, let image = try? await Self.object(icon) { preview.icon = image }
  }

  private nonisolated static func item(_ provider: NSItemProvider, type: String) async throws -> NSSecureCoding? {
    try await withCheckedThrowingContinuation { done in
      provider.loadItem(forTypeIdentifier: type, options: nil) { item, error in
        if let error { done.resume(throwing: error) } else { done.resume(returning: item) }
      }
    }
  }

  private nonisolated static func object(_ provider: NSItemProvider) async throws -> UIImage? {
    try await withCheckedThrowingContinuation { done in
      provider.loadObject(ofClass: UIImage.self) { image, error in
        if let error { done.resume(throwing: error) } else { done.resume(returning: image as? UIImage) }
      }
    }
  }

  /// An image's bytes and file name, however the app shared it: a file, data, or a UIImage.
  private nonisolated static func imageData(_ provider: NSItemProvider, type: String) async -> (Data, String?)? {
    guard let loaded = try? await item(provider, type: type) else { return nil }
    switch loaded {
    case let url as URL: return (try? Data(contentsOf: url)).map { ($0, url.lastPathComponent) }
    case let data as Data: return (data, provider.suggestedName)
    case let image as UIImage: return image.pngData().map { ($0, provider.suggestedName) }
    default: return nil
    }
  }

  /// The upload, as it is when the hub takes its type and size, else as JPEG at most 4096 px; and its thumbnail.
  private nonisolated static func prepare(_ data: Data, name: String?, index: Int) -> (upload: Upload, thumbnail: CGImage?)? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: 480,
    ] as CFDictionary)
    if let mime = Mime.ofImage(data), data.count <= Limits.fileBytes {
      return (Upload(name: Upload.name(name, mime: mime, index: index), mime: mime, data: data), thumbnail)
    }
    for side in [4096, 2048] {
      guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: side,
      ] as CFDictionary) else { return nil }
      let out = NSMutableData()
      guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
      CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
      guard CGImageDestinationFinalize(dest) else { return nil }
      let upload = Upload(name: Upload.name(name, mime: .jpeg, index: index), mime: .jpeg, data: out as Data)
      if upload.tooLarge == nil || side == 2048 { return (upload, thumbnail) }
    }
    return nil
  }
}

/// The paired hub, as expo-secure-store keeps it in the keychain group the app shares (src/vault.ts): service
/// "app:no-auth" (or "app", from older versions), account "fleetd.hub". Read only, never copied.
enum Keychain {
  static func pairing() -> Data? {
    for service in ["app:no-auth", "app"] {
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: Data("fleetd.hub".utf8),
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
      ]
      var item: CFTypeRef?
      if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data { return data }
    }
    return nil
  }
}
