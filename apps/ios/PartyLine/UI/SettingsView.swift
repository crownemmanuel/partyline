import AVFoundation
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var session: SessionCoordinator
    @Environment(\.dismiss) private var dismiss
    @State private var confirmForget = false
    @State private var micMode = AVCaptureDevice.activeMicrophoneMode

    var body: some View {
        NavigationStack {
            Form {
                Section("You") {
                    LabeledContent("Name", value: session.me?.displayName ?? session.suggestedName)
                    LabeledContent("Group", value: session.myGroup?.name ?? "—")
                    if session.me?.isAdmin == true { LabeledContent("Role", value: "Admin") }
                }

                Section("Server") {
                    LabeledContent("Name", value: session.serverName)
                    if let a = session.savedServerAddress { LabeledContent("Address", value: a) }
                }

                Section {
                    Picker("Talk mode", selection: Binding(get: { session.talkMode }, set: { session.setTalkMode($0) })) {
                        Text("Hold to talk").tag(TalkMode.ptt)
                        Text("Tap on / off").tag(TalkMode.latch)
                    }
                    .disabled(session.forcedTalkMode != nil)
                    Toggle("Headset button toggles talk", isOn: Binding(get: { session.headsetButtonTalks },
                                                                      set: { session.headsetButtonTalks = $0 }))
                } header: { Text("Talk") } footer: {
                    if session.forcedTalkMode != nil { Text("Talk mode set by the producer.") }
                }

                if session.listenableGroups.count > 1 {
                    Section("Listen to") {
                        ForEach(session.listenableGroups) { g in
                            Toggle(g.name, isOn: Binding(get: { session.me?.listenGroupIds.contains(g.id) ?? false },
                                                         set: { _ in session.toggleListen(group: g.id) }))
                        }
                    }
                }

                Section {
                    Toggle("Voice isolation", isOn: Binding(get: { session.voiceIsolation }, set: { session.voiceIsolation = $0 }))
                    Button {
                        AVCaptureDevice.showSystemUserInterface(.microphoneModes)
                    } label: {
                        LabeledContent("iPhone mic mode", value: micModeName)
                    }
                } header: { Text("Voice isolation") } footer: { Text(voiceFooter) }

                Section("Audio") {
                    LabeledContent("Output", value: routeName)
                    if !session.audio.hasHeadset {
                        Label("Plug in a headset to avoid echo", systemImage: "exclamationmark.triangle").foregroundStyle(.yellow)
                    }
                    Toggle("Read messages aloud", isOn: Binding(get: { session.speakMessages }, set: { session.speakMessages = $0 }))
                    Toggle("Join the line when the app opens", isOn: Binding(get: { session.autoJoinCall }, set: { session.autoJoinCall = $0 }))
                }

                Section {
                    if session.phase == .onLine {
                        Button("Leave the line", role: .destructive) {
                            session.leave()
                            dismiss()
                        }
                    }
                    Button("Forget this server", role: .destructive) { confirmForget = true }
                }

                Section {
                    LabeledContent("App version", value: API.appVersion)
                    LabeledContent("Device id", value: String(session.myId.prefix(8)))
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
                micMode = AVCaptureDevice.activeMicrophoneMode
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Forget \(session.serverName)? You'll need a join code to come back.",
                                isPresented: $confirmForget, titleVisibility: .visible) {
                Button("Forget server", role: .destructive) {
                    session.forgetServer()
                    dismiss()
                }
            }
        }
    }

    private var micModeName: String {
        switch micMode {
        case .voiceIsolation: "Voice Isolation"
        case .wideSpectrum: "Wide Spectrum"
        default: "Standard"
        }
    }

    private var voiceFooter: String {
        switch session.voiceIsolationEngine {
        case .deepFilter: "Removes background noise from your mic on this phone (DeepFilterNet, offline)."
        case .basic: "Basic noise suppression: DeepFilterNet isn't in this build."
        case .off: "Your mic is sent without noise removal (echo cancellation stays on)."
        }
    }

    private var routeName: String {
        switch session.audio.route {
        case .headset: "Wired headset"
        case .bluetooth: "Bluetooth"
        case .speaker: "Phone speaker"
        case .earpiece: "Earpiece"
        }
    }
}
