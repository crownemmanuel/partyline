import Foundation

/// Who I may text and who a reply goes to (PROTOCOL §3.1 `message.send`). Pure, for tests.
enum MessageRules {
    struct Option: Equatable, Identifiable {
        var id: TargetRef { target }
        var target: TargetRef
        var label: String
    }

    /// Admins: everyone, every group, every other device. Crew: online admins, own groups,
    /// and everyone only if `crewCanBroadcast`.
    static func composeTargets(me: Device, roster: Roster) -> [Option] {
        var out: [Option] = []
        let others = roster.devices.values.filter { $0.id != me.id }.sorted { $0.displayName < $1.displayName }
        if me.isAdmin {
            out.append(Option(target: Target.all, label: "Everyone"))
            out += roster.sortedGroups.map { Option(target: Target.group($0.id), label: $0.name) }
            out += others.map { Option(target: Target.device($0.id), label: $0.displayName) }
        } else {
            out += others.filter { $0.isAdmin && $0.live.online }
                .map { Option(target: Target.device($0.id), label: $0.displayName) }
            let mine = [me.groupId] + me.canTalkGroupIds.filter { $0 != me.groupId }
            out += mine.compactMap { id in roster.group(id).map { Option(target: Target.group(id), label: $0.name) } }
            if roster.settings.crewCanBroadcast { out.append(Option(target: Target.all, label: "Everyone")) }
        }
        return out
    }

    /// Admin involved → straight back to the sender; else the group it was sent to; else everyone
    /// if crew may broadcast; else the producer. Nil when there is nobody to reply to.
    static func replyTarget(for m: Message, me: Device, roster: Roster) -> TargetRef? {
        let sender = roster.devices[m.from]
        if sender != nil, me.isAdmin || sender?.isAdmin == true { return Target.device(m.from) }
        if m.to.hasPrefix("g:") { return m.to }
        if roster.settings.crewCanBroadcast { return Target.all }
        return roster.firstOnlineAdmin(excluding: me.id).map { Target.device($0.id) }
    }

    /// The default To: for a fresh message: the producer, else my own group.
    static func defaultTarget(me: Device, roster: Roster) -> TargetRef {
        if !me.isAdmin, let p = roster.firstOnlineAdmin(excluding: me.id) { return Target.device(p.id) }
        return me.isAdmin ? Target.all : Target.group(me.groupId)
    }

    static func describe(_ to: TargetRef, roster: Roster, myId: String) -> String {
        if to == Target.all { return "everyone" }
        if to.hasPrefix("g:") { return roster.group(String(to.dropFirst(2)))?.name ?? String(to.dropFirst(2)) }
        if to.hasPrefix("d:") {
            let id = String(to.dropFirst(2))
            return id == myId ? "you" : roster.name(of: id)
        }
        return to
    }
}
