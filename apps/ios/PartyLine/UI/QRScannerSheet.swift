import SwiftUI
import VisionKit

/// Scans the host's join QR (`https://<ip>:8443/#join?code=…&fp=…&id=…`).
struct QRScannerSheet: View {
    var onScan: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var pasted = ""

    var body: some View {
        NavigationStack {
            Group {
                if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                    Scanner(onScan: onScan).ignoresSafeArea()
                } else {
                    Form {
                        Text("Camera scanning isn't available here. Paste the join link instead.")
                        TextField("https://…#join?code=…", text: $pasted)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Use link") { onScan(pasted) }.disabled(pasted.isEmpty)
                    }
                }
            }
            .navigationTitle("Scan join code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private struct Scanner: UIViewControllerRepresentable {
        var onScan: (String) -> Void

        func makeUIViewController(context: Context) -> DataScannerViewController {
            let vc = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
                                               qualityLevel: .balanced, isHighlightingEnabled: true)
            vc.delegate = context.coordinator
            try? vc.startScanning()
            return vc
        }

        func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

        func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

        final class Coordinator: NSObject, DataScannerViewControllerDelegate {
            let onScan: (String) -> Void
            private var done = false
            init(onScan: @escaping (String) -> Void) { self.onScan = onScan }

            func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
                for item in addedItems {
                    if case let .barcode(code) = item, let s = code.payloadStringValue, s.contains("#join"), !done {
                        done = true
                        dataScanner.stopScanning()
                        onScan(s)
                    }
                }
            }
        }
    }
}
