import SwiftUI

struct JoinView: View {
    @EnvironmentObject var session: SessionCoordinator
    @State private var code = ""
    @State private var name = ""
    @FocusState private var nameFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                if let p = session.pendingJoin {
                    Text(p.name).font(.title2.bold())
                    Text(p.address.display).font(.footnote).foregroundStyle(.secondary)
                }

                VStack(spacing: 8) {
                    Text("Join code").font(.subheadline).foregroundStyle(.secondary)
                    HStack(spacing: 8) {
                        ForEach(0..<6, id: \.self) { i in
                            Text(digit(i))
                                .font(.system(size: 30, weight: .semibold, design: .monospaced))
                                .frame(width: 42, height: 54)
                                .background(RoundedRectangle(cornerRadius: 8).fill(Color(.secondarySystemBackground)))
                        }
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Join code \(code)")
                }

                TextField("Your name, e.g. Camera 2", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .font(.title3)
                    .focused($nameFocused)
                    .submitLabel(.join)
                    .onSubmit(join)
                    .accessibilityIdentifier("name-field")
                    .padding(.horizontal)

                KeyPad(code: $code)

                Button(action: join) {
                    Text("Join").font(.title3.bold()).frame(maxWidth: .infinity).padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .disabled(code.count != 6 || name.trimmingCharacters(in: .whitespaces).isEmpty || session.busy)
                .padding(.horizontal)
                .accessibilityIdentifier("join-button")
            }
            .padding(.vertical)
            .overlay { if session.busy { ProgressView().controlSize(.large) } }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Back") { session.cancelJoin() } }
            }
            .onAppear {
                code = session.pendingJoin?.prefilledCode ?? ""
                name = session.suggestedName
            }
        }
    }

    private func digit(_ i: Int) -> String {
        let chars = Array(code)
        return i < chars.count ? String(chars[i]) : ""
    }

    private func join() {
        nameFocused = false
        session.join(code: code, name: name)
    }
}

private struct KeyPad: View {
    @Binding var code: String
    private let rows = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["", "0", "⌫"]]

    var body: some View {
        VStack(spacing: 8) {
            ForEach(rows, id: \.self) { row in
                HStack(spacing: 8) {
                    ForEach(row, id: \.self) { key in
                        Button {
                            if key == "⌫" { if !code.isEmpty { code.removeLast() } } else if code.count < 6 { code.append(key) }
                        } label: {
                            Text(key).font(.title.weight(.medium)).frame(width: 84, height: 52)
                                .background(RoundedRectangle(cornerRadius: 10).fill(key.isEmpty ? .clear : Color(.tertiarySystemBackground)))
                        }
                        .disabled(key.isEmpty)
                        .foregroundStyle(.primary)
                        .accessibilityIdentifier("key-\(key)")
                    }
                }
            }
        }
    }
}
