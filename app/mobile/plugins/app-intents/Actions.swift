// What fleetd's Shortcuts actions decide (Intents.swift), apart from App Intents itself: the links Open Chat and Open
// Approvals open, the chats and automations their pickers list, Send Message with its files and its wait for the
// reply, the latest messages and the waiting approvals they return, and what each failure says. Foundation only, with
// the share extension's Shared.swift: test/main.swift checks it, on Linux too.
import Foundation

/// The app's own links (src/shortcutLink.ts reads them): a chat, and Chats' Needs You list.
enum Links {
  /// `fleetd://chat?machine=…&project=…` for a chat's id ("machineId/projectId"); nil for one that isn't.
  static func chat(_ id: String) -> URL? {
    guard let ref = ChatRef(id) else { return nil }
    var link = URLComponents()
    link.scheme = "fleetd"
    link.host = "chat"
    link.queryItems = [URLQueryItem(name: "machine", value: ref.machineId), URLQueryItem(name: "project", value: ref.projectId)]
    return link.url
  }

  static let approvals = URL(string: "fleetd://approvals")!
}

/// A chat's id, "machineId/projectId", as the app keys chats (src/store.ts keyOf).
struct ChatRef: Equatable {
  let machineId: String
  let projectId: String

  init?(_ id: String) {
    guard let slash = id.firstIndex(of: "/") else { return nil }
    machineId = String(id[..<slash])
    projectId = String(id[id.index(after: slash)...])
    if machineId.isEmpty || projectId.isEmpty { return nil }
  }

  var projectRef: [String: String] { ["machineId": machineId, "projectId": projectId] }
}

extension Problem {
  static let unpaired = Problem(
    title: "Pair fleetd first",
    message: "This iPhone isn't connected to a hub yet. Open fleetd and pair it with your hub, then run the shortcut again.",
    retry: false,
    symbol: "qrcode.viewfinder"
  )

  /// The phone's key to the hub opens once the phone has been unlocked since it started (src/vault.ts).
  static let locked = Problem(
    title: "Unlock your iPhone",
    message: "fleetd's key to your hub opens once this iPhone has been unlocked since it started. Unlock it, then run the shortcut again.",
    retry: true,
    symbol: "lock"
  )

  static func noChat(_ p: Pairing) -> Problem {
    Problem(
      title: "That chat isn't on \(p.hubName) any more",
      message: "It was archived or deleted. Edit the shortcut and pick another chat.",
      retry: false,
      symbol: "bubble.left.and.exclamationmark.bubble.right"
    )
  }

  static let empty = Problem(title: "Nothing to send", message: "The message is empty: give the action some text or a file.", retry: false, symbol: "text.bubble")

  static let tooManyFiles = Problem(
    title: "Too many files",
    message: "fleetd takes up to \(Limits.files) files in one message. Send the rest in another.",
    retry: false,
    symbol: "doc.on.doc"
  )

  /// A file the hub doesn't take.
  static func unsupported(_ name: String) -> Problem {
    Problem(
      title: "fleetd doesn't take \(name)",
      message: "Send images, PDFs, text or CSV files, Word, Excel or PowerPoint documents, or zip archives.",
      retry: false,
      symbol: "doc.questionmark"
    )
  }

  static func noReply(_ chat: String, seconds: Int) -> Problem {
    Problem(
      title: "No reply yet",
      message: "The message went to \(chat), which didn't answer within \(seconds) seconds. Its reply shows in the chat.",
      retry: false,
      symbol: "clock"
    )
  }

  static let noAutomation = Problem(
    title: "That automation is gone",
    message: "It was deleted, or its project archived. Edit the shortcut and pick another automation.",
    retry: false,
    symbol: "bolt.slash"
  )

  /// In one line, as Shortcuts shows an action's error.
  var line: String { "\(title). \(message)" }
}

/// The pairing an action signs in with: not paired and locked say so, rather than "unreachable".
func pairing(_ stored: Stored) throws -> Pairing {
  switch stored {
  case .locked: throw Problem.locked
  case .missing: throw Problem.unpaired
  case let .found(data):
    guard let p = Pairing.parse(data) else { throw Problem.unpaired }
    return p
  }
}

/// The chats a picker shows, as the share sheet lists them: who spoke last first.
enum Chats {
  /// The chats for these ids, in their order: the known one, or for one not known (the hub didn't answer, or the
  /// list kept is older than the chat), one named by its id alone, which the action then checks with the hub.
  static func resolve(_ ids: [String], known: [ChatTarget]) -> [ChatTarget] {
    ids.compactMap { id in
      if let chat = known.first(where: { $0.id == id }) { return chat }
      guard let ref = ChatRef(id) else { return nil }
      return ChatTarget(machineId: ref.machineId, projectId: ref.projectId, title: "Chat", machine: nil, at: "")
    }
  }

  /// Ids not in `known`: the ones a picker asks the hub for.
  static func missing(_ ids: [String], known: [ChatTarget]) -> [String] {
    ids.filter { id in !known.contains { $0.id == id } }
  }

  /// The list kept between runs, so a shortcut's chat shows its name and Open Chat needs no hub.
  static func encode(_ chats: [ChatTarget]) -> Data {
    let rows: [[String: Any]] = chats.map { c in
      var row: [String: Any] = ["machineId": c.machineId, "projectId": c.projectId, "title": c.title, "at": c.at]
      if let machine = c.machine { row["machine"] = machine }
      return row
    }
    return (try? JSONSerialization.data(withJSONObject: rows)) ?? Data("[]".utf8)
  }

  static func decode(_ data: Data?) -> [ChatTarget] {
    guard let data, let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
    return rows.compactMap { r in
      guard let m = r["machineId"] as? String, let p = r["projectId"] as? String, let title = r["title"] as? String else { return nil }
      return ChatTarget(machineId: m, projectId: p, title: title, machine: r["machine"] as? String, at: r["at"] as? String ?? "")
    }
  }
}

/// The files a shortcut hands Send Message, as they go up.
enum Files {
  /// One as the hub takes it, its type by its name and bytes; nil for one it doesn't, which Intents.swift sends as a
  /// JPEG when it is an image (a HEIC photo), and refuses otherwise.
  static func upload(name: String, data: Data, index: Int) -> Upload? {
    guard let mime = Mime.ofFile(name: name, data: data) else { return nil }
    let kept = name.trimmingCharacters(in: .whitespacesAndNewlines)
    // An image goes with its type's extension; any other keeps its own name, the hub's limit permitting.
    if Mime.ofImage(data) != nil || kept.isEmpty || kept.count > 120 { return Upload(name: Upload.name(kept, mime: mime, index: index), mime: mime, data: data) }
    return Upload(name: kept, mime: mime, data: data)
  }
}

/// One automation to run now: Run now in the app (automation_run).
struct AutomationTarget: Equatable {
  let id: String
  let name: String
  /// The chat it runs in, by name.
  let chat: String
  let paused: Bool

  /// A project's automations from automation_list, by name.
  static func from(list output: [String: Any], chat: ChatTarget) -> [AutomationTarget] {
    (output["automations"] as? [[String: Any]] ?? []).compactMap { a in
      guard let id = a["automationId"] as? String, let name = a["name"] as? String else { return nil }
      return AutomationTarget(id: id, name: name, chat: chat.title, paused: a["paused"] as? Bool == true)
    }
  }

  /// Every chat's automations, by name, then chat.
  static func sorted(_ all: [AutomationTarget]) -> [AutomationTarget] {
    all.sorted { a, b in
      let byName = a.name.localizedStandardCompare(b.name)
      return byName != .orderedSame ? byName == .orderedAscending : a.chat.localizedStandardCompare(b.chat) == .orderedAscending
    }
  }

  static func search(_ all: [AutomationTarget], _ query: String) -> [AutomationTarget] {
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if q.isEmpty { return all }
    let fold = { (s: String) in s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
    return all.filter { fold($0.name).contains(fold(q)) || fold($0.chat).contains(fold(q)) }
  }

  static func encode(_ all: [AutomationTarget]) -> Data {
    let rows = all.map { ["id": $0.id, "name": $0.name, "chat": $0.chat, "paused": $0.paused] as [String: Any] }
    return (try? JSONSerialization.data(withJSONObject: rows)) ?? Data("[]".utf8)
  }

  static func decode(_ data: Data?) -> [AutomationTarget] {
    guard let data, let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
    return rows.compactMap { r in
      guard let id = r["id"] as? String, let name = r["name"] as? String else { return nil }
      return AutomationTarget(id: id, name: name, chat: r["chat"] as? String ?? "", paused: r["paused"] as? Bool == true)
    }
  }
}

/// The lead's turn after a message, from the hub's events, as `fleetd chat --wait` follows it: done once the lead
/// stops working after it worked or replied. What it said is read from the chat then, whole.
struct ReplyWatch {
  let chat: ChatRef
  /// The sent message's seq: the reply comes after it.
  let after: Int
  private(set) var worked = false
  private(set) var replied = false
  private(set) var done = false

  init(chat: ChatRef, after: Int) {
    self.chat = chat
    self.after = after
  }

  mutating func take(_ type: String, _ data: [String: Any]) {
    guard let ref = data["projectRef"] as? [String: Any], ref["machineId"] as? String == chat.machineId,
          ref["projectId"] as? String == chat.projectId else { return }
    switch type {
    case "chat.message":
      if data["author"] as? String == "lead", data["state"] as? String == "final", (data["seq"] as? Int ?? 0) > after { replied = true }
    case "chat.waiting":
      if data["leadWorking"] as? Bool == true { worked = true } else if worked || replied { done = true }
    default:
      break
    }
  }
}

/// One message as Get Latest Messages returns it.
struct Said: Equatable {
  let author: String
  let text: String
  let at: Date
}

enum Messages {
  /// A chat_history page's messages with words, oldest first: the person's are "You", the lead's the chat's name, an
  /// agent's its key's name. Cards (an approval, a secret) and fleetd's own lines are left out.
  static func said(_ history: [String: Any], chat: String) -> [Said] {
    (history["messages"] as? [[String: Any]] ?? []).compactMap { m in
      guard m["item"] == nil, m["state"] as? String != "streaming", let text = m["text"] as? String,
            !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, let at = date(m["createdAt"] as? String) else { return nil }
      switch m["author"] as? String {
      case "human": return Said(author: "You", text: text, at: at)
      case "lead": return Said(author: chat, text: text, at: at)
      case "agent": return Said(author: m["by"] as? String ?? "Agent", text: text, at: at)
      default: return nil
      }
    }
  }

  /// The newest `count` of them, at or after `since` when given, oldest first.
  static func latest(_ said: [Said], count: Int, since: Date?) -> [Said] {
    let kept = since.map { s in said.filter { $0.at >= s } } ?? said
    return Array(kept.suffix(max(1, count)))
  }

  /// The messages as one text, each with who wrote it, as Get Latest Messages says them: a dialog shows no line breaks.
  static func spoken(_ said: [Said]) -> String {
    said.isEmpty ? "No messages yet." : said.map { "\($0.author): \($0.text)" }.joined(separator: " · ")
  }

  /// The lead's reply to message `after`: its final messages after it, in order, as one text.
  static func reply(_ history: [String: Any], after: Int) -> String {
    (history["messages"] as? [[String: Any]] ?? [])
      .filter { $0["author"] as? String == "lead" && $0["state"] as? String == "final" && ($0["seq"] as? Int ?? 0) > after }
      .compactMap { ($0["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
      .joined(separator: "\n\n")
  }

  /// ISO 8601, with or without fractions of a second, as the hub writes it.
  static func date(_ text: String?) -> Date? {
    guard let text else { return nil }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: text) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: text)
  }
}

/// One request waiting on the person, as Get Waiting Approvals lists it: what it asks and where.
struct Waiting: Equatable {
  let title: String
  let chat: String

  /// requests_list's open requests, oldest first, each with its chat's name.
  static func from(_ output: [String: Any], chats: [ChatTarget]) -> [Waiting] {
    (output["requests"] as? [[String: Any]] ?? []).compactMap { r in
      guard r["state"] as? String == nil || r["state"] as? String == "open", let text = r["text"] as? String else { return nil }
      let ref = r["projectRef"] as? [String: Any]
      let id = "\(ref?["machineId"] as? String ?? "")/\(ref?["projectId"] as? String ?? "")"
      let what = r["kind"] as? String == "secret" ? "Secret: \(text)" : text
      return Waiting(title: what, chat: chats.first { $0.id == id }?.title ?? "A chat")
    }
  }

  var line: String { "\(title) (\(chat))" }

  /// What the action says: how many, then each.
  static func summary(_ all: [Waiting]) -> String {
    if all.isEmpty { return "Nothing is waiting on you." }
    let head = all.count == 1 ? "1 thing is waiting on you" : "\(all.count) things are waiting on you"
    return "\(head): " + all.map(\.line).joined(separator: "; ") + "."
  }
}

/// The actions' calls to the hub, each on a link of its own (`link` makes one: HubLink, or a fake in tests) that
/// closes after it.
@MainActor
enum Run {
  typealias Link = () throws -> HubCalls

  /// The longest Wait for Reply, from the action's start: iOS ends an action that runs past about 30 seconds, and
  /// reading the reply takes a few. Past this the reply shows in the chat.
  static let waitMax = 20

  /// Sends `text` and `files` to the chat as the person, from Shortcuts; with `wait`, the lead's reply, waited for up
  /// to that many seconds from the start. nil without a wait.
  static func send(_ link: Link, pairing p: Pairing, chat id: String, text: String, files: [Upload] = [], wait: Int?, requestId: String) async throws -> String? {
    let started = Date()
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty && files.isEmpty { throw Problem.empty }
    if files.count > Limits.files { throw Problem.tooManyFiles }
    if let tooLarge = files.lazy.compactMap(\.tooLarge).first { throw Problem.tooLarge(tooLarge) }
    guard let ref = ChatRef(id) else { throw Problem.noChat(p) }
    let hub = try link()
    defer { hub.close() }
    let chats = try await hub.open()
    guard let chat = chats.first(where: { $0.id == id }) else { throw Problem.noChat(p) }
    if wait != nil { try await hub.subscribe() }
    var attachments: [String] = []
    for file in files { attachments.append(try await hub.upload(file)) }
    let sent = try await hub.chatSend(Calls.send(chat, text: text, attachments: attachments, requestId: requestId, client: .shortcuts), client: .shortcuts)
    guard let wait else { return nil }
    let seconds = min(max(wait, 1), waitMax)
    let seq = (sent["message"] as? [String: Any])?["seq"] as? Int ?? 0
    var watch = ReplyWatch(chat: ref, after: seq)
    let until = started.addingTimeInterval(Double(seconds))
    while !watch.done, let (type, data) = try await hub.event(until: until) {
      watch.take(type, data)
    }
    // Time ran out: that link is closed, and a new one reads what came.
    let reader = watch.done ? hub : try link()
    defer { if reader !== hub { reader.close() } }
    if reader !== hub { _ = try await reader.open() }
    let reply = Messages.reply(try await reader.call("chat_history", ["projectRef": ref.projectRef, "after": seq, "limit": 100]), after: seq)
    if reply.isEmpty { throw Problem.noReply(chat.title, seconds: seconds) }
    return reply
  }

  /// The chat's newest messages.
  static func latest(_ link: Link, pairing p: Pairing, chat id: String, count: Int, since: Date?) async throws -> [Said] {
    guard let ref = ChatRef(id) else { throw Problem.noChat(p) }
    let hub = try link()
    defer { hub.close() }
    let chats = try await hub.open()
    guard let chat = chats.first(where: { $0.id == id }) else { throw Problem.noChat(p) }
    let page = try await hub.call("chat_history", ["projectRef": ref.projectRef, "limit": since == nil ? min(max(count, 1) * 2, 100) : 100])
    return Messages.latest(Messages.said(page, chat: chat.title), count: count, since: since)
  }

  /// What waits on the person: the open requests, each with its chat. Read only: nothing is answered here.
  static func waiting(_ link: Link) async throws -> [Waiting] {
    let hub = try link()
    defer { hub.close() }
    let chats = try await hub.open()
    return Waiting.from(try await hub.call("requests_list", ["state": "open", "limit": 100]), chats: chats)
  }

  /// The chats, for a picker.
  static func chats(_ link: Link) async throws -> [ChatTarget] {
    let hub = try link()
    defer { hub.close() }
    return try await hub.open()
  }

  /// Every chat's automations; a chat whose list the hub refuses (the key can't read it) has none.
  static func automations(_ link: Link) async throws -> [AutomationTarget] {
    let hub = try link()
    defer { hub.close() }
    var all: [AutomationTarget] = []
    for chat in try await hub.open() {
      do {
        all += AutomationTarget.from(list: try await hub.call("automation_list", ["projectRef": ["machineId": chat.machineId, "projectId": chat.projectId]]), chat: chat)
      } catch let problem as Problem where problem.code != nil {
        continue
      }
    }
    return AutomationTarget.sorted(all)
  }

  /// Runs one now, as Run now in the app does.
  static func automation(_ link: Link, id: String) async throws {
    let hub = try link()
    defer { hub.close() }
    _ = try await hub.open()
    do {
      _ = try await hub.call("automation_run", ["automationId": id])
    } catch let problem as Problem where problem.code == "not_found" {
      throw Problem.noAutomation
    }
  }
}
