// What the Notification Service Extension shows (NotificationService.swift, docs/design/push.md): the hub's payload
// once `c` opens with this phone's secret key, else only the generic text. Anyone with the phone's token can reach
// the public relay, so nothing a push that doesn't open carries is ever shown. Foundation only: test/main.swift checks
// it on macOS.
import Foundation

/// What the extension takes from the hub's payload.
struct Payload: Equatable {
  let title: String
  let body: String
  /// "machineId/projectId": the chat's.
  let thread: String?
  let quiet: Bool
  let urgent: Bool

  /// The relay's own APNs alert (FALLBACK_TITLE and FALLBACK_BODY in crates/fleetd/src/push_relay/apns.rs).
  static let generic = Payload(title: "fleetd", body: "New activity", thread: nil, quiet: false, urgent: false)

  /// What shows for `c`: its payload when it opens with `secretKey`, the generic text otherwise.
  static func shown(_ sealed: String?, secretKey: [UInt8]?) -> Payload {
    guard let sealed, let secretKey, let box = Data(base64Encoded: sealed),
          let plain = Sealed.open([UInt8](box), secretKey: secretKey) else { return generic }
    return parse(Data(plain)) ?? generic
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
