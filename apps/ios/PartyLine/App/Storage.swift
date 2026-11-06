import Foundation
import Security

/// Keychain items: deviceId, deviceToken, pinned fingerprint per serverId (IOS.md "Keychain access").
enum Keychain {
    private static let service = "com.partyline.app"

    static func get(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: key, kSecReturnData as String: true,
                                kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(_ key: String, _ value: String?) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                   kSecAttrAccount as String: key]
        SecItemDelete(base as CFDictionary)
        guard let value else { return }
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        // Readable after first unlock so a relaunch with the phone locked can still rejoin.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}

/// The server this phone is paired with.
struct SavedServer: Codable, Equatable {
    var serverId: String
    var name: String
    var address: ServerAddress
}

@MainActor
final class Storage {
    static let shared = Storage()
    private let defaults = UserDefaults.standard

    var deviceId: String {
        if let id = Keychain.get("deviceId") { return id }
        let id = UUID().uuidString.lowercased()
        Keychain.set("deviceId", id)
        return id
    }

    var deviceToken: String? {
        get { Keychain.get("deviceToken") }
        set { Keychain.set("deviceToken", newValue) }
    }

    func pin(for serverId: String) -> String? { Keychain.get("pin.\(serverId)") }
    func setPin(_ fp: String?, for serverId: String) { Keychain.set("pin.\(serverId)", fp.map(Fingerprint.normalize)) }

    var savedServer: SavedServer? {
        get { defaults.data(forKey: "savedServer").flatMap { try? JSONDecoder().decode(SavedServer.self, from: $0) } }
        set { defaults.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "savedServer") }
    }

    var displayName: String {
        get { defaults.string(forKey: "displayName") ?? "" }
        set { defaults.set(newValue, forKey: "displayName") }
    }

    var savedTalkMode: TalkMode? {
        get { defaults.string(forKey: "talkMode").flatMap(TalkMode.init) }
        set { defaults.set(newValue?.rawValue, forKey: "talkMode") }
    }

    var autoJoinCall: Bool {
        get { defaults.object(forKey: "autoJoinCall") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "autoJoinCall") }
    }

    var speakMessages: Bool {
        get { defaults.bool(forKey: "speakMessages") }
        set { defaults.set(newValue, forKey: "speakMessages") }
    }

    var headsetButtonTalks: Bool {
        get { defaults.object(forKey: "headsetButtonTalks") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "headsetButtonTalks") }
    }

    /// "Voice isolation" button; on by default, remembered per device.
    var voiceIsolation: Bool {
        get { defaults.object(forKey: "voiceIsolation") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "voiceIsolation") }
    }

    var lastMessageTs: String? {
        get { defaults.string(forKey: "lastMessageTs") }
        set { defaults.set(newValue, forKey: "lastMessageTs") }
    }
}
