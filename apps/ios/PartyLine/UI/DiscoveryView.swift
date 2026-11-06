import SwiftUI

struct DiscoveryView: View {
    @EnvironmentObject var session: SessionCoordinator
    @State private var manual = ""
    @State private var scanning = false

    var body: some View {
        DiscoveryList(browser: session.browser, manual: $manual, scanning: $scanning)
    }
}

private struct DiscoveryList: View {
    @EnvironmentObject var session: SessionCoordinator
    @ObservedObject var browser: BonjourBrowser
    @Binding var manual: String
    @Binding var scanning: Bool

    var body: some View {
        NavigationStack {
            List {
                Image("Logo")
                    .resizable()
                    .frame(width: 96, height: 96)
                    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                    .accessibilityHidden(true)
                Section {
                    if browser.servers.isEmpty {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Looking for PartyLine…").foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 8)
                    }
                    ForEach(browser.servers) { s in
                        Button { session.select(s) } label: {
                            HStack {
                                Image(systemName: "dot.radiowaves.left.and.right").foregroundStyle(.green)
                                VStack(alignment: .leading) {
                                    Text(s.name).font(.headline)
                                    if let fp = s.fingerprint { Text(Fingerprint.display(fp)).font(.caption.monospaced()).foregroundStyle(.secondary) }
                                }
                                Spacer()
                                Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                            }
                        }
                        .accessibilityIdentifier("server-\(s.name)")
                    }
                } header: {
                    Text("On this Wi-Fi")
                } footer: {
                    if let e = browser.error { Text(e) }
                }

                Section("Or enter the address") {
                    TextField("192.168.1.20 or partyline.local", text: $manual)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit { session.connectManually(manual) }
                        .accessibilityIdentifier("manual-address")
                    Button("Connect") { session.connectManually(manual) }
                        .disabled(manual.trimmingCharacters(in: .whitespaces).isEmpty)
                }

                Section {
                    Button { scanning = true } label: { Label("Scan join QR code", systemImage: "qrcode.viewfinder") }
                }
            }
            .navigationTitle("PartyLine")
            .overlay { if session.busy { ProgressView().controlSize(.large) } }
            .sheet(isPresented: $scanning) {
                QRScannerSheet { code in
                    scanning = false
                    session.connectManually(code)
                }
            }
        }
    }
}
