// fleetd in Shortcuts, Spotlight, Siri and the Action Button (D289 mobile.shortcuts): Open Chat, Send Message, Run
// Automation, Open Approvals, Get Latest Messages, Get Waiting Approvals, and a Focus filter for which chats notify.
// They're in the app's own target (plugins/app-intents), so they need no extension, App ID or profile of their own, and
// run in the app's process, launched in the background for all but the two that open it. Each signs in to the hub as
// the share sheet does, with the pairing the app keeps in the keychain (HubLink.swift), on a link of its own; what
// they decide is Actions.swift's. Nothing here answers an approval, enters a secret or pays: those stay in the app.
//
// iOS 18 or later: the two that open the app hand iOS the app's own link (OpenURLIntent), which it opens cold or warm
// as any link, and the app goes to the chat or the list (src/shortcutLink.ts).
import AppIntents
import Foundation

extension HubLink {
  /// A link on the phone's pairing; what's wrong with the pairing as a Problem.
  static func paired() throws -> (HubLink, Pairing) {
    let p = try pairing(Keychain.read())
    guard let link = HubLink(p) else { throw Problem.unreachable(p) }
    return (link, p)
  }
}

/// A Problem as Shortcuts shows an action's error: its title and what to do, in one line.
struct ActionError: Error, CustomLocalizedStringResourceConvertible {
  let problem: Problem

  var localizedStringResource: LocalizedStringResource { "\(problem.line)" }

  /// Runs an action's step, its Problem made Shortcuts' error.
  @MainActor
  static func shown<T>(_ step: () async throws -> T) async throws -> T {
    do {
      return try await step()
    } catch let problem as Problem {
      throw ActionError(problem: problem)
    }
  }
}

/// What the pickers last listed, kept in the app's own defaults: a shortcut's chat shows its name, and Open Chat
/// runs with no hub at all.
@MainActor
enum Kept {
  private static let chatsKey = "fleetd.shortcuts.chats"
  private static let automationsKey = "fleetd.shortcuts.automations"

  static var chats: [ChatTarget] {
    get { Chats.decode(UserDefaults.standard.data(forKey: chatsKey)) }
    set {
      let changed = newValue.map(\.id) != chats.map(\.id) || newValue.map(\.title) != chats.map(\.title)
      UserDefaults.standard.set(Chats.encode(newValue), forKey: chatsKey)
      // The chats' own App Shortcuts ("Open Errands in fleetd") follow the list.
      if changed, #available(iOS 18.0, *) { FleetdShortcuts.updateAppShortcutParameters() }
    }
  }

  static var automations: [AutomationTarget] {
    get { AutomationTarget.decode(UserDefaults.standard.data(forKey: automationsKey)) }
    set {
      let changed = newValue != automations
      UserDefaults.standard.set(AutomationTarget.encode(newValue), forKey: automationsKey)
      if changed, #available(iOS 18.0, *) { FleetdShortcuts.updateAppShortcutParameters() }
    }
  }

  /// The hub's chats now, kept for next time.
  static func freshChats() async throws -> [ChatTarget] {
    let (link, _) = try HubLink.paired()
    let chats = try await Run.chats { link }
    Self.chats = chats
    return chats
  }

  static func freshAutomations() async throws -> [AutomationTarget] {
    let (link, _) = try HubLink.paired()
    let all = try await Run.automations { link }
    automations = all
    return all
  }
}

// MARK: Chats

@available(iOS 18.0, *)
struct ChatEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Chat"
  static let defaultQuery = ChatQuery()

  /// "machineId/projectId".
  let id: String
  let title: String
  let subtitle: String
  let navi: Bool

  init(_ chat: ChatTarget) {
    id = chat.id
    title = chat.title
    subtitle = chat.subtitle
    navi = chat.navi
  }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(title)", subtitle: "\(subtitle)", image: DisplayRepresentation.Image(systemName: navi ? "sparkles" : "folder"))
  }
}

/// The person's Navis and projects, who spoke last first, as the share sheet lists them.
@available(iOS 18.0, *)
struct ChatQuery: EntityStringQuery {
  @MainActor
  func entities(for identifiers: [ChatEntity.ID]) async throws -> [ChatEntity] {
    var known = Kept.chats
    if !Chats.missing(identifiers, known: known).isEmpty, let fresh = try? await Kept.freshChats() { known = fresh }
    return Chats.resolve(identifiers, known: known).map(ChatEntity.init)
  }

  @MainActor
  func suggestedEntities() async throws -> [ChatEntity] {
    try await chats().map(ChatEntity.init)
  }

  @MainActor
  func entities(matching string: String) async throws -> [ChatEntity] {
    ChatTarget.search(try await chats(), string).map(ChatEntity.init)
  }

  /// The hub's, else the ones kept; with neither, why.
  @MainActor
  private func chats() async throws -> [ChatTarget] {
    do {
      return try await Kept.freshChats()
    } catch let problem as Problem {
      let kept = Kept.chats
      if kept.isEmpty { throw ActionError(problem: problem) }
      return kept
    }
  }
}

// MARK: Automations

@available(iOS 18.0, *)
struct AutomationEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Automation"
  static let defaultQuery = AutomationQuery()

  /// The hub's automationId.
  let id: String
  let name: String
  let chat: String
  let paused: Bool

  init(_ a: AutomationTarget) {
    id = a.id
    name = a.name
    chat = a.chat
    paused = a.paused
  }

  var displayRepresentation: DisplayRepresentation {
    let under = paused ? chat + ", paused" : chat
    return DisplayRepresentation(title: "\(name)", subtitle: "\(under)", image: DisplayRepresentation.Image(systemName: "bolt"))
  }
}

/// Every chat's automations, by name. Running one needs only its id, so one not known any more still runs, or says
/// it's gone.
@available(iOS 18.0, *)
struct AutomationQuery: EntityStringQuery {
  @MainActor
  func entities(for identifiers: [AutomationEntity.ID]) async throws -> [AutomationEntity] {
    var known = Kept.automations
    if identifiers.contains(where: { id in !known.contains { $0.id == id } }), let fresh = try? await Kept.freshAutomations() { known = fresh }
    return identifiers.map { id in
      AutomationEntity(known.first { $0.id == id } ?? AutomationTarget(id: id, name: "Automation", chat: "", paused: false))
    }
  }

  @MainActor
  func suggestedEntities() async throws -> [AutomationEntity] {
    try await automations().map(AutomationEntity.init)
  }

  @MainActor
  func entities(matching string: String) async throws -> [AutomationEntity] {
    AutomationTarget.search(try await automations(), string).map(AutomationEntity.init)
  }

  @MainActor
  private func automations() async throws -> [AutomationTarget] {
    do {
      return try await Kept.freshAutomations()
    } catch let problem as Problem {
      let kept = Kept.automations
      if kept.isEmpty { throw ActionError(problem: problem) }
      return kept
    }
  }
}

// MARK: Actions

@available(iOS 18.0, *)
struct OpenChat: AppIntent {
  static let title: LocalizedStringResource = "Open Chat"
  static let description = IntentDescription("Opens a Navi's or a project's chat in fleetd.")

  @Parameter(title: "Chat")
  var chat: ChatEntity

  static var parameterSummary: some ParameterSummary {
    Summary("Open \(\.$chat)")
  }

  func perform() async throws -> some IntentResult & OpensIntent {
    guard let url = Links.chat(chat.id) else { throw ActionError(problem: .unpaired) }
    return .result(opensIntent: OpenURLIntent(url))
  }
}

@available(iOS 18.0, *)
struct OpenApprovals: AppIntent {
  static let title: LocalizedStringResource = "Open Approvals"
  static let description = IntentDescription("Opens fleetd's list of chats with something waiting on you. Approving and denying stay in the app.")

  func perform() async throws -> some IntentResult & OpensIntent {
    .result(opensIntent: OpenURLIntent(Links.approvals))
  }
}

@available(iOS 18.0, *)
struct SendMessage: AppIntent {
  static let title: LocalizedStringResource = "Send Message"
  static let description = IntentDescription(
    "Sends a message to a Navi or a project as you, without opening fleetd. With Wait for Reply, returns the reply's text for the next action."
  )

  @Parameter(title: "Chat")
  var chat: ChatEntity

  @Parameter(title: "Message", inputOptions: String.IntentInputOptions(multiline: true))
  var text: String

  @Parameter(title: "Wait for Reply", default: false)
  var wait: Bool

  @Parameter(title: "Wait Up To (Seconds)", default: 60)
  var seconds: Int

  static var parameterSummary: some ParameterSummary {
    When(\.$wait, .equalTo, true) {
      Summary("Send \(\.$text) to \(\.$chat)") {
        \.$wait
        \.$seconds
      }
    } otherwise: {
      Summary("Send \(\.$text) to \(\.$chat)") {
        \.$wait
      }
    }
  }

  @MainActor
  func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
    let (wait, seconds, chat, text) = (wait, seconds, chat, text)
    let reply = try await ActionError.shown {
      let (link, p) = try HubLink.paired()
      var first: HubLink? = link
      // The first link, then a fresh one for a read after the wait ran out.
      let next: Run.Link = {
        if let l = first {
          first = nil
          return l
        }
        guard let fresh = HubLink(p) else { throw Problem.unreachable(p) }
        return fresh
      }
      return try await Run.send(next, pairing: p, chat: chat.id, text: text, wait: wait ? seconds : nil, requestId: "shortcut-" + UUID().uuidString.lowercased())
    }
    guard let reply else { return .result(value: "", dialog: "Sent to \(chat.title).") }
    return .result(value: reply, dialog: "\(reply)")
  }
}

@available(iOS 18.0, *)
struct RunAutomation: AppIntent {
  static let title: LocalizedStringResource = "Run Automation"
  static let description = IntentDescription("Runs one of your automations now, as Run Now in fleetd does.")

  @Parameter(title: "Automation")
  var automation: AutomationEntity

  static var parameterSummary: some ParameterSummary {
    Summary("Run \(\.$automation)")
  }

  @MainActor
  func perform() async throws -> some IntentResult & ProvidesDialog {
    let id = automation.id
    try await ActionError.shown {
      let (link, _) = try HubLink.paired()
      try await Run.automation({ link }, id: id)
    }
    return .result(dialog: "Started \(automation.name).")
  }
}

/// One message, as Get Latest Messages returns it: Speak Text and Show Result read its author and words.
@available(iOS 18.0, *)
struct MessageItem: TransientAppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Message"

  @Property(title: "Author")
  var author: String

  @Property(title: "Text")
  var text: String

  @Property(title: "Date")
  var date: Date

  init() {
    author = ""
    text = ""
    date = Date()
  }

  init(_ said: Said) {
    author = said.author
    text = said.text
    date = said.at
  }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(author): \(text)")
  }
}

@available(iOS 18.0, *)
struct GetLatestMessages: AppIntent {
  static let title: LocalizedStringResource = "Get Latest Messages"
  static let description = IntentDescription("Returns a chat's newest messages, oldest first, each with who wrote it: to read them aloud, say.")

  @Parameter(title: "Chat")
  var chat: ChatEntity

  @Parameter(title: "Count", default: 3)
  var count: Int

  @Parameter(title: "Since")
  var since: Date?

  static var parameterSummary: some ParameterSummary {
    Summary("Get the latest \(\.$count) messages in \(\.$chat)") {
      \.$since
    }
  }

  @MainActor
  func perform() async throws -> some IntentResult & ReturnsValue<[MessageItem]> {
    let (chat, count, since) = (chat, min(max(count, 1), 50), since)
    let said = try await ActionError.shown {
      let (link, p) = try HubLink.paired()
      return try await Run.latest({ link }, pairing: p, chat: chat.id, count: count, since: since)
    }
    return .result(value: said.map(MessageItem.init))
  }
}

/// What waits on the person: how many, and each in a line. Read only: answering stays in the app.
@available(iOS 18.0, *)
struct WaitingApprovals: TransientAppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Waiting Approvals"

  @Property(title: "Count")
  var count: Int

  @Property(title: "Approvals")
  var approvals: [String]

  @Property(title: "Summary")
  var summary: String

  init() {
    count = 0
    approvals = []
    summary = ""
  }

  init(_ all: [Waiting]) {
    count = all.count
    approvals = all.map(\.line)
    summary = Waiting.summary(all)
  }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(summary)")
  }
}

@available(iOS 18.0, *)
struct GetWaitingApprovals: AppIntent {
  static let title: LocalizedStringResource = "Get Waiting Approvals"
  static let description = IntentDescription(
    "Returns how many approvals and questions wait on you, and each with its chat, to branch on in an automation. It doesn't answer any."
  )

  @MainActor
  func perform() async throws -> some IntentResult & ReturnsValue<WaitingApprovals> & ProvidesDialog {
    let waiting = try await ActionError.shown {
      let (link, _) = try HubLink.paired()
      return try await Run.waiting { link }
    }
    return .result(value: WaitingApprovals(waiting), dialog: "\(Waiting.summary(waiting))")
  }
}

// MARK: Focus

/// A Focus's fleetd filter: only the chats picked notify while it's on (the Notification Service Extension marks each
/// notification with its chat, plugins/notification-service). None picked: every chat does.
@available(iOS 18.0, *)
struct ChatsFocusFilter: SetFocusFilterIntent {
  static let title: LocalizedStringResource = "Choose Chats"
  static let description = IntentDescription("Only the chats you pick notify while this Focus is on.")

  @Parameter(title: "Chats")
  var chats: [ChatEntity]?

  var displayRepresentation: DisplayRepresentation {
    let names = (chats ?? []).map(\.title).joined(separator: ", ")
    let shown = names.isEmpty ? "All chats" : names
    return DisplayRepresentation(title: "\(shown)")
  }

  var appContext: FocusFilterAppContext {
    let ids = (chats ?? []).map(\.id)
    return FocusFilterAppContext(notificationFilterPredicate: ids.isEmpty ? nil : NSPredicate(format: "SELF IN %@", ids))
  }

  func perform() async throws -> some IntentResult {
    .result()
  }
}

// MARK: App Shortcuts

/// The actions as App Shortcuts: in Spotlight, Siri, the Shortcuts app and the Action Button's list with no setup, and
/// Open Chat once per chat ("Open Errands in fleetd").
@available(iOS 18.0, *)
struct FleetdShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: OpenChat(),
      phrases: ["Open \(\.$chat) in \(.applicationName)", "Open a chat in \(.applicationName)"],
      shortTitle: "Open Chat",
      systemImageName: "bubble.left.and.bubble.right"
    )
    AppShortcut(
      intent: SendMessage(),
      phrases: ["Send a message to \(\.$chat) in \(.applicationName)", "Send a \(.applicationName) message"],
      shortTitle: "Send Message",
      systemImageName: "paperplane"
    )
    AppShortcut(
      intent: OpenApprovals(),
      phrases: ["Open \(.applicationName) approvals", "What's waiting in \(.applicationName)"],
      shortTitle: "Open Approvals",
      systemImageName: "hand.raised"
    )
    AppShortcut(
      intent: GetWaitingApprovals(),
      phrases: ["Is anything waiting in \(.applicationName)", "Get waiting \(.applicationName) approvals"],
      shortTitle: "Waiting Approvals",
      systemImageName: "tray"
    )
    AppShortcut(
      intent: GetLatestMessages(),
      phrases: ["Read the latest from \(\.$chat) in \(.applicationName)", "Get the latest \(.applicationName) messages"],
      shortTitle: "Latest Messages",
      systemImageName: "text.bubble"
    )
    AppShortcut(
      intent: RunAutomation(),
      phrases: ["Run \(\.$automation) in \(.applicationName)", "Run a \(.applicationName) automation"],
      shortTitle: "Run Automation",
      systemImageName: "bolt"
    )
  }
}
