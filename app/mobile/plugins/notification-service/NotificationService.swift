// The Notification Service Extension (D218). The relay's APNs alert says only "fleetd: New
// activity", with the sealed payload in `c` and mutable-content, so iOS hands it here before it shows: this opens
// `c` with the phone's secret key, from the keychain group it shares with the app (src/vault.ts), and sets the title,
// the body and the thread (one per chat, so a chat's notifications stack), the buttons (a category the app registers)
// and the app icon's badge, drops the sound inside quiet hours and makes an urgent one time-sensitive. A chat muted on
// this phone (the app keeps the list in the same keychain group) arrives quietly, unless it is urgent.
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
    let muted = shown.muted(in: PushKey.mutedChats())
    if shown.quiet || muted { content.sound = nil }
    if shown.urgent, #available(iOS 15.0, *) { content.interruptionLevel = .timeSensitive }
    if muted, #available(iOS 15.0, *) { content.interruptionLevel = .passive }
    contentHandler(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let content { contentHandler(content) }
  }
}

/// What the app keeps for the extension, as expo-secure-store keeps it: service "fleetd.push:no-auth", the item's name
/// as its account.
enum PushKey {
  /// The phone's secret key: "secretKey", base64.
  static func secretKey() -> [UInt8]? {
    guard let text = item("secretKey"), let key = Data(base64Encoded: text), key.count == 32 else { return nil }
    return [UInt8](key)
  }

  /// The chats muted on this phone: "fleetd.muted-chats", a JSON array of "machineId/projectId". Missing or
  /// unreadable: none.
  static func mutedChats() -> Set<String> {
    guard let text = item("fleetd.muted-chats"),
          let chats = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [Any] else { return [] }
    return Set(chats.compactMap { $0 as? String })
  }

  private static func item(_ account: String) -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "fleetd.push:no-auth",
      kSecAttrAccount as String: Data(account.utf8),
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }
}
