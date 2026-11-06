import ActivityKit
import SwiftUI
import WidgetKit

@main
struct PartyLineWidgets: WidgetBundle {
    var body: some Widget {
        PartyLineLiveActivity()
    }
}

typealias LiveState = PartyLineActivityAttributes.ContentState

/// Lock screen banner + Dynamic Island: mic state (tap to talk on iOS 17+), who is talking,
/// and the latest message.
struct PartyLineLiveActivity: Widget {
    var body: some WidgetConfiguration {
        if #available(iOS 18, *) {
            return configuration.supplementalActivityFamilies([.small])
        }
        return configuration
    }

    private var configuration: some WidgetConfiguration {
        ActivityConfiguration(for: PartyLineActivityAttributes.self) { context in
            Group {
                if #available(iOS 18, *) {
                    ActivityCard(context: context)
                } else {
                    LockScreenView(context: context)
                }
            }
                .activityBackgroundTint(Color.black.opacity(0.85))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            let s = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    MicButton(state: s, activityID: context.attributes.controlID, size: 44).padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(context.attributes.groupName.uppercased())
                            .font(.caption.weight(.heavy))
                            .foregroundStyle(Color(plHex: context.attributes.groupColor) ?? .white)
                        LinkLabel(link: s.link)
                    }
                    .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    TalkingLine(state: s).font(.headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    MessageLine(state: s)
                }
            } compactLeading: {
                MicGlyph(mic: s.mic).font(.system(size: 14, weight: .bold))
            } compactTrailing: {
                if let first = s.talking.first {
                    HStack(spacing: 3) {
                        Image(systemName: "waveform")
                        Text(first.split(separator: " ").first.map(String.init) ?? first).lineLimit(1)
                    }
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.green)
                    .frame(maxWidth: 84)
                } else if s.unread > 0 {
                    Text("💬\(s.unread)").font(.caption2.weight(.bold))
                } else {
                    Image(systemName: "headphones").foregroundStyle(.secondary)
                }
            } minimal: {
                if !s.talking.isEmpty {
                    Image(systemName: "waveform").foregroundStyle(.green)
                } else {
                    MicGlyph(mic: s.mic)
                }
            }
            .keylineTint(s.mic == .live ? .red : (s.talking.isEmpty ? .gray : .green))
        }
    }
}

@available(iOS 18, *)
private struct ActivityCard: View {
    @Environment(\.activityFamily) private var family
    let context: ActivityViewContext<PartyLineActivityAttributes>

    var body: some View {
        if family == .small {
            HStack(spacing: 6) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.attributes.groupName)
                        .font(.caption)
                        .lineLimit(1)
                    Text(context.state.mic == .locked ? "Producer mute" : context.state.mic == .live ? "Mic live" : "Mic muted")
                        .font(.headline)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                MicButton(state: context.state, activityID: context.attributes.controlID, size: 44, showsCaption: false)
            }
        } else {
            LockScreenView(context: context)
        }
    }
}

private struct LockScreenView: View {
    let context: ActivityViewContext<PartyLineActivityAttributes>
    private var attributes: PartyLineActivityAttributes { context.attributes }
    private var state: LiveState { context.state }

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            MicButton(state: state, activityID: context.attributes.controlID, size: 58)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(attributes.groupName.uppercased())
                        .font(.subheadline.weight(.heavy))
                        .foregroundStyle(Color(plHex: attributes.groupColor) ?? .white)
                    Text(attributes.serverName).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 0)
                    LinkLabel(link: state.link)
                }
                TalkingLine(state: state).font(.headline)
                MessageLine(state: state)
            }
        }
        .padding(14)
        .foregroundStyle(.white)
    }
}

/// Big round mic: grey "Muted", red "Live", lock when muted by the producer.
/// A button that toggles talking on iOS 17+; a plain indicator on iOS 16.
private struct MicButton: View {
    var state: LiveState
    var activityID: String?
    var size: CGFloat
    var showsCaption = true

    var body: some View {
        if let activityID, state.mic != .locked, #available(iOS 17.0, *) {
            Button(intent: SetActivityMicIntent(activityID: activityID, live: state.mic != .live)) { face }
                .buttonStyle(.plain)
                .disabled(state.mic != .live && (state.link != .live || state.canUnmute == false))
                .accessibilityLabel(state.mic == .live ? "Mute microphone" : "Unmute microphone")
        } else {
            face.accessibilityLabel(state.mic == .locked ? "Muted by producer" : label)
        }
    }

    private var face: some View {
        VStack(spacing: 2) {
            MicGlyph(mic: state.mic, onRed: state.mic == .live)
                .font(.system(size: size * 0.38, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: size, height: size)
                .background(Circle().fill(state.mic == .live ? Color.red : Color.white.opacity(0.18)))
            if showsCaption {
                Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.white.opacity(0.8)).lineLimit(1)
            }
        }
    }

    private var label: String {
        switch state.mic {
        case .live: "Live"
        case .muted: "Muted"
        case .locked: "Locked"
        }
    }
}

private struct MicGlyph: View {
    var mic: LiveState.Mic
    /// Drawn on the red "live" circle: white instead of red.
    var onRed = false

    var body: some View {
        switch mic {
        case .live: Image(systemName: "mic.fill").foregroundStyle(onRed ? .white : .red)
        case .muted: Image(systemName: "mic.slash.fill")
        case .locked: Image(systemName: "lock.fill").foregroundStyle(.orange)
        }
    }
}

private struct TalkingLine: View {
    var state: LiveState

    var body: some View {
        if state.talking.isEmpty {
            Label("Quiet", systemImage: "waveform").foregroundStyle(.secondary).lineLimit(1)
        } else {
            Label(state.talking.joined(separator: ", "), systemImage: "waveform.circle.fill")
                .foregroundStyle(.green)
                .lineLimit(1)
        }
    }
}

private struct MessageLine: View {
    var state: LiveState

    var body: some View {
        if let text = state.messageText {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("💬")
                (Text(state.messageFrom.map { "\($0): " } ?? "").bold() + Text(text))
                    .lineLimit(2)
                Spacer(minLength: 0)
                if state.unread > 1 { Text("+\(state.unread - 1)").font(.caption2.bold()).foregroundStyle(.orange) }
            }
            .font(.subheadline)
        }
    }
}

private struct LinkLabel: View {
    var link: LiveState.Link

    var body: some View {
        switch link {
        case .live: EmptyView()
        case .connecting: Text("connecting").font(.caption2).foregroundStyle(.yellow)
        case .reconnecting: Text("reconnecting").font(.caption2).foregroundStyle(.orange)
        case .offline: Text("offline").font(.caption2).foregroundStyle(.red)
        }
    }
}

extension Color {
    init?(plHex hex: String?) {
        guard var s = hex?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}
