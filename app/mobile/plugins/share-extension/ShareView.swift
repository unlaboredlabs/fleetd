// The share sheet: what's being shared with a note under it, the recent chats in a row on top, every Navi and project
// below with search, and Send. Native lists and bars, Liquid Glass on iOS 26 (materials before it).
import SwiftUI
import UIKit

struct ShareSheet: View {
  @ObservedObject var model: ShareModel

  var body: some View {
    NavigationStack {
      content
        .navigationTitle("Send to fleetd")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button { model.cancel() } label: { Label("Cancel", systemImage: "xmark") }
          }
          if !model.failed {
            ToolbarItem(placement: .confirmationAction) {
              Button { model.send() } label: { Label("Send", systemImage: "arrow.up") }
                .disabled(!model.canSend)
            }
          }
        }
    }
  }

  @ViewBuilder private var content: some View {
    switch model.phase {
    case let .failed(problem):
      Notice(problem: problem, retry: { model.retry() }, openApp: { model.openApp() })
    default:
      chooser
    }
  }

  private var chooser: some View {
    List {
      Section {
        SharedPreview(preview: model.preview)
        TextField("Add a message", text: $model.note, axis: .vertical)
          .lineLimit(1...6)
          .disabled(model.sending)
      } footer: {
        if let problem = model.itemProblem {
          Text(problem).foregroundStyle(.red)
        }
      }
      if model.phase == .connecting {
        Section {
          HStack(spacing: 12) {
            ProgressView()
            Text("Connecting to \(model.hubName)…").foregroundStyle(.secondary)
          }
        }
      } else {
        chats
      }
    }
    .listStyle(.insetGrouped)
    .searchable(text: $model.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search chats")
    .safeAreaInset(edge: .bottom) { status }
    .animation(.spring(response: 0.3, dampingFraction: 0.85), value: model.selected)
    .animation(.spring(response: 0.3, dampingFraction: 0.85), value: model.phase)
  }

  @ViewBuilder private var chats: some View {
    if model.query.isEmpty && !model.recent.isEmpty {
      Section("Recent") {
        RecentRow(chats: model.recent, selected: model.selected) { model.select($0) }
          .listRowInsets(EdgeInsets())
      }
    }
    if !model.navis.isEmpty {
      Section("Navis") {
        ForEach(model.navis) { chat in ChatRow(chat: chat, selected: model.selected == chat) { model.select($0) } }
      }
    }
    if !model.projects.isEmpty {
      Section("Projects") {
        ForEach(model.projects) { chat in ChatRow(chat: chat, selected: model.selected == chat) { model.select($0) } }
      }
    }
    if model.navis.isEmpty && model.projects.isEmpty {
      Section {
        Text(model.query.isEmpty ? "\(model.hubName) has no chats yet." : "No chats match “\(model.query)”.")
          .foregroundStyle(.secondary)
      }
    }
  }

  @ViewBuilder private var status: some View {
    if let chat = model.selected {
      switch model.phase {
      case let .sending(done):
        Pill {
          ProgressView(value: done).frame(width: 64)
          Text("Sending to \(chat.title)…").lineLimit(1)
        }
      case .sent:
        Pill {
          Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
          Text("Sent to \(chat.title)").lineLimit(1)
        }
        .transition(.scale(scale: 0.9).combined(with: .opacity))
      default:
        if let problem = model.sendProblem {
          SendFailed(problem: problem) { model.send() }
        }
      }
    }
  }
}

/// What's being shared: the images, the page, or the text.
private struct SharedPreview: View {
  let preview: ShareModel.Preview

  var body: some View {
    if preview.images.count == 1, let image = preview.images.first {
      Image(uiImage: image)
        .resizable()
        .scaledToFill()
        .frame(maxWidth: .infinity)
        .frame(height: 200)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .listRowInsets(EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12))
        .accessibilityLabel("An image")
    } else if !preview.images.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(preview.images.indices, id: \.self) { i in
            Image(uiImage: preview.images[i])
              .resizable()
              .scaledToFill()
              .frame(width: 96, height: 96)
              .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
          }
        }
        .padding(12)
      }
      .listRowInsets(EdgeInsets())
      .accessibilityLabel("\(preview.images.count) images")
    } else if let link = preview.link {
      HStack(spacing: 12) {
        Group {
          if let icon = preview.icon {
            Image(uiImage: icon).resizable().scaledToFill()
          } else {
            Image(systemName: "safari").font(.title2).foregroundStyle(.secondary)
          }
        }
        .frame(width: 44, height: 44)
        .background(Color(.tertiarySystemFill))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        VStack(alignment: .leading, spacing: 2) {
          Text(link.title ?? link.url.host ?? link.url.absoluteString).font(.body.weight(.semibold)).lineLimit(2)
          Text(link.url.host ?? link.url.absoluteString).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
        }
      }
      .padding(.vertical, 4)
    } else if let text = preview.text {
      Text(text).lineLimit(8).padding(.vertical, 4)
    } else if preview.loading {
      HStack {
        Spacer()
        ProgressView()
        Spacer()
      }
      .padding(.vertical, 8)
    }
  }
}

/// The most recent chats, in a row of avatars, as the system share sheet's people.
private struct RecentRow: View {
  let chats: [ChatTarget]
  let selected: ChatTarget?
  let select: (ChatTarget) -> Void

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(alignment: .top, spacing: 12) {
        ForEach(chats) { chat in
          Button { select(chat) } label: {
            VStack(spacing: 6) {
              AvatarView(name: chat.title, navi: chat.navi, size: 58)
                .overlay(alignment: .bottomTrailing) {
                  if selected == chat {
                    Image(systemName: "checkmark.circle.fill")
                      .font(.system(size: 20))
                      .foregroundStyle(.white, Color.accentColor)
                      .background(Circle().fill(Color(.systemBackground)).padding(-2))
                      .transition(.scale.combined(with: .opacity))
                  }
                }
              Text(chat.title)
                .font(.caption)
                .foregroundStyle(selected == chat ? Color.accentColor : .primary)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .frame(width: 70)
            }
          }
          .buttonStyle(.plain)
          .accessibilityLabel(chat.title)
          .accessibilityAddTraits(selected == chat ? .isSelected : [])
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
    }
  }
}

private struct ChatRow: View {
  let chat: ChatTarget
  let selected: Bool
  let select: (ChatTarget) -> Void

  var body: some View {
    Button { select(chat) } label: {
      HStack(spacing: 12) {
        AvatarView(name: chat.title, navi: chat.navi, size: 40)
        VStack(alignment: .leading, spacing: 1) {
          Text(chat.title).lineLimit(1)
          Text(chat.subtitle).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
        }
        Spacer(minLength: 8)
        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
          .font(.title3)
          .foregroundStyle(selected ? Color.accentColor : Color(.tertiaryLabel))
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

/// A chat's initials on its color, as in the app (src/ui/Avatar.tsx): a Navi's a filled circle, a project's a soft
/// rounded square.
struct AvatarView: View {
  let name: String
  let navi: Bool
  let size: CGFloat
  @Environment(\.colorScheme) private var scheme

  /// The app's tints (src/theme.ts), iOS's own colors in the same order.
  private static let tints: [Color] = [.blue, .green, .orange, .purple, .pink, .teal, .indigo, .brown, .mint, .red]

  var body: some View {
    let tint = Self.tints[Avatar.tint(name, count: Self.tints.count)]
    let initials = Avatar.initials(name)
    let shape = RoundedRectangle(cornerRadius: navi ? size / 2 : size * 0.28, style: .continuous)
    Text(initials)
      .font(.system(size: size * (initials.count > 1 ? 0.36 : 0.42), weight: .semibold))
      .foregroundStyle(navi ? Color.white : tint)
      .frame(width: size, height: size)
      .background(navi ? tint : tint.opacity(scheme == .dark ? 0.28 : 0.16), in: shape)
      .accessibilityHidden(true)
  }
}

/// A floating line over the list's foot: glass on iOS 26, a material before.
private struct Pill<Content: View>: View {
  @ViewBuilder let content: Content

  var body: some View {
    HStack(spacing: 10) { content }
      .font(.subheadline.weight(.medium))
      .padding(.horizontal, 18)
      .padding(.vertical, 12)
      .glass(in: Capsule())
      .padding(.bottom, 8)
  }
}

private struct SendFailed: View {
  let problem: Problem
  let retry: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: problem.symbol).font(.title3).foregroundStyle(.orange)
      VStack(alignment: .leading, spacing: 2) {
        Text(problem.title).font(.subheadline.weight(.semibold))
        Text(problem.message).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 4)
      Button("Retry", action: retry).font(.subheadline.weight(.semibold)).prominent(true).controlSize(.small)
    }
    .padding(14)
    .glass(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    .padding(.horizontal, 16)
    .padding(.bottom, 8)
  }
}

/// Why nothing can be sent from here: not paired, the hub unreachable or refusing this phone.
private struct Notice: View {
  let problem: Problem
  let retry: () -> Void
  let openApp: () -> Void

  var body: some View {
    VStack(spacing: 12) {
      Image(systemName: problem.symbol)
        .font(.system(size: 46))
        .symbolRenderingMode(.hierarchical)
        .foregroundStyle(.secondary)
        .padding(.bottom, 4)
      Text(problem.title).font(.title3.weight(.semibold)).multilineTextAlignment(.center)
      Text(problem.message).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
      VStack(spacing: 10) {
        if problem.retry {
          Button(action: retry) { Text("Try Again").frame(maxWidth: .infinity) }.prominent(true)
        }
        Button(action: openApp) { Text("Open fleetd").frame(maxWidth: .infinity) }.prominent(!problem.retry)
      }
      .controlSize(.large)
      .padding(.top, 14)
    }
    .padding(32)
    .frame(maxWidth: 440)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color(.systemGroupedBackground))
  }
}

extension View {
  /// Liquid Glass in the shape on iOS 26; the regular material before it.
  @ViewBuilder func glass<S: Shape>(in shape: S) -> some View {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      glassEffect(.regular, in: shape)
    } else {
      background(.regularMaterial, in: shape)
    }
    #else
    background(.regularMaterial, in: shape)
    #endif
  }

  /// A capsule button: prominent (tinted) or plain glass on iOS 26, bordered before it.
  @ViewBuilder func prominent(_ on: Bool) -> some View {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      if on { buttonStyle(.glassProminent) } else { buttonStyle(.glass) }
    } else if on {
      buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
    } else {
      buttonStyle(.bordered).buttonBorderShape(.capsule)
    }
    #else
    if on { buttonStyle(.borderedProminent).buttonBorderShape(.capsule) } else { buttonStyle(.bordered).buttonBorderShape(.capsule) }
    #endif
  }
}
