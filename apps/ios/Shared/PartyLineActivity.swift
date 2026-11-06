import ActivityKit
import AppIntents
import Foundation

/// Live Activity shown on the lock screen and in the Dynamic Island while on the line.
/// Compiled into both the app and the PartyLineWidgets extension.
@available(iOS 16.2, *)
struct PartyLineActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        enum Mic: String, Codable, Hashable { case muted, live, locked }
        enum Link: String, Codable, Hashable { case live, connecting, reconnecting, offline }

        var mic: Mic
        var link: Link
        /// Display names of people I can hear talking right now.
        var talking: [String]
        var messageFrom: String?
        var messageText: String?
        var messageDate: Date?
        var unread: Int
        var canUnmute: Bool?
    }

    /// Binds wrist actions to the line that rendered them.
    var controlID: String?
    var serverName: String
    var groupName: String
    /// "#RRGGBB" group colour, if the host set one.
    var groupColor: String?
}

extension Notification.Name {
    static let partyLineSetActivityMic = Notification.Name("partyline.setActivityMic")
}

@available(iOS 17.0, *)
struct SetActivityMicIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Set intercom microphone"

    @Parameter(title: "Activity") var activityID: String
    @Parameter(title: "Microphone live") var live: Bool

    init() {}

    init(activityID: String, live: Bool) {
        self.activityID = activityID
        self.live = live
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        NotificationCenter.default.post(name: .partyLineSetActivityMic, object: self)
        return .result()
    }
}
