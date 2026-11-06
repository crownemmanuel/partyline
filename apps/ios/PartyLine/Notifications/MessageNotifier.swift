import AVFoundation
import UIKit
import UserNotifications

/// Short synthesized tones played into the call audio. Kept in memory, no asset files.
@MainActor
final class Tones {
    enum Kind { case message, signal, disconnected, reconnected }

    private var players: [Kind: AVAudioPlayer] = [:]

    init() {
        players[.message] = Self.player(notes: [(880, 0.09), (1320, 0.12)])
        players[.signal] = Self.player(notes: [(1000, 0.12), (0, 0.05), (1000, 0.12), (0, 0.05), (1000, 0.12)])
        players[.disconnected] = Self.player(notes: [(660, 0.15), (440, 0.25)])
        players[.reconnected] = Self.player(notes: [(440, 0.12), (660, 0.18)])
    }

    func play(_ kind: Kind) {
        guard let p = players[kind] else { return }
        p.currentTime = 0
        p.play()
    }

    private static func player(notes: [(freq: Double, dur: Double)]) -> AVAudioPlayer? {
        let rate = 16000.0
        var samples: [Int16] = []
        for n in notes {
            let count = Int(n.dur * rate)
            for i in 0..<count {
                let env = min(1, Double(i) / 160, Double(count - i) / 160)
                let v = n.freq == 0 ? 0 : sin(2 * .pi * n.freq * Double(i) / rate) * 0.35 * env
                samples.append(Int16(v * Double(Int16.max)))
            }
        }
        return try? AVAudioPlayer(data: wav(samples, rate: Int(rate)))
    }

    private static func wav(_ samples: [Int16], rate: Int) -> Data {
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let dataLen = UInt32(samples.count * 2)
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + dataLen); d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(dataLen)
        samples.forEach { s in withUnsafeBytes(of: s.littleEndian) { d.append(contentsOf: $0) } }
        return d
    }
}

/// Lock-screen notifications, haptics, tones and optional spoken readout for messages and signals.
@MainActor
final class MessageNotifier: NSObject {
    let tones = Tones()
    private let speech = AVSpeechSynthesizer()
    var speakMessages = false
    /// Lock-screen actions on a message notification: (messageId, typed text) and messageId.
    var onReply: ((String, String) -> Void)?
    var onClose: ((String) -> Void)?

    static let messageCategory = "MESSAGE"
    static let replyAction = "REPLY"
    static let closeAction = "CLOSE"

    func requestAuthorization() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let reply = UNTextInputNotificationAction(identifier: Self.replyAction, title: "Reply", options: [],
                                                  textInputButtonTitle: "Send", textInputPlaceholder: "Message")
        let close = UNNotificationAction(identifier: Self.closeAction, title: "Close", options: [])
        center.setNotificationCategories([UNNotificationCategory(identifier: Self.messageCategory, actions: [reply, close],
                                                                 intentIdentifiers: [])])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func message(from sender: String, text: String, id: String) {
        tones.play(.message)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        if speakMessages {
            let u = AVSpeechUtterance(string: "\(sender): \(text)")
            u.rate = AVSpeechUtteranceDefaultSpeechRate * 1.1
            speech.speak(u)
        }
        post(id: "m-\(id)", title: sender, body: text, sound: true, messageId: id)
    }

    /// Attention signal: vibrates and plays even when speaker-muted (PROTOCOL §6.7).
    func signal(from sender: String) {
        tones.play(.signal)
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        post(id: "s-\(UUID().uuidString)", title: "Attention", body: "\(sender) is calling you", sound: true, critical: true)
    }

    func notice(_ text: String) {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        post(id: "n-\(UUID().uuidString)", title: "PartyLine", body: text, sound: false)
    }

    func clearDelivered() {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }

    private func post(id: String, title: String, body: String, sound: Bool, critical: Bool = false, messageId: String? = nil) {
        // Only when backgrounded; in the foreground the app shows it itself.
        guard UIApplication.shared.applicationState != .active else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if sound { content.sound = .default }
        content.interruptionLevel = critical ? .timeSensitive : .active
        if let messageId {
            content.categoryIdentifier = Self.messageCategory
            content.userInfo = ["messageId": messageId]
        }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }
}

extension MessageNotifier: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let id = response.notification.request.content.userInfo["messageId"] as? String
        let action = response.actionIdentifier
        let text = (response as? UNTextInputNotificationResponse)?.userText
        Task { @MainActor in
            if let id {
                if action == Self.replyAction, let text { self.onReply?(id, text) }
                if action == Self.closeAction { self.onClose?(id) }
            }
            completionHandler()
        }
    }
}
