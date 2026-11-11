// The Shortcuts actions' decisions (Actions.swift): their links, the pickers' chats and automations, Send Message
// and its files, errors and wait, the latest messages and the waiting approvals, against a fake hub. mac.yml's
// `mobile (ios)` job runs it (it builds on Linux too):
//   swiftc plugins/share-extension/Shared.swift plugins/app-intents/Actions.swift plugins/app-intents/test/main.swift \
//     -o actions-test && ./actions-test
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String, line: Int = #line) {
  if !ok {
    print("line \(line): \(what)")
    failures += 1
  }
}
func json(_ text: String) -> Data { Data(text.utf8) }
func object(_ input: [String: Any]) -> String {
  String(decoding: try! JSONSerialization.data(withJSONObject: input, options: [.sortedKeys]), as: UTF8.self)
}

/// A hub that answers each tool as told, and records what it was asked.
@MainActor
final class FakeHub: HubCalls {
  var chats: [ChatTarget]
  var openError: Problem?
  var answers: [String: ([String: Any]) throws -> [String: Any]] = [:]
  var events: [(type: String, data: [String: Any])] = []
  private(set) var calls: [(tool: String, input: [String: Any])] = []
  private(set) var subscribed = false
  private(set) var closed = false

  init(_ chats: [ChatTarget]) { self.chats = chats }

  func open() async throws -> [ChatTarget] {
    if let openError { throw openError }
    return chats
  }

  func call(_ tool: String, _ input: [String: Any]) async throws -> [String: Any] {
    calls.append((tool, input))
    guard let answer = answers[tool] else { throw Problem.hub(code: "not_found", message: "No tool \(tool).", fix: nil) }
    return try answer(input)
  }

  func subscribe() async throws { subscribed = true }

  func event(until: Date) async throws -> (type: String, data: [String: Any])? {
    events.isEmpty ? nil : events.removeFirst()
  }

  func close() { closed = true }
}

func problem(_ run: () async throws -> Void) async -> Problem? {
  do {
    try await run()
    return nil
  } catch {
    return error as? Problem
  }
}

let devbox = Pairing(hub: "http://devbox:4790", key: "fk_test", hubName: "devbox")
let inbox = ChatTarget(machineId: "m1", projectId: "p2", title: "Inbox", navi: true, machine: nil, at: "2026-10-29T11:00:00Z")
let billing = ChatTarget(machineId: "m1", projectId: "p1", title: "billing-api", navi: false, machine: "devbox", at: "2026-10-29T10:00:00Z")
let ref = { (c: ChatTarget) in ["machineId": c.machineId, "projectId": c.projectId] }

// Links: a chat's opens it, Needs You opens the approvals.
check(Links.chat("m1/p2")?.absoluteString == "fleetd://chat?machine=m1&project=p2", "chat link: \(Links.chat("m1/p2")?.absoluteString ?? "nil")")
check(Links.chat("m 1/a&b")?.absoluteString == "fleetd://chat?machine=m%201&project=a%26b", "a chat link is encoded")
check(Links.chat("p2") == nil && Links.chat("/p2") == nil && Links.chat("m1/") == nil, "a chat id that isn't one")
check(Links.approvals.absoluteString == "fleetd://approvals", "approvals link")

// The pairing: locked and unpaired say so, rather than "can't reach".
check(await problem { _ = try pairing(.locked) } == .locked, "locked")
check(await problem { _ = try pairing(.missing) } == .unpaired, "not paired")
check(await problem { _ = try pairing(.found(json(#"{"hub":""}"#))) } == .unpaired, "stored but no pairing")
check((try? pairing(.found(json(#"{"hub":"http://devbox:4790","key":"fk_test","hubName":"devbox"}"#)))) == devbox, "paired")
check(Problem.locked.line == "Unlock your iPhone. fleetd's key to your hub opens once this iPhone has been unlocked since it started. Unlock it, then run the shortcut again.", "one line")

// The chat picker: what's known keeps its name; an unknown id is named by itself, for the hub to check.
let resolved = Chats.resolve(["m1/p1", "m9/p9", "bad"], known: [inbox, billing])
check(resolved.map(\.title) == ["billing-api", "Chat"] && resolved.last?.id == "m9/p9", "resolve: \(resolved.map(\.id))")
check(Chats.missing(["m1/p1", "m9/p9"], known: [inbox, billing]) == ["m9/p9"], "missing")
check(Chats.decode(Chats.encode([inbox, billing])) == [inbox, billing], "the kept list reads back")
check(Chats.decode(nil).isEmpty && Chats.decode(json("{}")).isEmpty, "no kept list")

// The automation picker: each chat's, by name, searchable by name or chat.
let listed = AutomationTarget.from(list: try! JSONSerialization.jsonObject(with: json("""
{"automations":[{"automationId":"A2","name":"Weekly report","paused":true},{"automationId":"A1","name":"Morning brief"},{"name":"no id"}],
 "memoryRefresh":{"on":true}}
""")) as! [String: Any], chat: inbox)
check(listed == [AutomationTarget(id: "A2", name: "Weekly report", chat: "Inbox", paused: true), AutomationTarget(id: "A1", name: "Morning brief", chat: "Inbox", paused: false)], "listed: \(listed)")
let everyAutomation = AutomationTarget.sorted(listed + [AutomationTarget(id: "A3", name: "morning brief", chat: "billing-api", paused: false)])
check(everyAutomation.map(\.id) == ["A3", "A1", "A2"] || everyAutomation.map(\.id) == ["A1", "A3", "A2"], "sorted: \(everyAutomation.map(\.id))")
check(AutomationTarget.search(everyAutomation, "BILLING").map(\.id) == ["A3"] && AutomationTarget.search(everyAutomation, " ").count == 3, "search")
check(AutomationTarget.decode(AutomationTarget.encode(listed)) == listed, "the kept automations read back")

// The reply: done once the lead stops after working or replying, in this chat only.
var watch = ReplyWatch(chat: ChatRef("m1/p2")!, after: 7)
watch.take("chat.waiting", ["projectRef": ref(inbox), "leadWorking": false])
check(!watch.done, "idle before it started isn't done")
watch.take("chat.waiting", ["projectRef": ref(billing), "leadWorking": true])
watch.take("chat.message", ["projectRef": ref(inbox), "author": "lead", "state": "final", "seq": 6])
check(!watch.worked && !watch.replied, "another chat, an older message")
watch.take("chat.waiting", ["projectRef": ref(inbox), "leadWorking": true])
watch.take("chat.message", ["projectRef": ref(inbox), "author": "lead", "state": "streaming", "seq": 8])
check(watch.worked && !watch.replied && !watch.done, "working, still writing")
watch.take("chat.waiting", ["projectRef": ref(inbox), "leadWorking": false])
check(watch.done, "the turn ended")

// Messages: who said what, the newest, the reply after the sent one.
let page = try! JSONSerialization.jsonObject(with: json("""
{"messages":[
 {"seq":5,"author":"human","text":"Morning","state":"final","createdAt":"2026-11-03T08:00:00Z"},
 {"seq":6,"author":"lead","text":"Morning! Two things today.","state":"final","createdAt":"2026-11-03T08:00:05.120Z"},
 {"seq":7,"author":"lead","text":"","state":"final","item":{"kind":"command_approval"},"createdAt":"2026-11-03T08:01:00Z"},
 {"seq":8,"author":"system","text":"Remembered: coffee","state":"final","createdAt":"2026-11-03T08:02:00Z"},
 {"seq":9,"author":"agent","by":"scout","text":"CI is green","state":"final","createdAt":"2026-11-03T08:03:00Z"},
 {"seq":10,"author":"lead","text":"Shipping","state":"streaming","createdAt":"2026-11-03T08:04:00Z"}],
 "moreBefore":false,"moreAfter":false}
""")) as! [String: Any]
let said = Messages.said(page, chat: "Inbox")
check(said.map(\.author) == ["You", "Inbox", "scout"] && said[1].text == "Morning! Two things today.", "said: \(said.map(\.author))")
check(Messages.latest(said, count: 2, since: nil).map(\.author) == ["Inbox", "scout"], "the newest two")
check(Messages.latest(said, count: 10, since: Messages.date("2026-11-03T08:00:05Z")).map(\.author) == ["Inbox", "scout"], "since a time")
check(Messages.latest(said, count: 0, since: nil).count == 1, "at least one")
check(Messages.spoken(Messages.latest(said, count: 2, since: nil)) == "Inbox: Morning! Two things today. · scout: CI is green", "said aloud")
check(Messages.spoken([]) == "No messages yet.", "nothing said")
check(Messages.reply(page, after: 5) == "Morning! Two things today.", "the reply: \(Messages.reply(page, after: 5))")
check(Messages.reply(page, after: 6) == "", "no reply after it")

// Waiting approvals: what each asks, and where.
let open = try! JSONSerialization.jsonObject(with: json("""
{"requests":[
 {"requestId":"R1","projectRef":{"machineId":"m1","projectId":"p1"},"kind":"approval","text":"Run the migration","state":"open"},
 {"requestId":"R2","projectRef":{"machineId":"m1","projectId":"p2"},"kind":"secret","text":"The Stripe test key","state":"open"},
 {"requestId":"R3","projectRef":{"machineId":"m1","projectId":"p2"},"kind":"approval","text":"Done already","state":"approved"}]}
""")) as! [String: Any]
let waiting = Waiting.from(open, chats: [inbox, billing])
check(waiting == [Waiting(title: "Run the migration", chat: "billing-api"), Waiting(title: "Secret: The Stripe test key", chat: "Inbox")], "waiting: \(waiting)")
check(Waiting.summary(waiting) == "2 things are waiting on you: Run the migration (billing-api); Secret: The Stripe test key (Inbox).", Waiting.summary(waiting))
check(Waiting.summary([]) == "Nothing is waiting on you.", "nothing waiting")

// Send Message, as the person from Shortcuts, and each way it fails.
let sent: ([String: Any]) throws -> [String: Any] = { _ in ["message": ["seq": 12]] }
var hub = FakeHub([inbox, billing])
hub.answers["chat_send"] = sent
var links: [FakeHub] = []
let link: () -> FakeHub = { links.append(hub); return hub }
check(try await Run.send(link, pairing: devbox, chat: "m1/p2", text: "  I'm home  ", wait: nil, requestId: "shortcut-1") == nil, "sent, no wait")
check(hub.calls.map(\.tool) == ["chat_send"] && !hub.subscribed && hub.closed, "one send, closed")
check(object(hub.calls[0].input) == #"{"client":"shortcuts","clientRequestId":"shortcut-1","projectRef":{"machineId":"m1","projectId":"p2"},"text":"I'm home"}"#, object(hub.calls[0].input))

check(await problem { _ = try await Run.send(link, pairing: devbox, chat: "m1/p2", text: " \n", wait: nil, requestId: "s") } == .empty, "empty text")
check(await problem { _ = try await Run.send(link, pairing: devbox, chat: "m1/p9", text: "hi", wait: nil, requestId: "s") } == .noChat(devbox), "a chat that's gone")
check(await problem { _ = try await Run.send({ throw Problem.locked }, pairing: devbox, chat: "m1/p2", text: "hi", wait: nil, requestId: "s") } == .locked, "locked")
hub = FakeHub([inbox])
hub.openError = .refused(devbox)
check(await problem { _ = try await Run.send(link, pairing: devbox, chat: "m1/p2", text: "hi", wait: nil, requestId: "s") } == .refused(devbox), "a key the hub refuses: pair again")
hub.openError = .unreachable(devbox)
check(await problem { _ = try await Run.send(link, pairing: devbox, chat: "m1/p2", text: "hi", wait: nil, requestId: "s") }?.title == "Can't reach devbox", "an unreachable hub")
hub = FakeHub([inbox])
hub.answers["chat_send"] = { _ in throw Problem.hub(code: "forbidden", message: "This key can't write to Inbox.", fix: "Ask its owner.") }
let refused = await problem { _ = try await Run.send(link, pairing: devbox, chat: "m1/p2", text: "hi", wait: nil, requestId: "s") }
check(refused?.message == "This key can't write to Inbox. Ask its owner." && hub.calls.count == 1, "the hub's refusal, as it said it")

// Files: each stored in pieces before the message, which carries their ids; only files, no text, is a message too.
hub = FakeHub([inbox])
hub.answers["chat_send"] = sent
hub.answers["attachment_part"] = { _ in ["uploadId": "U1"] }
var stored = 0
hub.answers["attachment_put"] = { _ in stored += 1; return ["attachmentId": "F\(stored)"] }
let pdf = Files.upload(name: "Receipt.pdf", data: Data("%PDF-1.7 ...".utf8), index: 0)!
let big = Upload(name: "scan.zip", mime: .zip, data: Data(repeating: 1, count: Limits.pieceBytes + 10))
check(try await Run.send(link, pairing: devbox, chat: "m1/p2", text: "", files: [pdf, big], wait: nil, requestId: "s") == nil, "files alone")
check(hub.calls.map(\.tool) == ["attachment_put", "attachment_part", "attachment_put", "chat_send"], "uploads first: \(hub.calls.map(\.tool))")
check(object(hub.calls[3].input) == #"{"attachments":["F1","F2"],"client":"shortcuts","clientRequestId":"s","projectRef":{"machineId":"m1","projectId":"p2"},"text":""}"#, object(hub.calls[3].input))
hub = FakeHub([inbox])
let tooMany = Array(repeating: pdf, count: Limits.files + 1)
check(await problem { _ = try await Run.send(link, pairing: devbox, chat: "m1/p2", text: "hi", files: tooMany, wait: nil, requestId: "s") } == .tooManyFiles && hub.calls.isEmpty, "too many files")
let huge = Upload(name: "film.zip", mime: .zip, data: Data(count: Limits.fileBytes + 1))
check(await problem { _ = try await Run.send(link, pairing: devbox, chat: "m1/p2", text: "hi", files: [huge], wait: nil, requestId: "s") }?.title == "Too large to send" && hub.calls.isEmpty, "a file past 25 MB")

// A file's type, as the hub decides it: an image by its bytes, a name its bytes agree with, any UTF-8 text.
let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0])
check(Files.upload(name: "photo.HEIC", data: png, index: 2) == Upload(name: "photo.png", mime: .png, data: png), "an image by its bytes, named for them")
check(Files.upload(name: "photo.heic", data: Data([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), index: 0) == nil, "a HEIC photo isn't taken as it is")
check(Mime.ofFile(name: "notes.md", data: Data("# Hi\n".utf8)) == .text && Mime.ofFile(name: "Makefile", data: Data("all:\n".utf8)) == .text, "text")
check(Mime.ofFile(name: "bank.csv", data: Data([0x63, 0xE9, 0x2C, 0x31])) == .csv, "Windows-1252 CSV")
check(Mime.ofFile(name: "blob.bin", data: Data([0x63, 0xE9, 0x2C, 0x31])) == nil && Mime.ofFile(name: "a.out", data: Data([0x7F, 0x45, 0, 0])) == nil, "not text")
check(Mime.ofFile(name: "fake.pdf", data: Data("hello".utf8)) == nil && Mime.ofFile(name: "deck.pptx", data: Data([0x50, 0x4B, 0x03, 0x04, 1])) == .pptx, "a name its bytes must agree with")
check(Files.upload(name: "Q3 report.docx", data: Data([0x50, 0x4B, 0x03, 0x04]), index: 0)?.name == "Q3 report.docx", "a document keeps its name")

// A hub from before Shortcuts' client takes it as from the app, once, with the same request id.
hub = FakeHub([inbox])
hub.answers["chat_send"] = { input in
  if input["client"] != nil { throw Problem.hub(code: "invalid", message: "chat_send: unknown variant `shortcuts`, expected one of `app`, `cli`", fix: nil) }
  return ["message": ["seq": 3]]
}
check(try await Run.send(link, pairing: devbox, chat: "m1/p2", text: "hi", wait: nil, requestId: "s") == nil, "an older hub")
check(hub.calls.count == 2 && hub.calls[1].input["client"] == nil && hub.calls[1].input["clientRequestId"] as? String == "s", "sent again without client")

// Wait for Reply: subscribed before the send; the reply read from the chat once the turn ends.
let history = { (_: [String: Any]) -> [String: Any] in
  ["messages": [["seq": 12, "author": "human", "text": "hi", "state": "final"], ["seq": 13, "author": "lead", "text": "On it.", "state": "final"], ["seq": 14, "author": "lead", "text": "Done: the lights are on.", "state": "final"]]]
}
hub = FakeHub([inbox])
hub.answers["chat_send"] = sent
hub.answers["chat_history"] = history
hub.events = [("chat.waiting", ["projectRef": ref(inbox), "leadWorking": true]), ("chat.message", ["projectRef": ref(inbox), "author": "lead", "state": "final", "seq": 13]), ("chat.waiting", ["projectRef": ref(inbox), "leadWorking": false])]
links = []
check(try await Run.send(link, pairing: devbox, chat: "m1/p2", text: "hi", wait: 60, requestId: "s") == "On it.\n\nDone: the lights are on.", "the reply")
check(hub.subscribed && hub.calls.map(\.tool) == ["chat_send", "chat_history"] && links.count == 1, "one link: \(hub.calls.map(\.tool))")
check(object(hub.calls[1].input) == #"{"after":12,"limit":100,"projectRef":{"machineId":"m1","projectId":"p2"}}"#, object(hub.calls[1].input))

// Out of time: what came is read on a new link; nothing yet says so, and the message stays sent.
hub.events = [("chat.waiting", ["projectRef": ref(inbox), "leadWorking": true])]
links = []
check(try await Run.send(link, pairing: devbox, chat: "m1/p2", text: "hi", wait: 5, requestId: "s") == "On it.\n\nDone: the lights are on.", "a reply that came as time ran out")
check(links.count == 2, "read on a new link")
hub.answers["chat_history"] = { _ in ["messages": []] }
check(await problem { _ = try await Run.send(link, pairing: devbox, chat: "m1/p2", text: "hi", wait: 5000, requestId: "s") } == .noReply("Inbox", seconds: 20), "no reply within the longest wait")

// Get Latest Messages and Get Waiting Approvals read only.
hub = FakeHub([inbox])
hub.answers["chat_history"] = { _ in page }
check(try await Run.latest(link, pairing: devbox, chat: "m1/p2", count: 2, since: nil).map(\.text) == ["Morning! Two things today.", "CI is green"], "latest")
check(object(hub.calls[0].input) == #"{"limit":4,"projectRef":{"machineId":"m1","projectId":"p2"}}"#, object(hub.calls[0].input))
check(await problem { _ = try await Run.latest(link, pairing: devbox, chat: "m1/p9", count: 2, since: nil) } == .noChat(devbox), "latest of a chat that's gone")
hub = FakeHub([inbox, billing])
hub.answers["requests_list"] = { _ in open }
check(try await Run.waiting(link).count == 2 && hub.calls.map(\.tool) == ["requests_list"], "waiting reads only")

// Run Automation: every chat's listed, one the key can't read skipped; one that's gone says so.
hub = FakeHub([inbox, billing])
hub.answers["automation_list"] = { input in
  if (input["projectRef"] as? [String: String])?["projectId"] == "p1" { throw Problem.hub(code: "forbidden", message: "No.", fix: nil) }
  return ["automations": [["automationId": "A1", "name": "Morning brief"]]]
}
check(try await Run.automations(link) == [AutomationTarget(id: "A1", name: "Morning brief", chat: "Inbox", paused: false)], "automations")
hub.answers["automation_run"] = { input in
  guard input["automationId"] as? String == "A1" else { throw Problem.hub(code: "not_found", message: "No automation.", fix: nil) }
  return ["run": ["state": "running"]]
}
try? await Run.automation(link, id: "A1")
check(hub.calls.last?.tool == "automation_run" && hub.calls.last?.input["automationId"] as? String == "A1", "run now")
check(await problem { try await Run.automation(link, id: "A9") } == .noAutomation, "an automation that's gone")

if failures > 0 { exit(1) }
print("The Shortcuts actions' decisions hold.")
