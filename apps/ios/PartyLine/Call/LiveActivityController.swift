import ActivityKit
import Foundation
import os

/// Owns the one PartyLine Live Activity: started when on the line, updated as the crew screen
/// changes, ended on leave. Updates are local (no push), which works because the app keeps
/// running its intercom audio session in the background.
@available(iOS 16.2, *)
@MainActor
final class LiveActivityController {
    typealias State = PartyLineActivityAttributes.ContentState

    private let log = Logger(subsystem: "com.partyline.app", category: "live-activity")
    private var activity: Activity<PartyLineActivityAttributes>?
    var activityID: String? { attributes?.controlID }
    private var attributes: PartyLineActivityAttributes?
    private var lastState: State?

    init() {
        // A previous run may have left one behind (crash, force quit).
        for a in Activity<PartyLineActivityAttributes>.activities {
            Task { await a.end(nil, dismissalPolicy: .immediate) }
        }
    }

    /// Start (or restart if the server/group changed) and push the latest state.
    func show(_ attrs: PartyLineActivityAttributes, _ state: State) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        if let a = activity, attributes?.serverName == attrs.serverName, attributes?.groupName == attrs.groupName,
           attributes?.groupColor == attrs.groupColor {
            guard state != lastState else { return }
            lastState = state
            Task { await a.update(ActivityContent(state: state, staleDate: nil)) }
            return
        }
        end()
        do {
            var attrs = attrs
            attrs.controlID = UUID().uuidString
            activity = try Activity.request(attributes: attrs, content: ActivityContent(state: state, staleDate: nil),
                                            pushType: nil)
            attributes = attrs
            lastState = state
        } catch {
            log.error("live activity request failed: \(error.localizedDescription)")
        }
    }

    func end() {
        guard let a = activity else { return }
        activity = nil
        attributes = nil
        lastState = nil
        Task { await a.end(nil, dismissalPolicy: .immediate) }
    }
}
