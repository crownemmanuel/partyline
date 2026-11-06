import CryptoKit
import Foundation
import Security

/// Certificate pinning, trust-on-first-use (ARCHITECTURE §5.3).
/// The server cert is self-signed, so the only thing that matters is the sha256 of the leaf
/// DER matching the pin saved for that serverId. Hostname is not checked: we pin the key.
enum Fingerprint {
    static func normalize(_ fp: String) -> String {
        fp.lowercased().filter { $0.isHexDigit }
    }

    static func of(certificate: SecCertificate) -> String {
        let der = SecCertificateCopyData(certificate) as Data
        return SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
    }

    static func ofLeaf(trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
        return of(certificate: leaf)
    }

    /// "ab12 cd34 ef56 …" — first 16 bytes grouped, for the TOFU prompt.
    static func display(_ fp: String) -> String {
        let hex = Array(normalize(fp).prefix(32))
        return stride(from: 0, to: hex.count, by: 4).map { String(hex[$0..<min($0 + 4, hex.count)]) }.joined(separator: " ")
    }
}

/// URLSession delegate that enforces a pin, or (pin == nil) accepts any cert once and records
/// what it saw so the user can be asked to trust it.
final class PinningDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var _pin: String?
    private var _observed: String?

    var onWebSocketOpen: (() -> Void)?
    var onWebSocketClose: ((URLSessionWebSocketTask.CloseCode) -> Void)?

    init(pin: String?) { _pin = pin.map(Fingerprint.normalize) }

    var pin: String? {
        get { lock.withLock { _pin } }
        set { lock.withLock { _pin = newValue.map(Fingerprint.normalize) } }
    }

    var observedFingerprint: String? { lock.withLock { _observed } }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        handle(challenge, completionHandler)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        handle(challenge, completionHandler)
    }

    private func handle(_ challenge: URLAuthenticationChallenge,
                        _ completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let fp = Fingerprint.ofLeaf(trust: trust) else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        let pin = lock.withLock { () -> String? in
            _observed = fp
            return _pin
        }
        if pin == nil || pin == fp {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        onWebSocketOpen?()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        onWebSocketClose?(closeCode)
    }
}

/// Thread-safe "first caller wins" flag for resuming continuations from callback APIs.
final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false

    /// Returns true exactly once.
    func claim() -> Bool { lock.withLock { if fired { return false }; fired = true; return true } }
}
