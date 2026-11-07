// One short link to the hub's /app socket for one share or one Shortcuts action, as the app's (src/hub/client.ts) with
// the phone's own key: auth, a snapshot for the chats, then the calls that send, and for a wait, the events after the
// snapshot. Frames it has no use for are skipped. Nothing reconnects: a dropped link fails the step, and the sheet
// offers to try again on a new one. The app target builds it too (plugins/app-intents).
import Foundation
import Security

@MainActor
final class HubLink: HubCalls {
  private let pairing: Pairing
  private let task: URLSessionWebSocketTask
  private var calls = 0
  /// The snapshot's cursor: events after it are new.
  private(set) var cursor: Int?
  /// Events that came while a call waited for its result, for `event(until:)`.
  private var held: [(type: String, data: [String: Any])] = []

  init?(_ pairing: Pairing) {
    guard let url = pairing.socketURL else { return nil }
    self.pairing = pairing
    task = URLSession(configuration: .ephemeral).webSocketTask(with: url)
    // The snapshot can be large; the app's socket takes any size.
    task.maximumMessageSize = 64 * 1024 * 1024
  }

  /// Signs in with the phone's key; then the hub's chats.
  func open() async throws -> [ChatTarget] {
    task.resume()
    do {
      try await send(["t": "auth", "key": pairing.key])
      signIn: while true {
        switch try await receive(within: 15) {
        case .ready?: break signIn
        // The hub refuses a key with an error frame, then closes (4401).
        case .error(nil, _, _, _)?: throw Problem.refused(pairing)
        default: continue
        }
      }
      try await send(["t": "snapshot"])
      while true {
        if case let .snapshot(s)? = try await receive(within: 20) {
          cursor = s["cursor"] as? Int
          return ChatTarget.from(snapshot: s)
        }
      }
    } catch let problem as Problem {
      close()
      throw problem
    } catch {
      close()
      throw task.closeCode.rawValue == 4401 ? Problem.refused(pairing) : Problem.unreachable(pairing)
    }
  }

  /// One tool call, as the app makes it; its output, or the hub's refusal as a Problem.
  func call(_ tool: String, _ input: [String: Any]) async throws -> [String: Any] {
    calls += 1
    let id = "s\(calls)"
    do {
      try await send(["t": "call", "id": id, "tool": tool, "input": input])
      while true {
        switch try await receive(within: 60) {
        case let .result(got, output)? where got == id: return output
        case let .event(type, data)?: held.append((type, data))
        case let .error(got, code, message, fix)? where got == id || got == nil:
          throw Problem.hub(code: code, message: message, fix: fix)
        default: continue
        }
      }
    } catch let problem as Problem {
      throw problem
    } catch {
      close()
      throw Problem.dropped(pairing)
    }
  }

  /// The hub's events from the snapshot on: subscribed before a send, so nothing it causes slips past.
  func subscribe() async throws {
    do {
      try await send(["t": "events", "cursor": cursor ?? 0])
    } catch {
      close()
      throw Problem.dropped(pairing)
    }
  }

  /// The next event before `until`; nil once that time is up, which closes the link. A dropped link throws.
  func event(until: Date) async throws -> (type: String, data: [String: Any])? {
    if !held.isEmpty { return held.removeFirst() }
    do {
      while true {
        let left = until.timeIntervalSinceNow
        if left <= 0 { return nil }
        switch try await receive(within: left) {
        case let .event(type, data)?: return (type, data)
        case let .error(nil, code, message, fix)?: throw Problem.hub(code: code, message: message, fix: fix)
        default: continue
        }
      }
    } catch let problem as Problem {
      throw problem
    } catch {
      close()
      // Its own time ran out, rather than the link.
      if until.timeIntervalSinceNow < 1 { return nil }
      throw Problem.dropped(pairing)
    }
  }

  func close() {
    task.cancel(with: .normalClosure, reason: nil)
  }

  /// Sends a frame; one that can't go within 30 s (a hub that never accepts the connection) drops the link.
  private func send(_ frame: [String: Any]) async throws {
    let text = String(decoding: try JSONSerialization.data(withJSONObject: frame), as: UTF8.self)
    try await watched(30) { try await self.task.send(.string(text)) }
  }

  /// The next frame, nil for one this doesn't read; a link silent for `seconds` is dropped, which throws.
  private func receive(within seconds: Double) async throws -> Frame? {
    Self.frame(try await watched(seconds, { try await self.task.receive() }))
  }

  private static func frame(_ message: URLSessionWebSocketTask.Message) -> Frame? {
    switch message {
    case let .string(text): return Frame.parse(Data(text.utf8))
    case let .data(data): return Frame.parse(data)
    @unknown default: return nil
    }
  }

  /// Runs a step of the link, which fails when the link is dropped after `seconds`.
  private func watched<T>(_ seconds: Double, _ step: () async throws -> T) async throws -> T {
    let task = self.task
    let watchdog = Task {
      try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
      task.cancel(with: .goingAway, reason: nil)
    }
    defer { watchdog.cancel() }
    return try await step()
  }
}

/// The paired hub, as expo-secure-store keeps it in the keychain group the app shares (src/vault.ts): service
/// "app:no-auth" (or "app", from older versions), account "fleetd.hub". Read only, never copied. It opens only while
/// the phone is unlocked (secure storage's default), so a locked phone reads as locked rather than unpaired.
enum Keychain {
  static func read() -> Stored {
    var locked = false
    for service in ["app:no-auth", "app"] {
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: Data("fleetd.hub".utf8),
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
      ]
      var item: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &item)
      if status == errSecSuccess, let data = item as? Data { return .found(data) }
      if status == errSecInteractionNotAllowed { locked = true }
    }
    return locked ? .locked : .missing
  }

  static func pairing() -> Data? {
    if case let .found(data) = read() { return data }
    return nil
  }
}
