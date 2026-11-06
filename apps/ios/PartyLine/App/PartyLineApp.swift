import SwiftUI

@main
struct PartyLineApp: App {
    @StateObject private var session = SessionCoordinator()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .onAppear { session.launch() }
                .onOpenURL { session.handle(url: $0) }
                .onChange(of: scenePhase) { phase in
                    if phase == .active { session.appBecameActive() }
                }
                .preferredColorScheme(.dark)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var session: SessionCoordinator

    var body: some View {
        Group {
            switch session.phase {
            case .launching: ProgressView()
            case .discovering: DiscoveryView()
            case .joining: JoinView()
            case .onLine, .offLine: CrewView()
            }
        }
        .overlay(alignment: .top) {
            MessagePopup()
                .padding(.top, 8)
                .animation(.spring(response: 0.3, dampingFraction: 0.85), value: session.popupQueue.first?.id)
        }
        .alert("Trust this server?", isPresented: Binding(get: { session.trustRequest != nil },
                                                          set: { if !$0 { session.answerTrust(false) } }),
               presenting: session.trustRequest) { req in
            Button(req.replacesPin == nil ? "Trust" : "Trust new certificate", role: req.replacesPin == nil ? nil : .destructive) {
                session.answerTrust(true)
            }
            Button("Cancel", role: .cancel) { session.answerTrust(false) }
        } message: { req in
            if req.replacesPin != nil {
                Text("\(req.server.name) has a different certificate than last time. Hosts renew it about every two years; otherwise only continue if the host was reinstalled.\n\nNew: \(Fingerprint.display(req.server.fingerprint))\n\nCheck it matches the host's screen.")
            } else {
                Text("\(req.server.name) at \(req.server.address.display)\n\nFingerprint: \(Fingerprint.display(req.server.fingerprint))\n\nCheck it matches the host's screen.")
            }
        }
        .alert("PartyLine", isPresented: Binding(get: { session.errorText != nil }, set: { if !$0 { session.errorText = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(session.errorText ?? "")
        }
    }
}
