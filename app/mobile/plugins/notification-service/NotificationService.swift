// The Notification Service Extension (docs/design/push.md, D218). The relay's APNs alert says only "fleetd: New
// activity", with the sealed payload in `c` and mutable-content, so iOS hands it here before it shows: this opens
// `c` with the phone's secret key, from the keychain group it shares with the app (src/vault.ts), and sets the title,
// the body and the thread (one per chat), drops the sound inside quiet hours and makes an urgent one time-sensitive.
// Anything it can't open shows as it came.
import Foundation
import Security
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var content: UNMutableNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      return
    }
    self.contentHandler = contentHandler
    self.content = content
    if let sealed = request.content.userInfo["c"] as? String, let payload = Payload.open(sealed) {
      content.title = payload.title
      content.body = payload.body
      if let thread = payload.thread { content.threadIdentifier = thread }
      if payload.quiet { content.sound = nil }
      if payload.urgent, #available(iOS 15.0, *) { content.interruptionLevel = .timeSensitive }
    }
    contentHandler(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let content { contentHandler(content) }
  }
}

/// What the extension takes from the hub's payload.
struct Payload {
  let title: String
  let body: String
  /// "machineId/projectId": the chat's.
  let thread: String?
  let quiet: Bool
  let urgent: Bool

  static func open(_ sealed: String) -> Payload? {
    guard let secretKey = PushKey.secretKey(), let box = Data(base64Encoded: sealed),
          let plain = Sealed.open([UInt8](box), secretKey: secretKey) else { return nil }
    return parse(Data(plain))
  }

  /// Version 1 only: a newer one shows the generic text.
  static func parse(_ json: Data) -> Payload? {
    guard let p = try? JSONSerialization.jsonObject(with: json) as? [String: Any], p["v"] as? Int == 1,
          let title = p["title"] as? String, let body = p["body"] as? String else { return nil }
    let machine = p["machineId"] as? String
    let project = p["projectId"] as? String
    return Payload(
      title: title.isEmpty ? "fleetd" : title,
      body: body,
      thread: machine.flatMap { m in project.map { "\(m)/\($0)" } },
      quiet: p["quiet"] as? Bool == true,
      urgent: p["urgent"] as? Bool == true
    )
  }
}

/// The phone's secret key, as expo-secure-store keeps it: service "fleetd.push:no-auth", account "secretKey", base64.
enum PushKey {
  static func secretKey() -> [UInt8]? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "fleetd.push:no-auth",
      kSecAttrAccount as String: Data("secretKey".utf8),
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data,
          let text = String(data: data, encoding: .utf8), let key = Data(base64Encoded: text), key.count == 32 else { return nil }
    return [UInt8](key)
  }
}
