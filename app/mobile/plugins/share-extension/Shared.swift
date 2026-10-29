// What the Share Extension decides, apart from its screens and its link: the pairing it reads, the hub's frames, the
// chats it offers and what it sends. Foundation only: test/main.swift checks it on macOS.
import Foundation

/// The paired hub, as the app keeps it (src/vault.ts): `{hub, key, hubName}` under "fleetd.hub".
struct Pairing: Equatable {
  let hub: String
  let key: String
  let hubName: String

  /// Nil when the phone isn't paired: nothing stored, or what is stored isn't a pairing.
  static func parse(_ stored: Data?) -> Pairing? {
    guard let stored, let p = try? JSONSerialization.jsonObject(with: stored) as? [String: Any],
          let hub = p["hub"] as? String, let key = p["key"] as? String, !hub.isEmpty, !key.isEmpty else { return nil }
    return Pairing(hub: hub, key: key, hubName: (p["hubName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? hub)
  }

  /// `http(s)://host[:port]` → the hub's `ws(s)://host[:port]/app` (src/hub/client.ts socketUrl).
  var socketURL: URL? {
    var origin = hub
    while origin.hasSuffix("/") { origin.removeLast() }
    guard origin.hasPrefix("http://") || origin.hasPrefix("https://") else { return nil }
    return URL(string: "ws" + String(origin.dropFirst(4)) + "/app")
  }

  /// The hub's address without its scheme, as the app names it.
  var host: String {
    hub.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "")
  }
}

/// Why the sheet can't send, in the phone's words, with what to do.
struct Problem: Equatable, Error {
  let title: String
  let message: String
  /// Whether trying again may help (an unreachable hub), rather than only the app (pairing).
  let retry: Bool
  /// An SF Symbol for it.
  let symbol: String

  static let notPaired = Problem(
    title: "Pair fleetd first",
    message: "This phone isn't connected to a hub yet. Open fleetd and pair it with your hub, then share again.",
    retry: false,
    symbol: "qrcode.viewfinder"
  )

  static func unreachable(_ p: Pairing) -> Problem {
    Problem(
      title: "Can't reach \(p.hubName)",
      message: "\(p.host) didn't answer. Check that the hub is running and that this phone reaches it: on a tailnet, that Tailscale is on.",
      retry: true,
      symbol: "wifi.exclamationmark"
    )
  }

  static func refused(_ p: Pairing) -> Problem {
    Problem(
      title: "\(p.hubName) refused this phone",
      message: "Its key was revoked, or the hub was set up again. Open fleetd and pair it again.",
      retry: false,
      symbol: "lock.slash"
    )
  }

  static func dropped(_ p: Pairing) -> Problem {
    Problem(
      title: "Lost \(p.hubName)",
      message: "The connection dropped before the hub answered. Nothing is sent twice: try again.",
      retry: true,
      symbol: "wifi.exclamationmark"
    )
  }

  static func hub(code: String, message: String, fix: String?) -> Problem {
    Problem(title: "The hub didn't take it", message: [message, fix].compactMap { $0 }.joined(separator: " "), retry: true, symbol: "exclamationmark.triangle")
  }
}

/// The hub's frames the extension reads (src/hub/client.ts parseFrame); nil for any other.
enum Frame {
  case ready
  case snapshot([String: Any])
  case result(id: String, output: [String: Any])
  case error(id: String?, code: String, message: String, fix: String?)

  static func parse(_ text: Data) -> Frame? {
    guard let f = try? JSONSerialization.jsonObject(with: text) as? [String: Any], let t = f["t"] as? String else { return nil }
    switch t {
    case "ready": return .ready
    case "snapshot": return .snapshot(f)
    case "result":
      guard let id = f["id"] as? String else { return nil }
      return .result(id: id, output: f["output"] as? [String: Any] ?? [:])
    case "error":
      return .error(id: f["id"] as? String, code: f["code"] as? String ?? "", message: f["message"] as? String ?? "The hub refused it.", fix: f["fix"] as? String)
    default: return nil
    }
  }
}

/// One chat to send into: a Navi or a project.
struct ChatTarget: Identifiable, Equatable {
  let machineId: String
  let projectId: String
  let title: String
  let navi: Bool
  /// The machine's name, for a project; nil for a Navi.
  let machine: String?
  /// When it last spoke, or last did anything (ISO 8601, so it sorts as text).
  let at: String

  var id: String { "\(machineId)/\(projectId)" }
  var subtitle: String { navi ? "Navi" : machine ?? "Project" }

  /// The snapshot's chats, who spoke last first, as the app's Chats list (src/lists.ts); an archived Navi is in none.
  static func from(snapshot s: [String: Any]) -> [ChatTarget] {
    var machines: [String: String] = [:]
    for m in s["machines"] as? [[String: Any]] ?? [] {
      if let id = m["machineId"] as? String, let name = m["name"] as? String { machines[id] = name }
    }
    var spoke: [String: String] = [:]
    for c in s["chats"] as? [[String: Any]] ?? [] {
      if let ref = c["projectRef"] as? [String: Any], let m = ref["machineId"] as? String, let p = ref["projectId"] as? String,
         let at = c["lastMessageAt"] as? String { spoke["\(m)/\(p)"] = at }
    }
    let chats = (s["projects"] as? [[String: Any]] ?? []).compactMap { p -> ChatTarget? in
      guard let m = p["machineId"] as? String, let id = p["projectId"] as? String, let title = p["title"] as? String else { return nil }
      let navi = p["kind"] as? String == "assistant"
      if navi && p["archivedAt"] != nil { return nil }
      return ChatTarget(
        machineId: m, projectId: id, title: title, navi: navi, machine: navi ? nil : machines[m],
        at: spoke["\(m)/\(id)"] ?? p["lastActivityAt"] as? String ?? ""
      )
    }
    return chats.sorted { $0.at != $1.at ? $0.at > $1.at : $0.title.localizedStandardCompare($1.title) == .orderedAscending }
  }

  /// The chats whose name, or machine's, holds the query, ignoring case and accents; all of them for none.
  static func search(_ chats: [ChatTarget], _ query: String) -> [ChatTarget] {
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if q.isEmpty { return chats }
    let fold = { (s: String) in s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
    return chats.filter { fold($0.title).contains(fold(q)) || fold($0.subtitle).contains(fold(q)) }
  }
}

/// An avatar's initials and tint, as the app's (src/avatar.ts), so a chat looks the same in both.
enum Avatar {
  static func initials(_ name: String) -> String {
    let words = name.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    guard let first = words.first?.first else { return name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?" }
    let second = words.count > 1 ? words[1].first.map(String.init) ?? "" : ""
    return (String(first) + second).uppercased()
  }

  /// FNV-1a of the name's UTF-16, in [0, count).
  static func tint(_ name: String, count: Int) -> Int {
    var h: UInt32 = 0x811c_9dc5
    for unit in name.utf16 {
      h ^= UInt32(unit)
      h = h &* 0x0100_0193
    }
    return count <= 0 ? 0 : Int(h % UInt32(count))
  }
}

/// The hub's limits (crates/fleetd-contracts: ATTACHMENT_MAX_BYTES, ATTACHMENT_PART_BYTES, ATTACHMENTS_MAX,
/// CHAT_TEXT_MAX).
enum Limits {
  static let fileBytes = 25 * 1024 * 1024
  static let pieceBytes = 512 * 1024
  static let files = 20
  static let textChars = 100_000
}

/// The file types the hub takes (AttachmentMime).
enum Mime: String {
  case png = "image/png"
  case jpeg = "image/jpeg"
  case webp = "image/webp"
  case gif = "image/gif"
  case text = "text/plain"

  /// An image's type by its first bytes (AttachmentMime::of_image); nil for any other, which goes as JPEG.
  static func ofImage(_ data: Data) -> Mime? {
    let b = [UInt8](data.prefix(12))
    if b.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return .png }
    if b.starts(with: [0xFF, 0xD8, 0xFF]) { return .jpeg }
    if b.starts(with: Array("GIF87a".utf8)) || b.starts(with: Array("GIF89a".utf8)) { return .gif }
    if b.count == 12 && b.starts(with: Array("RIFF".utf8)) && Array(b[8..<12]) == Array("WEBP".utf8) { return .webp }
    return nil
  }

  var ext: String {
    switch self {
    case .png: return "png"
    case .jpeg: return "jpg"
    case .webp: return "webp"
    case .gif: return "gif"
    case .text: return "txt"
    }
  }
}

/// One file to upload.
struct Upload: Equatable {
  let name: String
  let mime: Mime
  let data: Data

  /// The shared file's own name with the extension its type has (IMG_0042.HEIC sent as JPEG is IMG_0042.jpg), or
  /// image-N; at most 120 characters, the hub's limit.
  static func name(_ original: String?, mime: Mime, index: Int) -> String {
    let base = (original.map { ($0 as NSString).deletingPathExtension } ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let stem = base.isEmpty ? (mime == .text ? "shared" : "image-\(index + 1)") : String(base.prefix(110))
    return "\(stem).\(mime.ext)"
  }

  /// The pieces it goes up in: all but the last with attachment_part, the last with attachment_put.
  var pieces: [Data] {
    if data.isEmpty { return [data] }
    return stride(from: 0, to: data.count, by: Limits.pieceBytes).map { data.subdata(in: $0..<min($0 + Limits.pieceBytes, data.count)) }
  }

  /// Why the hub won't take it, or nil.
  var tooLarge: String? {
    data.count > Limits.fileBytes ? "\(name) is \(Upload.size(data.count)); fleetd takes files up to 25 MB." : nil
  }

  static func size(_ bytes: Int) -> String {
    bytes >= 1024 * 1024 ? String(format: "%.1f MB", Double(bytes) / 1_048_576) : "\(max(1, bytes / 1024)) KB"
  }
}

/// A shared web page: its address and, when the app said, its title.
struct SharedLink: Equatable {
  let url: URL
  let title: String?
}

/// What goes to the chat: chat_send's text, and a text file for shared text past its limit.
struct Outgoing: Equatable {
  let text: String
  let textFile: Upload?

  /// The note first, then the shared text, then each link (its title over it), then, for images alone, a line saying
  /// so: chat_send needs words.
  static func build(note: String, texts: [String], links: [SharedLink], images: Int) -> Outgoing {
    let note = note.trimmingCharacters(in: .whitespacesAndNewlines)
    // A page shared as its address in text too (some apps do) is one link.
    let shared = texts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { t in !t.isEmpty && !links.contains { $0.url.absoluteString == t } }
      .joined(separator: "\n\n")
    let linkLines = links.filter { !shared.contains($0.url.absoluteString) }.map { link -> String in
      guard let title = link.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty, title != link.url.absoluteString else { return link.url.absoluteString }
      return "\(title)\n\(link.url.absoluteString)"
    }
    let said = images == 1 ? "Shared an image." : "Shared \(images) images."
    let body = [shared, linkLines.joined(separator: "\n\n")].filter { !$0.isEmpty }.joined(separator: "\n\n")
    let whole = [note, body].filter { !$0.isEmpty }.joined(separator: "\n\n")
    if whole.utf16.count <= Limits.textChars || shared.isEmpty {
      return Outgoing(text: whole.isEmpty ? (images > 0 ? said : "") : clip(whole), textFile: nil)
    }
    // Too long for a message: the shared text goes as a file, the rest as the message.
    let file = Upload(name: Upload.name(nil, mime: .text, index: 0), mime: .text, data: Data(shared.utf8))
    let rest = [note, linkLines.joined(separator: "\n\n")].filter { !$0.isEmpty }.joined(separator: "\n\n")
    return Outgoing(text: rest.isEmpty ? "Shared a long text, attached." : clip(rest), textFile: file)
  }

  /// At most the hub's length, counted as JSON counts it (UTF-16).
  private static func clip(_ text: String) -> String {
    if text.utf16.count <= Limits.textChars { return text }
    var out = ""
    var units = 0
    for c in text {
      units += c.utf16.count
      if units > Limits.textChars { break }
      out.append(c)
    }
    return out
  }
}

/// The tools' inputs, as the hub takes them (AttachmentPartInput, AttachmentPutInput, ChatSendInput).
enum Calls {
  /// A piece before the last: the first starts the upload, each next one names it and the bytes sent so far.
  static func part(_ piece: Data, uploadId: String?, offset: Int) -> [String: Any] {
    guard let uploadId else { return ["dataB64": piece.base64EncodedString()] }
    return ["dataB64": piece.base64EncodedString(), "uploadId": uploadId, "offset": offset]
  }

  /// The last piece, or the whole file, which stores it.
  static func put(_ file: Upload, last: Data, uploadId: String?) -> [String: Any] {
    var input: [String: Any] = ["name": file.name, "mime": file.mime.rawValue, "dataB64": last.base64EncodedString()]
    if let uploadId { input["uploadId"] = uploadId }
    return input
  }

  /// The same requestId on a retry returns the message already sent, never a second one.
  static func send(_ chat: ChatTarget, text: String, attachments: [String], requestId: String) -> [String: Any] {
    var input: [String: Any] = [
      "projectRef": ["machineId": chat.machineId, "projectId": chat.projectId],
      "text": text,
      "clientRequestId": requestId,
    ]
    if !attachments.isEmpty { input["attachments"] = attachments }
    return input
  }
}
