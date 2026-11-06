import SwiftUI

/// Crew main screen (ARCHITECTURE §10): group, who is talking, talk button, mutes, reply, messages.
struct CrewView: View {
    @EnvironmentObject var session: SessionCoordinator
    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 14) {
            header
            if session.phase == .offLine {
                Spacer()
                offLine
                Spacer()
            } else {
                banners
                talkingNow
                if session.talkableGroups.count > 1 { targetPicker }
                TalkModeSwitch()
                Spacer(minLength: 0)
                TalkButton()
                controls
                MessagesButton()
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .overlay(alignment: .top) { toast }
        .overlay(alignment: .bottom) {
            // Messages panel: a card floating over the bottom of the crew screen, not a new screen.
            if session.phase == .onLine && session.messagesOpen {
                MessagesPanel()
                    .frame(maxHeight: 600)
                    .padding(.horizontal, 10)
                    .padding(.bottom, 6)
                    .padding(.top, 60)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.85), value: session.messagesOpen)
        .sheet(isPresented: $showSettings) { SettingsView() }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text((session.myGroup?.name ?? "—").uppercased())
                    .font(.system(size: 34, weight: .heavy))
                    .foregroundStyle(Color(hex: session.myGroup?.color) ?? .primary)
                    .accessibilityIdentifier("group-name")
                Text(session.serverName).font(.subheadline).foregroundStyle(.secondary)
                if let me = session.me { Text(me.displayName).font(.footnote).foregroundStyle(.tertiary) }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 8) {
                LinkBadge(link: session.link, offLine: session.phase == .offLine, rtc: session.room.isConnected)
                Button { showSettings = true } label: { Image(systemName: "gearshape").font(.title2) }
                    .accessibilityLabel("Settings")
                    .accessibilityIdentifier("settings-button")
            }
        }
        .padding(.top, 8)
    }

    @ViewBuilder private var banners: some View {
        if session.adminMuted {
            Banner(icon: "lock.fill", text: "Muted by producer", color: .red)
        }
        if session.onHold {
            Banner(icon: "pause.circle.fill", text: "On hold during phone call", color: .orange)
        }
        if session.showsNoHeadsetWarning {
            Banner(icon: "speaker.wave.3.fill", text: "No headset — you're on the speaker (echo risk)", color: .yellow)
        }
        if session.link == .reconnecting {
            Banner(icon: "arrow.triangle.2.circlepath", text: "Reconnecting… the line stays open", color: .orange)
        } else if session.link == .serverOffline {
            Banner(icon: "wifi.exclamationmark", text: "Server offline — still trying", color: .red)
        }
    }

    private var talkingNow: some View {
        let names = session.talkingNow.map(\.displayName)
        return HStack {
            Image(systemName: names.isEmpty ? "waveform" : "waveform.circle.fill")
                .foregroundStyle(names.isEmpty ? Color.secondary : Color.green)
            Text(names.isEmpty ? "Quiet" : "Talking: " + names.joined(separator: ", "))
                .font(.title3.weight(.semibold))
                .lineLimit(2)
            Spacer()
        }
        .padding(.vertical, 6)
        .accessibilityIdentifier("talking-now")
    }

    private var targetPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack {
                Text("Talk to").font(.caption).foregroundStyle(.secondary)
                ForEach(session.talkableGroups) { g in
                    let on = session.talkTargets.contains(Target.group(g.id))
                    Button(g.name) { session.toggleTalkTarget(group: g.id) }
                        .buttonStyle(.bordered)
                        .tint(on ? (Color(hex: g.color) ?? .accentColor) : .gray)
                        .opacity(on ? 1 : 0.6)
                }
            }
        }
    }

    private var controls: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                MicTile()
                ToggleTile(on: session.speakerMuted, onIcon: "speaker.slash.fill", offIcon: "speaker.wave.2.fill",
                           label: session.speakerMuted ? "Speaker off" : "Speaker") {
                    session.setSpeakerMuted(!session.speakerMuted)
                }
                .accessibilityIdentifier("speaker-mute")
            }
            VoiceIsolationButton()
        }
    }

    private var offLine: some View {
        VStack(spacing: 16) {
            Image(systemName: "phone.down.circle").font(.system(size: 64)).foregroundStyle(.secondary)
            Text("Off the line").font(.title2.bold())
            Button { session.rejoin() } label: {
                Text("Join \(session.serverName)").font(.title3.bold()).frame(maxWidth: .infinity).padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("rejoin")
            Button("Pick another server", role: .destructive) { session.forgetServer() }
        }
    }

    @ViewBuilder private var toast: some View {
        if let t = session.toast {
            Text(t).font(.callout.weight(.semibold)).padding(.horizontal, 14).padding(.vertical, 10)
                .background(Capsule().fill(.ultraThinMaterial))
                .padding(.top, 120)
                .transition(.move(edge: .top).combined(with: .opacity))
                .task(id: t) {
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    withAnimation { session.toast = nil }
                }
        }
    }
}

/// Big thumb-sized talk button. Hold in PTT mode, tap in latch mode (IOS.md behavior 2).
struct TalkButton: View {
    @EnvironmentObject var session: SessionCoordinator
    @State private var pressing = false

    var body: some View {
        let live = session.micLive && !session.replyHeld
        let locked = session.adminMuted || session.phase != .onLine
        let title: String = {
            if session.adminMuted { return "MUTED BY PRODUCER" }
            if session.talkMode == .latch { return live ? "TALK ON" : "TAP TO TALK" }
            return live ? "TALKING" : "HOLD TO TALK"
        }()
        RoundedRectangle(cornerRadius: 28)
            .fill(locked ? Color.gray.opacity(0.3) : (live ? Color.red : Color.accentColor.opacity(0.85)))
            .overlay {
                VStack(spacing: 6) {
                    Image(systemName: session.adminMuted ? "lock.fill" : (live ? "mic.fill" : "mic"))
                        .font(.system(size: 40, weight: .bold))
                    Text(title).font(.system(size: 26, weight: .heavy))
                }
                .foregroundStyle(.white)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 220)
            .scaleEffect(pressing ? 0.97 : 1)
            .animation(.easeOut(duration: 0.08), value: pressing)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !pressing, !locked else { return }
                        pressing = true
                        if session.talkMode == .ptt { session.talkPressed() } else { session.toggleTalk() }
                    }
                    .onEnded { _ in
                        guard pressing else { return }
                        pressing = false
                        if session.talkMode == .ptt { session.talkReleased() }
                    }
            )
            .accessibilityElement()
            .accessibilityLabel(title)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("talk-button")
            .accessibilityAction { session.toggleTalk() }
    }
}

/// One obvious on/off for on-device noise removal on my mic (matches the web/desktop button).
struct VoiceIsolationButton: View {
    @EnvironmentObject var session: SessionCoordinator

    var body: some View {
        let engine = session.voiceIsolationEngine
        let on = engine != .off
        Button { session.voiceIsolation.toggle() } label: {
            HStack(spacing: 8) {
                Image(systemName: on ? "waveform.badge.minus" : "waveform")
                Text("Voice isolation \(on ? "ON" : "OFF")").font(.subheadline.weight(.semibold))
                if engine == .basic {
                    Text("basic").font(.caption2.weight(.bold)).padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().strokeBorder(.secondary))
                }
            }
            .frame(maxWidth: .infinity).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 12).fill(on ? Color.green.opacity(0.3) : Color(.secondarySystemBackground)))
        }
        .foregroundStyle(.primary)
        .accessibilityLabel("Voice isolation")
        .accessibilityValue(on ? (engine == .basic ? "On, basic" : "On") : "Off")
        .accessibilityIdentifier("voice-isolation")
    }
}

/// Home-screen talk mode switch (same as Settings): "Hold to talk" | "Tap on / off".
struct TalkModeSwitch: View {
    @EnvironmentObject var session: SessionCoordinator

    var body: some View {
        let forced = session.forcedTalkMode != nil
        VStack(spacing: 6) {
            HStack(spacing: 4) {
                segment("Hold to talk", .ptt)
                segment("Tap on / off", .latch)
            }
            .padding(4)
            .background(Capsule().fill(Color(.secondarySystemBackground)))
            .opacity(forced ? 0.5 : 1)
            .disabled(forced)
            if forced {
                Text("Talk mode set by the producer").font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("talk-mode")
    }

    private func segment(_ title: String, _ mode: TalkMode) -> some View {
        let selected = session.talkMode == mode
        return Button { session.setTalkMode(mode) } label: {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(selected ? Color.primary : Color.secondary)
                .frame(maxWidth: .infinity).padding(.vertical, 9)
                .background(Capsule().fill(selected ? Color(.tertiarySystemFill) : .clear))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Left tile: "Muted" while not live, red "Live · tap to mute" while live (tap ends talking),
/// lock "Muted by producer" when admin-muted.
private struct MicTile: View {
    @EnvironmentObject var session: SessionCoordinator

    var body: some View {
        let live = session.micLive
        let (icon, label): (String, String) = session.adminMuted ? ("lock.fill", "Muted by producer")
            : live ? ("mic.fill", "Live · tap to mute") : ("mic.slash.fill", "Muted")
        Button {
            if live { session.stopTalking() } else if session.micMuted { session.setMicMuted(false) }
        } label: {
            VStack(spacing: 4) {
                Image(systemName: icon).font(.title2)
                Text(label).font(.caption.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 12).fill(live ? Color.red.opacity(0.85) : Color(.secondarySystemBackground)))
        }
        .foregroundStyle(.primary)
        .disabled(session.adminMuted)
        .accessibilityLabel(label)
        .accessibilityIdentifier("mic-mute")
    }
}

private struct ToggleTile: View {
    var on: Bool
    var onIcon: String
    var offIcon: String
    var label: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: on ? onIcon : offIcon).font(.title2)
                Text(label).font(.caption.weight(.semibold))
            }
            .frame(maxWidth: .infinity).padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 12).fill(on ? Color.red.opacity(0.85) : Color(.secondarySystemBackground)))
        }
        .foregroundStyle(.primary)
    }
}

private struct Banner: View {
    var icon: String
    var text: String
    var color: Color

    var body: some View {
        Label(text, systemImage: icon)
            .font(.callout.weight(.semibold))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10).fill(color.opacity(0.25)))
    }
}

private struct LinkBadge: View {
    var link: SessionCoordinator.Link
    var offLine: Bool
    var rtc: Bool

    var body: some View {
        let (text, color): (String, Color) = {
            if offLine { return ("off", .gray) }
            switch link {
            case .live: return rtc ? ("live", .green) : ("audio…", .yellow)
            case .connecting: return ("connecting", .yellow)
            case .reconnecting: return ("reconnecting", .orange)
            case .serverOffline: return ("offline", .red)
            }
        }()
        return HStack(spacing: 5) {
            Circle().fill(color).frame(width: 10, height: 10)
            Text(text).font(.caption.weight(.semibold))
        }
        .accessibilityIdentifier("link-badge")
    }
}

extension Color {
    init?(hex: String?) {
        guard var s = hex?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}
