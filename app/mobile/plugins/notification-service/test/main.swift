// The extension's sealed-box opener against the hub's own boxes (src/push.fixture.json), with CryptoKit's X25519 as
// on the phone, and what it shows: the payload when it opens, only the generic text when it doesn't. mobile.yml's iOS
// job runs it on macOS:
//   swiftc plugins/notification-service/Sealed.swift plugins/notification-service/Payload.swift \
//     plugins/notification-service/test/main.swift -o sealed-test
//   ./sealed-test src/push.fixture.json
import Foundation

let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
let secretKey = [UInt8](Data(base64Encoded: fixture["secretKey"] as! String)!)
var failures = 0
for (i, c) in (fixture["cases"] as! [[String: String]]).enumerated() {
  var sealed = [UInt8](Data(base64Encoded: c["ciphertext"]!)!)
  if Sealed.open(sealed, secretKey: secretKey) != Array(c["plaintext"]!.utf8) {
    print("case \(i): didn't open to its plaintext")
    failures += 1
  }
  let plain = try! JSONSerialization.jsonObject(with: Data(c["plaintext"]!.utf8)) as! [String: Any]
  if Payload.shown(c["ciphertext"], secretKey: secretKey).body != plain["body"] as? String {
    print("case \(i): didn't show its body")
    failures += 1
  }
  sealed[sealed.count - 1] ^= 1
  if Sealed.open(sealed, secretKey: secretKey) != nil {
    print("case \(i): opened with a changed byte")
    failures += 1
  }
  // A push that doesn't open (changed, another key's, from a stranger with the token) shows the generic text only.
  if Payload.shown(Data(sealed).base64EncodedString(), secretKey: secretKey) != Payload.generic
    || Payload.shown(c["ciphertext"], secretKey: [UInt8](repeating: 7, count: 32)) != Payload.generic
    || Payload.shown(c["ciphertext"], secretKey: nil) != Payload.generic {
    print("case \(i): showed what didn't open")
    failures += 1
  }
}
for junk in [nil, "", "not base64!", Data("{\"v\":1,\"title\":\"x\",\"body\":\"y\"}".utf8).base64EncodedString()] {
  if Payload.shown(junk, secretKey: secretKey) != Payload.generic {
    print("\(junk ?? "nil"): showed what didn't open")
    failures += 1
  }
}
if Payload.parse(Data("{\"v\":2,\"title\":\"x\",\"body\":\"y\"}".utf8)) != nil {
  print("a newer version parsed")
  failures += 1
}
// The buttons and the badge: Approve and Deny only where the hub marked them and never for an urgent request.
let marked: [(String, String?)] = [
  (#"{"kind":"approval","requestId":"Q1","category":"approve"}"#, "fleetd.approve"),
  (#"{"kind":"approval","requestId":"Q1","category":"approve","urgent":true}"#, "fleetd.review"),
  (#"{"kind":"approval","requestId":"Q1","category":"review"}"#, "fleetd.review"),
  (#"{"kind":"approval","category":"approve"}"#, nil),
  (#"{"kind":"message","machineId":"devbox","projectId":"navi","category":"reply"}"#, "fleetd.reply"),
  (#"{"kind":"message","category":"reply"}"#, nil),
  (#"{"kind":"order","category":"bounce"}"#, nil),
]
for (fields, want) in marked {
  let json = "{\"v\":1,\"title\":\"Ada\",\"body\":\"Hi\",\"badge\":3," + fields.dropFirst()
  let p = Payload.parse(Data(json.utf8))
  if p?.category != want || p?.badge != 3 {
    print("\(fields): category \(p?.category ?? "nil"), badge \(p?.badge.map(String.init) ?? "nil")")
    failures += 1
  }
}
// A chat muted on this phone arrives quietly, but money or an irreversible command still alerts.
let said = Payload.parse(Data(#"{"v":1,"kind":"message","title":"Ada","body":"Hi","machineId":"devbox","projectId":"ada"}"#.utf8))!
let deploy = Payload.parse(Data(#"{"v":1,"kind":"approval","title":"Shop","body":"Ship","machineId":"devbox","projectId":"ada","requestId":"Q1","urgent":true}"#.utf8))!
if !said.muted(in: ["devbox/ada"]) || said.muted(in: ["devbox/shop"]) || said.muted(in: []) || deploy.muted(in: ["devbox/ada"]) {
  print("muting: wrong")
  failures += 1
}
if failures > 0 { exit(1) }
print("The hub's sealed boxes open.")
