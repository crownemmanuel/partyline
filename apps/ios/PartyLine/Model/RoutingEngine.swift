import Foundation

/// PROTOCOL.md §5.1, identical on every client. Pure: no LiveKit types, so it is unit-testable.
struct RoutingEngine {
    struct Playback: Equatable {
        var enabled: Bool
        var volume: Double
    }

    struct Result: Equatable {
        /// Device ids allowed to subscribe to my mic (publisher side, server-enforced by LiveKit).
        var allowedSubscribers: Set<String>
        /// Per remote device id: whether to play its audio and at what volume (receiver side).
        var playback: [String: Playback]

        /// Remote devices I would hear right now, ignoring local speaker mute.
        var audible: Set<String>
    }

    /// My own state. Passed separately from the roster because PTT / reply-to-producer are
    /// optimistic: local values apply before the server echoes them back.
    struct Me {
        var id: String
        var talkTargets: [TargetRef]
        var listenGroupIds: [String]
        var speakerMuted: Bool
    }

    static func compute(roster: Roster,
                        me: Me,
                        localMute: Set<String> = [],
                        localVolume: [String: Double] = [:]) -> Result {
        let myTargets = Set(me.talkTargets)
        var allowed = Set<String>()
        var playback: [String: Playback] = [:]
        var audible = Set<String>()

        for d in roster.devices.values where d.id != me.id {
            // Publisher side
            if d.listenGroupIds.contains(where: { myTargets.contains(Target.group($0)) }) { allowed.insert(d.id) }
            if myTargets.contains(Target.device(d.id)) { allowed.insert(d.id) }
            if d.isAdmin, !myTargets.isEmpty, roster.settings.adminsHearEverything { allowed.insert(d.id) }

            // Receiver side
            let theirTargets = Set(d.live.talkTargets)
            let hear = !d.adminMuted && (
                me.listenGroupIds.contains(where: { theirTargets.contains(Target.group($0)) })
                    || theirTargets.contains(Target.device(me.id)))
            if hear { audible.insert(d.id) }
            playback[d.id] = Playback(enabled: hear && !me.speakerMuted && !localMute.contains(d.id),
                                      volume: localVolume[d.id] ?? 1.0)
        }
        return Result(allowedSubscribers: allowed, playback: playback, audible: audible)
    }

    /// Effective talk mode: server-forced wins, then my saved choice, then group default, then server default.
    static func effectiveTalkMode(me: Device, saved: TalkMode?, roster: Roster) -> TalkMode {
        if let forced = me.forcedTalkMode { return forced }
        if let saved { return saved }
        if let g = roster.group(me.groupId)?.defaultTalkMode { return g }
        return roster.settings.defaultTalkMode
    }

    /// Default talk targets for a device that has none: its home group.
    static func defaultTalkTargets(for me: Device) -> [TargetRef] {
        me.live.talkTargets.isEmpty ? [Target.group(me.groupId)] : me.live.talkTargets
    }
}
