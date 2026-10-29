// One short link to the hub's /app socket for one share, as the app's (src/hub/client.ts) with the phone's own key:
// auth, a snapshot for the chats, then the calls that send. Frames it has no use for are skipped. Nothing reconnects:
// a dropped link fails the step, and the sheet offers to try again on a new one.
import Foundation

@MainActor
final class HubLink {
  private let pairing: Pairing
  private let task: URLSessionWebSocketTask
  private var calls = 0

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
        if case let .snapshot(s)? = try await receive(within: 20) { return ChatTarget.from(snapshot: s) }
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
    switch try await watched(seconds, { try await self.task.receive() }) {
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
