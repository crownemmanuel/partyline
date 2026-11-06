import MediaPlayer

/// Headset button → talk toggle via MPRemoteCommandCenter (IOS.md Input module).
///
/// The remote command center only reports discrete presses, not press-and-hold, so the headset
/// button always acts as a talk toggle (latch-style) regardless of on-screen talk mode.
/// During a CallKit call some headsets send their button to CallKit instead (mute/end);
/// that path is handled by CallController's CXSetMutedCallAction.
@MainActor
final class RemoteCommands {
    var onToggleTalk: (() -> Void)?
    private var targets: [Any] = []

    func enable() {
        guard targets.isEmpty else { return }
        let c = MPRemoteCommandCenter.shared()
        let handler: (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus = { [weak self] _ in
            Task { @MainActor in self?.onToggleTalk?() }
            return .success
        }
        for cmd in [c.togglePlayPauseCommand, c.playCommand, c.pauseCommand] {
            cmd.isEnabled = true
            targets.append(cmd.addTarget(handler: handler))
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [MPMediaItemPropertyTitle: "PartyLine intercom"]
    }

    func disable() {
        let c = MPRemoteCommandCenter.shared()
        for cmd in [c.togglePlayPauseCommand, c.playCommand, c.pauseCommand] {
            cmd.removeTarget(nil)
            cmd.isEnabled = false
        }
        targets.removeAll()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
}
