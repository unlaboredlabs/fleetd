// The Notification Service Extension (docs/design/push.md, D218). The relay's APNs alert says only "fleetd: New
// activity", with the sealed payload in `c` and mutable-content, so iOS hands it here before it shows: this opens
// `c` with the phone's secret key, from the keychain group it shares with the app (src/vault.ts), and sets the title,
// the body and the thread (one per chat, so a chat's notifications stack), the buttons (a category the app registers)
// and the app icon's badge, drops the sound inside quiet hours and makes an urgent one time-sensitive.
// Anything it can't open shows the generic text (Payload.swift), set here rather than kept from what came, and
// nothing else of it.
import Foundation
import Security
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var content: UNMutableNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
    self.contentHandler = contentHandler
    self.content = content
    let shown = Payload.shown(request.content.userInfo["c"] as? String, secretKey: PushKey.secretKey())
    content.title = shown.title
    content.subtitle = ""
    content.body = shown.body
    content.attachments = []
    if let thread = shown.thread { content.threadIdentifier = thread }
    content.categoryIdentifier = shown.category ?? ""
    if let badge = shown.badge { content.badge = NSNumber(value: badge) }
    if shown.quiet { content.sound = nil }
    if shown.urgent, #available(iOS 15.0, *) { content.interruptionLevel = .timeSensitive }
    contentHandler(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let content { contentHandler(content) }
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
