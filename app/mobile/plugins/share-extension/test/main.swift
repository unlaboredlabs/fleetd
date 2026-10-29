// The Share Extension's decisions (Shared.swift): the pairing it reads and the not-paired path, the hub's frames, the
// chats it offers, and what it sends. mobile.yml's iOS job runs it on macOS (it builds on Linux too):
//   swiftc plugins/share-extension/Shared.swift plugins/share-extension/test/main.swift -o share-test && ./share-test
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

// Not paired: nothing stored, or what is stored isn't a pairing, says so and offers only the app.
for stored in [nil, json(""), json("not json"), json("[]"), json(#"{"hub":"http://devbox:4790"}"#), json(#"{"hub":"","key":"k"}"#)] {
  check(Pairing.parse(stored) == nil, "\(stored.map { String(decoding: $0, as: UTF8.self) } ?? "nil") read as a pairing")
}
check(!Problem.notPaired.retry && Problem.notPaired.title == "Pair fleetd first", "not paired offers a retry")

// Paired, as src/vault.ts stores it.
let paired = Pairing.parse(json(#"{"hub":"http://devbox:4790","key":"fk_test","hubName":"devbox"}"#))
check(paired == Pairing(hub: "http://devbox:4790", key: "fk_test", hubName: "devbox"), "the pairing didn't read")
check(paired?.socketURL?.absoluteString == "ws://devbox:4790/app", "socket URL")
check(Pairing.parse(json(#"{"hub":"https://hub.example.com/","key":"k"}"#))?.socketURL?.absoluteString == "wss://hub.example.com/app", "TLS socket URL")
check(Pairing.parse(json(#"{"hub":"https://hub.example.com","key":"k"}"#))?.hubName == "https://hub.example.com", "no hubName names it by its address")
check(Pairing(hub: "devbox:4790", key: "k", hubName: "d").socketURL == nil, "a hub without a scheme")
check(Problem.unreachable(paired!).retry && Problem.unreachable(paired!).message.hasPrefix("devbox:4790 didn't answer"), "unreachable")
check(!Problem.refused(paired!).retry, "a refused key offers a retry")

// Frames.
if case .ready? = Frame.parse(json(#"{"t":"ready","protocol":9}"#)) {} else { check(false, "ready") }
if case let .result(id, output)? = Frame.parse(json(#"{"t":"result","id":"s2","output":{"attachmentId":"F7"}}"#)) {
  check(id == "s2" && output["attachmentId"] as? String == "F7", "result")
} else { check(false, "result") }
if case let .error(id, code, message, fix)? = Frame.parse(json(#"{"t":"error","code":"unauthorized","message":"Unknown key."}"#)) {
  check(id == nil && code == "unauthorized" && message == "Unknown key." && fix == nil, "auth error")
} else { check(false, "auth error") }
check(Frame.parse(json(#"{"t":"event","seq":3}"#)) == nil && Frame.parse(json("nope")) == nil, "frames it doesn't read")

// Chats: who spoke last first; a Navi's archive hides it; a project shows its machine.
let snapshot = try! JSONSerialization.jsonObject(with: json("""
{"t":"snapshot","cursor":1,"attention":[],
 "machines":[{"machineId":"m1","name":"devbox"}],
 "projects":[
  {"machineId":"m1","projectId":"p1","title":"billing-api","lastActivityAt":"2026-10-29T10:00:00Z"},
  {"machineId":"m1","projectId":"p2","title":"Inbox","kind":"assistant","lastActivityAt":"2026-10-20T10:00:00Z"},
  {"machineId":"m1","projectId":"p3","title":"Old Navi","kind":"assistant","archivedAt":"2026-10-01T00:00:00Z","lastActivityAt":"2026-10-29T12:00:00Z"},
  {"machineId":"m2","projectId":"p4","title":"Résumé site","lastActivityAt":"2026-10-28T10:00:00Z"}],
 "chats":[{"projectRef":{"machineId":"m1","projectId":"p2"},"lastMessageAt":"2026-10-29T11:00:00Z","lastSeq":4,"leadWorking":false,"needsYou":false}]}
""")) as! [String: Any]
let chats = ChatTarget.from(snapshot: snapshot)
check(chats.map(\.title) == ["Inbox", "billing-api", "Résumé site"], "order: \(chats.map(\.title))")
check(chats.map(\.subtitle) == ["Navi", "devbox", "Project"], "subtitles: \(chats.map(\.subtitle))")
check(chats.first?.id == "m1/p2", "id")
check(ChatTarget.search(chats, "resume").map(\.title) == ["Résumé site"], "search ignores case and accents")
check(ChatTarget.search(chats, "DEVBOX").map(\.title) == ["billing-api"], "search finds a machine")
check(ChatTarget.search(chats, "  ").count == 3, "an empty search")

// Avatars, as src/avatar.ts draws them.
for (name, initials, tint) in [("Ada", "A", 5), ("billing-api", "BA", 5), ("Léa's Navi", "LS", 5), ("fleetd", "F", 7), ("Inbox", "I", 9)] {
  check(Avatar.initials(name) == initials && Avatar.tint(name, count: 10) == tint, "avatar of \(name): \(Avatar.initials(name)) \(Avatar.tint(name, count: 10))")
}

// Images: the types the hub takes go as they are; the rest as JPEG, named for it.
check(Mime.ofImage(Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0])) == .png, "png")
check(Mime.ofImage(Data([0xFF, 0xD8, 0xFF, 0xE0])) == .jpeg, "jpeg")
check(Mime.ofImage(Data("GIF89a..".utf8)) == .gif, "gif")
check(Mime.ofImage(Data("RIFF\0\0\0\0WEBPVP8 ".utf8)) == .webp, "webp")
check(Mime.ofImage(Data([0, 0, 0, 0x18] + Array("ftypheic".utf8))) == nil, "heic goes as JPEG")
check(Upload.name("IMG_0042.HEIC", mime: .jpeg, index: 0) == "IMG_0042.jpg", "renamed for its type")
check(Upload.name(nil, mime: .png, index: 2) == "image-3.png", "unnamed")
check(Upload.name(String(repeating: "a", count: 300), mime: .png, index: 0).count <= 120, "a long name")

// Size limits and pieces.
let piece = Limits.pieceBytes
for (size, counts) in [(0, [0]), (10, [10]), (piece, [piece]), (piece + 1, [piece, 1]), (2 * piece + 5, [piece, piece, 5])] {
  let up = Upload(name: "a.png", mime: .png, data: Data(count: size))
  check(up.pieceRanges.map(\.count) == counts, "pieces of \(size): \(up.pieceRanges.map(\.count))")
  check(up.pieceRanges.map { up.data.subdata(in: $0) }.reduce(Data(), +) == up.data, "pieces of \(size) join")
}
check(Upload(name: "a.png", mime: .png, data: Data(count: Limits.fileBytes)).tooLarge == nil, "25 MB is allowed")
// Thumbnails stay small: 20 of them, decoded at their largest, under 8 MB together.
check(Thumbnail.side(images: 1) * Thumbnail.side(images: 1) * 4 < 2 * 1_048_576, "one thumbnail")
check(20 * Thumbnail.side(images: 20) * Thumbnail.side(images: 20) * 4 < 8 * 1_048_576, "20 thumbnails")
check(!Problem.tooLarge("x").retry && !Problem.unreadable("IMG_1.HEIC").retry, "a file problem offers a retry")
check(Upload(name: "big.png", mime: .png, data: Data(count: Limits.fileBytes + 1)).tooLarge == "big.png is 25.0 MB; fleetd takes files up to 25 MB.", "over 25 MB")

// The message.
let page = SharedLink(url: URL(string: "https://example.com/post")!, title: "A post")
check(Outgoing.build(note: " Read this ", texts: [], links: [page], images: 0) == Outgoing(text: "Read this\n\nA post\nhttps://example.com/post", textFile: nil), "note and link")
check(Outgoing.build(note: "", texts: ["https://example.com/post"], links: [page], images: 0).text == "A post\nhttps://example.com/post", "a link shared as text too")
check(Outgoing.build(note: "", texts: ["see https://example.com/post"], links: [page], images: 0).text == "see https://example.com/post", "a link inside the text")
check(Outgoing.build(note: "", texts: [], links: [SharedLink(url: page.url, title: nil)], images: 0).text == "https://example.com/post", "an untitled link")
check(Outgoing.build(note: "", texts: [], links: [], images: 1).text == "Shared an image.", "an image alone")
check(Outgoing.build(note: "", texts: [], links: [], images: 3).text == "Shared 3 images.", "images alone")
check(Outgoing.build(note: "Look", texts: [], links: [], images: 3).text == "Look", "images with a note")
let long = String(repeating: "x", count: Limits.textChars + 1)
let longOut = Outgoing.build(note: "From my notes", texts: [long], links: [], images: 0)
check(longOut.text == "From my notes" && longOut.textFile?.data.count == Limits.textChars + 1 && longOut.textFile?.name == "shared.txt", "long text goes as a file")
check(Outgoing.build(note: "", texts: [long], links: [], images: 0).text == "Shared a long text, attached.", "long text alone")
check(Outgoing.build(note: "", texts: [String(repeating: "y", count: Limits.textChars)], links: [], images: 0).textFile == nil, "text at the limit")

// The tools' inputs.
let chat = chats[0]
check(object(Calls.send(chat, text: "hi", attachments: ["F1", "F2"], requestId: "share-1"))
  == #"{"attachments":["F1","F2"],"clientRequestId":"share-1","projectRef":{"machineId":"m1","projectId":"p2"},"text":"hi"}"#, "chat_send")
check(object(Calls.send(chat, text: "hi", attachments: [], requestId: "share-1"))
  == #"{"clientRequestId":"share-1","projectRef":{"machineId":"m1","projectId":"p2"},"text":"hi"}"#, "chat_send without files")
let file = Upload(name: "a.png", mime: .png, data: Data("abc".utf8))
check(object(Calls.part(Data("ab".utf8), uploadId: nil, offset: 0)) == #"{"dataB64":"YWI="}"#, "first piece")
check(object(Calls.part(Data("ab".utf8), uploadId: "U1", offset: 2)) == #"{"dataB64":"YWI=","offset":2,"uploadId":"U1"}"#, "next piece")
check(object(Calls.put(file, last: file.data, uploadId: nil)) == #"{"dataB64":"YWJj","mime":"image\/png","name":"a.png"}"#, "whole file")
check(object(Calls.put(file, last: Data("c".utf8), uploadId: "U1")) == #"{"dataB64":"Yw==","mime":"image\/png","name":"a.png","uploadId":"U1"}"#, "last piece")

if failures > 0 { exit(1) }
print("The share extension's decisions hold.")
