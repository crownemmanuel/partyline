import Foundation
import LiveKit
import os

/// LiveKit room: one muted-by-default mic track that is always published, publisher-side
/// subscription permissions and receiver-side playback per RoutingEngine (PROTOCOL §5).
@MainActor
final class RoomController: NSObject, ObservableObject {
    enum Connection: Equatable { case disconnected, connecting, connected, reconnecting }

    @Published private(set) var connection: Connection = .disconnected
    /// Device ids LiveKit reports as speaking (voice activity), me included.
    @Published private(set) var speakingIds: Set<String> = []

    /// Participants or tracks changed: routing must be re-applied.
    var onRosterChange: (() -> Void)?
    /// rtcConnected / speaking changed: status must be reported now.
    var onStatusChange: (() -> Void)?

    private(set) var rttMs: Double?
    private let log = Logger(subsystem: "com.partyline.app", category: "room")
    private lazy var room = Room(delegate: self)
    private var micTrack: LocalAudioTrack?
    private var myId: String?
    private var lastRouting: RoutingEngine.Result?
    private var lastAllowedSids: Set<String>?

    private var micDesired = false
    /// WebRTC's own noise suppression on the mic track ("basic" voice isolation). Off while
    /// DeepFilterNet runs: stacking both smears speech.
    private(set) var noiseSuppression = true
    private var micReconciling = false

    var isConnected: Bool { connection == .connected }
    var localSpeaking: Bool { myId.map { speakingIds.contains($0) } ?? false }

    func connect(url: String, token: String, myId: String) async throws {
        self.myId = myId
        if connection == .connected || connection == .connecting || connection == .reconnecting { return }
        connection = .connecting
        // LAN only: a healthy handshake takes well under a second. Fail fast and let the
        // coordinator retry instead of waiting out the SDK's default timeouts.
        let connectOptions = ConnectOptions(autoSubscribe: true, reconnectAttempts: 30, socketConnectTimeoutInterval: 5,
                                            primaryTransportConnectTimeout: 5, publisherTransportConnectTimeout: 5,
                                            enableMicrophone: false)
        let roomOptions = RoomOptions(adaptiveStream: false, dynacast: false, stopLocalTrackOnUnpublish: true)
        do {
            try await room.connect(url: url, token: token, connectOptions: connectOptions, roomOptions: roomOptions)
        } catch {
            connection = .disconnected
            throw error
        }
        connection = .connected
        lastAllowedSids = nil
        try await publishMic()
        onRosterChange?()
        onStatusChange?()
    }

    func disconnect() async {
        micTrack = nil
        lastAllowedSids = nil
        await room.disconnect()
        connection = .disconnected
        speakingIds = []
    }

    /// Publish once, muted, with nobody permitted until routing runs (ARCHITECTURE §4.3).
    private func publishMic() async throws {
        let lp = room.localParticipant
        if lp.audioTracks.contains(where: { $0.name == "mic" }) { return }
        try await lp.setTrackSubscriptionPermissions(allParticipantsAllowed: false, trackPermissions: [])
        let track = await LocalAudioTrack.createTrack(
            name: "mic",
            options: AudioCaptureOptions(echoCancellation: true, autoGainControl: true, noiseSuppression: noiseSuppression,
                                         highpassFilter: true),
            reportStatistics: true)
        track.add(delegate: self)
        let options = AudioPublishOptions(name: "mic", encoding: AudioEncoding(maxBitrate: 32000), dtx: true, red: true)
        _ = try await lp.publish(audioTrack: track, options: options)
        micTrack = track
        if !micDesired { try? await track.mute() }
        reconcileMic()
    }

    /// Capture options are fixed per track, so a change re-publishes the mic (a ~100 ms gap).
    func setNoiseSuppression(_ on: Bool) {
        guard on != noiseSuppression else { return }
        noiseSuppression = on
        guard connection == .connected, micTrack != nil else { return }
        Task {
            micTrack = nil
            if let pub = room.localParticipant.audioTracks.first(where: { $0.name == "mic" }) as? LocalTrackPublication {
                try? await room.localParticipant.unpublish(publication: pub)
            }
            lastAllowedSids = nil
            do { try await publishMic() } catch { log.error("mic re-publish failed: \(error.localizedDescription)") }
            reapply()
        }
    }

    /// PTT: called on button down/up at the same time as `state.set` (PROTOCOL §6.3).
    func setMicLive(_ live: Bool) {
        micDesired = live
        reconcileMic()
    }

    private func reconcileMic() {
        guard !micReconciling, let track = micTrack else { return }
        micReconciling = true
        Task {
            while let t = micTrack, t === track, t.isMuted == micDesired {
                do {
                    if micDesired { try await t.unmute() } else { try await t.mute() }
                } catch {
                    log.error("mic \(self.micDesired ? "unmute" : "mute") failed: \(error.localizedDescription)")
                    break
                }
            }
            micReconciling = false
        }
    }

    func apply(_ routing: RoutingEngine.Result) {
        lastRouting = routing
        guard connection == .connected else { return }
        let remotes = room.remoteParticipants.values

        var allowedSids = Set<String>()
        for p in remotes {
            if let id = p.identity?.stringValue, routing.allowedSubscribers.contains(id), let sid = p.sid?.stringValue {
                allowedSids.insert(sid)
            }
        }
        if allowedSids != lastAllowedSids {
            lastAllowedSids = allowedSids
            let perms = allowedSids.map { ParticipantTrackPermission(participantSid: $0, allTracksAllowed: true) }
            Task {
                do { try await room.localParticipant.setTrackSubscriptionPermissions(allParticipantsAllowed: false, trackPermissions: perms) } catch {
                    log.error("permissions failed: \(error.localizedDescription)")
                    lastAllowedSids = nil
                }
            }
        }

        for p in remotes {
            guard let id = p.identity?.stringValue else { continue }
            let play = routing.playback[id] ?? RoutingEngine.Playback(enabled: false, volume: 1)
            for pub in p.audioTracks {
                guard let rpub = pub as? RemoteTrackPublication else { continue }
                if let track = rpub.track as? RemoteAudioTrack { track.volume = play.enabled ? play.volume : 0 }
                if rpub.isSubscribed, rpub.isEnabled != play.enabled {
                    Task { try? await rpub.set(enabled: play.enabled) }
                }
            }
        }
    }

    private func reapply() {
        if let lastRouting { apply(lastRouting) }
        onRosterChange?()
    }

    private func setConnection(_ c: Connection) {
        guard c != connection else { return }
        connection = c
        onStatusChange?()
    }
}

extension RoomController: RoomDelegate {
    nonisolated func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState, from oldConnectionState: ConnectionState) {
        Task { @MainActor in
            switch connectionState {
            case .connected: self.setConnection(.connected)
            case .reconnecting: self.setConnection(.reconnecting)
            case .connecting: self.setConnection(.connecting)
            case .disconnected: self.setConnection(.disconnected); self.micTrack = nil; self.lastAllowedSids = nil
            default: break
            }
        }
    }

    nonisolated func room(_ room: Room, didCompleteReconnectWithMode reconnectMode: ReconnectMode) {
        Task { @MainActor in
            // A full reconnect re-publishes only unmuted tracks; the mic must always be published.
            self.lastAllowedSids = nil
            if !room.localParticipant.audioTracks.contains(where: { $0.name == "mic" }) {
                self.micTrack = nil
                try? await self.publishMic()
            }
            self.reapply()
        }
    }

    nonisolated func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        Task { @MainActor in self.lastAllowedSids = nil; self.reapply() }
    }

    nonisolated func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        Task { @MainActor in self.reapply() }
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
        Task { @MainActor in self.reapply() }
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant, didPublishTrack publication: RemoteTrackPublication) {
        Task { @MainActor in self.reapply() }
    }

    nonisolated func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) {
        let ids = Set(participants.compactMap { $0.identity?.stringValue })
        Task { @MainActor in
            let wasSpeaking = self.localSpeaking
            self.speakingIds = ids
            if wasSpeaking != self.localSpeaking { self.onStatusChange?() }
        }
    }
}

extension RoomController: TrackDelegate {
    nonisolated func track(_ track: Track, didUpdateStatistics statistics: TrackStatistics, simulcastStatistics: [VideoCodec: TrackStatistics]) {
        let rtt = statistics.iceCandidatePair.compactMap(\.currentRoundTripTime).first
        Task { @MainActor in self.rttMs = rtt.map { ($0 * 1000).rounded() } }
    }
}
