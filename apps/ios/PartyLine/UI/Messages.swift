import SwiftUI

/// Full-width "💬 Messages" button at the bottom of the crew screen, with the unread badge.
/// Opens the messages panel in place.
struct MessagesButton: View {
    @EnvironmentObject var session: SessionCoordinator

    var body: some View {
        Button {
            if session.messagesOpen { session.closeMessages() } else { session.openMessages() }
        } label: {
            HStack {
                Text("💬 Messages")
                if session.unreadCount > 0 {
                    Text("\(session.unreadCount)").font(.caption.bold()).foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Capsule().fill(.red))
                }
            }
            .frame(maxWidth: .infinity).padding(.vertical, 12)
        }
        .buttonStyle(.bordered)
        .accessibilityLabel("Messages")
        .accessibilityValue(session.unreadCount > 0 ? "\(session.unreadCount) unread" : "")
        .accessibilityIdentifier("messages-button")
    }
}

/// Floating card above the 💬 button: history, quick replies, To:, 🔔, text field and Send.
struct MessagesPanel: View {
    @EnvironmentObject var session: SessionCoordinator
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Messages").font(.headline)
                Spacer()
                Button("Close") { session.closeMessages() }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            Divider()

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(session.messages) { m in
                            MessageRow(message: m, mine: m.from == session.myId, sender: session.roster.name(of: m.from),
                                       target: session.describe(m.to))
                                .id(m.id)
                        }
                    }
                    .padding(12)
                }
                .overlay {
                    if session.messages.isEmpty { Text("No messages yet").foregroundStyle(.secondary) }
                }
                .onAppear { if let last = session.messages.last { proxy.scrollTo(last.id, anchor: .bottom) } }
                .onChange(of: session.messages.count) { _ in
                    if let last = session.messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }
            Divider()

            VStack(spacing: 8) {
                if session.me?.isAdmin != true, !session.quickReplies.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack {
                            ForEach(session.quickReplies, id: \.self) { q in
                                Button(q) { session.send(text: q, kind: .quick) }.buttonStyle(.bordered)
                            }
                        }
                    }
                }
                HStack {
                    Text("To:").font(.subheadline).foregroundStyle(.secondary)
                    Picker("To", selection: Binding(get: { session.composeTarget ?? "" },
                                                    set: { session.composeTarget = $0 })) {
                        ForEach(session.composeOptions) { o in Text(o.label).tag(o.target) }
                    }
                    .pickerStyle(.menu)
                    .lineLimit(1)
                    .layoutPriority(1)
                    .accessibilityIdentifier("compose-to")
                    Spacer()
                    Button { session.sendSignal() } label: { Text("🔔").font(.title3) }
                        .buttonStyle(.bordered).tint(.orange)
                        .accessibilityLabel("Signal")
                }
                HStack {
                    TextField("Message", text: $draft, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(1...4)
                        .focused($focused)
                        .submitLabel(.send)
                        .onSubmit(sendDraft)
                        .accessibilityIdentifier("compose-text")
                    Button("Send", action: sendDraft)
                        .buttonStyle(.borderedProminent)
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(12)
        }
        .background(RoundedRectangle(cornerRadius: 20).fill(.regularMaterial))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(.quaternary))
        .shadow(color: .black.opacity(0.35), radius: 16, y: 6)
        .onChange(of: session.focusComposeToken) { _ in focused = true }
        .onAppear { if session.focusComposeToken > 0 { focused = true } }
        .accessibilityIdentifier("messages-panel")
    }

    private func sendDraft() {
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        session.send(text: draft)
        draft = ""
    }
}

/// New live message while the panel is closed: stays at the top, over everything, until dismissed.
struct MessagePopup: View {
    @EnvironmentObject var session: SessionCoordinator

    var body: some View {
        if let m = session.popupQueue.first {
            let more = session.popupQueue.count - 1
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("💬 \(session.roster.name(of: m.from)) → \(session.describe(m.to)) · \(MessageRow.time(m.ts))")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    if more > 0 { Text("+\(more) more").font(.caption.bold()).foregroundStyle(.orange) }
                }
                Text(m.text)
                    .font(.system(size: 28, weight: .bold))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("popup-text")
                HStack(spacing: 12) {
                    Button { session.replyToPopup() } label: {
                        Text("↩ Reply").font(.title3.bold()).frame(maxWidth: .infinity).padding(.vertical, 12)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("popup-reply")
                    Button { session.dismissPopup() } label: {
                        Text(more > 0 ? "Next" : "Close").font(.title3.bold()).frame(maxWidth: .infinity).padding(.vertical, 12)
                    }
                    .buttonStyle(.bordered)
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("popup-close")
                }
                if more > 0 {
                    Button("Close all") { session.dismissAllPopups() }
                        .font(.subheadline)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(16)
            .background(RoundedRectangle(cornerRadius: 20).fill(.thickMaterial))
            .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Color.accentColor, lineWidth: 2))
            .shadow(color: .black.opacity(0.4), radius: 18, y: 6)
            .padding(.horizontal, 12)
            .transition(.move(edge: .top).combined(with: .opacity))
            .id(m.id)
        }
    }
}

struct MessageRow: View {
    var message: Message
    var mine: Bool
    var sender: String
    var target: String

    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
            Text(mine ? "To \(target)" : "\(sender) → \(target)").font(.caption).foregroundStyle(.secondary)
            Text(message.text)
                .font(message.kind == .quick ? .title3.bold() : .body)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 14).fill(mine ? Color.accentColor.opacity(0.6) : Color(.secondarySystemBackground)))
            Text(Self.time(message.ts)).font(.caption2).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    private static let out: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .short
        return f
    }()

    static func time(_ iso: String) -> String {
        Wire.isoFormatter.date(from: iso).map(out.string) ?? ""
    }
}
