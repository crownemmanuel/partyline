package com.partyline.model

/**
 * PROTOCOL §5.1, verbatim. Pure so it can be unit-tested; [com.partyline.audio.RoomController]
 * applies the result to LiveKit.
 */
object RoutingEngine {

    data class Playback(val enabled: Boolean, val volume: Double)

    data class Result(
        /** Identities allowed to subscribe to my mic (publisher side, server-enforced). */
        val allowedSubscribers: Set<String>,
        /** Per remote identity: whether to play and at what volume (receiver side). */
        val playback: Map<String, Playback>,
        /**
         * Roster devices whose voice is routed to me (talk targets reach my listen groups or me),
         * whether or not their LiveKit track exists yet; local mutes ignored. Same as iOS.
         */
        val audible: Set<String> = emptySet(),
    ) {
        /** Identities whose audio I should be hearing right now (ignoring local speaker mute). */
        fun playing(): Set<String> = playback.filterValues { it.enabled }.keys
    }

    fun compute(
        myId: String,
        roster: Map<String, Device>,
        settings: Settings,
        remoteIdentities: Collection<String>,
        localMute: Map<String, Boolean> = emptyMap(),
        localVolume: Map<String, Double> = emptyMap(),
    ): Result {
        val me = roster[myId] ?: return Result(emptySet(), remoteIdentities.associateWith { Playback(false, 1.0) })
        val myTargets = me.live.talkTargets.toSet()

        val allowed = mutableSetOf<String>()
        for (d in roster.values) {
            if (d.id == myId) continue
            if (d.listenGroupIds.any { Targets.group(it) in myTargets }) allowed += d.id
            if (Targets.device(d.id) in myTargets) allowed += d.id
            if (d.isAdmin && myTargets.isNotEmpty() && settings.adminsHearEverything) allowed += d.id
        }

        val myListen = me.listenGroupIds.toSet()
        fun hears(d: Device?): Boolean = d != null && d.id != myId && !d.adminMuted && (
            d.live.talkTargets.any { ref -> Targets.groupId(ref)?.let { it in myListen } == true } ||
                Targets.device(myId) in d.live.talkTargets
            )
        val playback = remoteIdentities.associateWith { identity ->
            Playback(
                enabled = hears(roster[identity]) && !me.live.speakerMuted && localMute[identity] != true,
                volume = localVolume[identity] ?: 1.0,
            )
        }
        val audible = roster.values.filter { hears(it) }.map { it.id }.toSet()
        return Result(allowed, playback, audible)
    }

    /**
     * "Talking: …" line, as on iOS: devices routed to me whose mic is live, or that voice
     * detection hears ([speakingIds]). Does not wait for voice detection: a quiet or noise-gated
     * talker still shows while their mic is open.
     */
    fun talkingNames(roster: Map<String, Device>, audible: Set<String>, speakingIds: Set<String>): List<String> =
        roster.values
            .filter { it.id in audible && (it.live.micLive || it.id in speakingIds) }
            .map { it.displayName }
            .sorted()

    /** "Reply to producer" target (§6.4): the first online admin other than me, by name. */
    fun replyTarget(myId: String, roster: Map<String, Device>): String? =
        roster.values
            .filter { it.isAdmin && it.id != myId && it.live.online }
            .minByOrNull { it.displayName.lowercase() }
            ?.let { Targets.device(it.id) }
}
