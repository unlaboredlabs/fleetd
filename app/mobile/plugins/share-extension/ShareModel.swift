// The share sheet's state: what was shared, read from the extension's items; the paired hub and its chats; and the
// send. Images the hub doesn't take as they are (HEIC, TIFF and the like) go as JPEG. A retry after a failure sends
// the files already uploaded only once, and chat_send's request id makes the message one, however often it's tried.
//
// An extension that outgrows its memory (about 120 MB on a phone) is killed without a word, so images stay files
// until they go: the preview holds small thumbnails ImageIO makes from the files, and the send reads, converts and
// uploads one image at a time, its bytes mapped from the file and released before the next. Each image's memory
// footprint after it goes is logged (Console: subsystem sh.fleetd.app.share).
import Foundation
import ImageIO
import LinkPresentation
import os
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
  /// The shared images, as files in the extension's own temporary folder.
  private var images: [SharedImage] = []
  /// Attachment ids of what went up already, by file index: the images, then a text file.
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
    let out = Outgoing.build(note: note, texts: texts, links: links, images: images.count)
    // Sizes from the files, for the progress: a converted image ends up smaller or close.
    let sizes = images.map(\.bytes) + (out.textFile.map { [$0.data.count] } ?? [])
    let total = max(1, sizes.reduce(0, +))
    var done = sizes.indices.filter { uploaded[$0] != nil }.reduce(0) { $0 + sizes[$1] }
    phase = .sending(Double(done) / Double(total))
    do {
      if link == nil, let pairing, let fresh = HubLink(pairing) {
        _ = try await fresh.open()
        link = fresh
      }
      guard let link else { throw Problem.notPaired }
      for i in sizes.indices where uploaded[i] == nil {
        // One file in memory at a time: read (mapped) or converted here, gone when the loop moves on.
        let file: Upload
        if i < images.count {
          let image = images[i]
          guard let prepared = await Task.detached(priority: .userInitiated, operation: { Self.prepare(image, index: i) }).value else {
            throw Problem.unreadable(image.name ?? "An image")
          }
          if let tooLarge = prepared.tooLarge { throw Problem.tooLarge(tooLarge) }
          file = prepared
        } else if let text = out.textFile {
          file = text
        } else { continue }
        var uploadId: String?
        var offset = 0
        let ranges = file.pieceRanges
        for range in ranges.dropLast() {
          uploadId = try await link.call("attachment_part", Calls.part(file.data.subdata(in: range), uploadId: uploadId, offset: offset))["uploadId"] as? String
          offset += range.count
          done += range.count
          phase = .sending(min(1, Double(done) / Double(total)))
        }
        let last = ranges.last.map { file.data.subdata(in: $0) } ?? Data()
        guard let id = try await link.call("attachment_put", Calls.put(file, last: last, uploadId: uploadId))["attachmentId"] as? String else {
          throw Problem.hub(code: "", message: "The hub didn't store \(file.name).", fix: nil)
        }
        uploaded[i] = id
        done = sizes.indices.filter { uploaded[$0] != nil }.reduce(0) { $0 + sizes[$1] }
        phase = .sending(min(1, Double(done) / Double(total)))
        Self.log.info("sent \(file.name, privacy: .public) (\(file.data.count) bytes); footprint \(Self.footprint()) MB")
      }
      let ids = sizes.indices.compactMap { uploaded[$0] }
      _ = try await link.call("chat_send", Calls.send(chat, text: out.text, attachments: ids, requestId: requestId))
      phase = .sent
      UINotificationFeedbackGenerator().notificationOccurred(.success)
      link.close()
      Self.clearFiles()
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
    Self.clearFiles()
    var tooMany = false
    for item in items {
      let title = item.attributedContentText?.string ?? item.attributedTitle?.string
      for provider in item.attachments ?? [] {
        if let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) {
          guard images.count < Limits.files else {
            tooMany = true
            continue
          }
          if let image = await Self.keep(provider, type: type, index: images.count) { images.append(image) }
          else { itemProblem = "\(provider.suggestedName ?? "An image") couldn't be read." }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
          if let url = try? await Self.item(provider, type: UTType.url.identifier) as? URL, !url.isFileURL {
            links.append(SharedLink(url: url, title: title.flatMap { $0.isEmpty ? nil : $0 }))
          }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
          if let text = try? await Self.item(provider, type: UTType.plainText.identifier) as? String { texts.append(text) }
        }
      }
    }
    if tooMany { itemProblem = "fleetd takes up to \(Limits.files) images at once; pick fewer." }
    // Small thumbnails, one at a time, never the images themselves.
    let side = Thumbnail.side(images: images.count)
    for image in images {
      if let thumbnail = await Task.detached(priority: .userInitiated, operation: { Self.thumbnail(image.file, side: side) }).value {
        preview.images.append(UIImage(cgImage: thumbnail))
      }
    }
    preview.link = links.first
    let text = texts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: "\n\n")
    preview.text = text.isEmpty ? nil : text
    if images.isEmpty && links.isEmpty && preview.text == nil && itemProblem == nil {
      itemProblem = "There's nothing here fleetd can send: it takes text, links and images."
    }
    preview.loading = false
    Self.log.info("read \(self.images.count) images; footprint \(Self.footprint()) MB")
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

  private static let log = Logger(subsystem: "sh.fleetd.app.share", category: "memory")

  /// Where the shared images wait: the extension's own temporary folder, emptied on each share and after a send.
  private nonisolated static var folder: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("shared", isDirectory: true)
  }

  private nonisolated static func clearFiles() {
    try? FileManager.default.removeItem(at: folder)
  }

  /// An image as a file of the extension's own, however the app shared it: a file (copied while the provider lends
  /// it), data, or a UIImage (a screenshot), written out once and let go.
  private nonisolated static func keep(_ provider: NSItemProvider, type: String, index: Int) async -> SharedImage? {
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let to = { (name: String) in folder.appendingPathComponent("\(index)-\(name)") }
    let copied: SharedImage? = await withCheckedContinuation { done in
      provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
        guard let url else { return done.resume(returning: nil) }
        let file = to(url.lastPathComponent)
        done.resume(returning: (try? FileManager.default.copyItem(at: url, to: file)).flatMap { _ in SharedImage.at(file, name: url.lastPathComponent) })
      }
    }
    if let copied { return copied }
    guard let loaded = try? await item(provider, type: type) else { return nil }
    switch loaded {
    case let url as URL:
      let file = to(url.lastPathComponent)
      return (try? FileManager.default.copyItem(at: url, to: file)).flatMap { _ in SharedImage.at(file, name: url.lastPathComponent) }
    case let data as Data:
      let file = to("image")
      return (try? data.write(to: file)).flatMap { _ in SharedImage.at(file, name: provider.suggestedName) }
    case let image as UIImage:
      let file = to("image.png")
      return (try? image.pngData()?.write(to: file)).flatMap { _ in SharedImage.at(file, name: provider.suggestedName) }
    default:
      return nil
    }
  }

  /// A thumbnail at most `side` pixels, decoded from the file at that size (never the whole image).
  private nonisolated static func thumbnail(_ file: URL, side: Int) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(file as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
    return CGImageSourceCreateThumbnailAtIndex(source, 0, [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: side,
    ] as CFDictionary)
  }

  /// The upload: the file as it is (mapped, so its pages are read as they go up) when the hub takes its type and
  /// size, else as JPEG at most 4096 px, decoded at that size. Nil when it isn't an image ImageIO reads.
  private nonisolated static func prepare(_ image: SharedImage, index: Int) -> Upload? {
    guard let data = try? Data(contentsOf: image.file, options: .alwaysMapped) else { return nil }
    if let mime = Mime.ofImage(data), data.count <= Limits.fileBytes {
      return Upload(name: Upload.name(image.name, mime: mime, index: index), mime: mime, data: data)
    }
    guard let source = CGImageSourceCreateWithURL(image.file as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
    for side in [4096, 2048] {
      let out = NSMutableData()
      let encoded: Bool = autoreleasepool {
        guard let decoded = CGImageSourceCreateThumbnailAtIndex(source, 0, [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: side,
        ] as CFDictionary), let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return false }
        CGImageDestinationAddImage(dest, decoded, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        return CGImageDestinationFinalize(dest)
      }
      guard encoded else { return nil }
      let upload = Upload(name: Upload.name(image.name, mime: .jpeg, index: index), mime: .jpeg, data: out as Data)
      if upload.tooLarge == nil || side == 2048 { return upload }
    }
    return nil
  }

  /// This process's memory as iOS counts it against the extension's limit (phys_footprint), in MB.
  private nonisolated static func footprint() -> Int {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
    }
    return result == KERN_SUCCESS ? Int(info.phys_footprint / 1_048_576) : -1
  }
}

/// A shared image, kept as a file until it goes.
struct SharedImage {
  let file: URL
  /// The name the app gave it, for the upload's.
  let name: String?
  let bytes: Int

  static func at(_ file: URL, name: String?) -> SharedImage? {
    guard let bytes = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.size] as? Int else { return nil }
    return SharedImage(file: file, name: name, bytes: bytes)
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
