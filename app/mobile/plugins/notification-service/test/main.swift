// The extension's sealed-box opener against the hub's own boxes (src/push.fixture.json), with CryptoKit's X25519 as
// on the phone. mobile.yml's iOS job runs it on macOS:
//   swiftc plugins/notification-service/Sealed.swift plugins/notification-service/test/main.swift -o sealed-test
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
  sealed[sealed.count - 1] ^= 1
  if Sealed.open(sealed, secretKey: secretKey) != nil {
    print("case \(i): opened with a changed byte")
    failures += 1
  }
}
if failures > 0 { exit(1) }
print("The hub's sealed boxes open.")
