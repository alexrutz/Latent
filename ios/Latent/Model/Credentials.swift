import Foundation
import Security

/// Where the server address and the token are kept between launches.
///
/// Two different things in two different places, on purpose. The address is not
/// a secret — it is `http://192.168.1.20:8080`, and putting it in `UserDefaults`
/// means it survives, is easy to inspect when something is wrong, and costs
/// nothing. The token *is* the password in another form, so it goes in the
/// Keychain, where the system encrypts it and will not hand it back until the
/// device has been unlocked once since boot.
enum Credentials {
    private static let serverKey = "latent.serverURL"
    private static let keychainService = "com.example.latent"
    private static let keychainAccount = "session-token"

    // MARK: The address

    static var serverURL: URL? {
        get {
            guard let text = UserDefaults.standard.string(forKey: serverKey) else { return nil }
            return URL(string: text)
        }
        set {
            if let newValue {
                UserDefaults.standard.set(newValue.absoluteString, forKey: serverKey)
            } else {
                UserDefaults.standard.removeObject(forKey: serverKey)
            }
        }
    }

    // MARK: The token

    static var token: String? {
        get { read() }
        set {
            if let newValue { write(newValue) } else { delete() }
        }
    }

    /// Forget both. What signing out means on this side.
    static func clear() {
        serverURL = nil
        token = nil
    }

    // MARK: - Keychain

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
    }

    private static func read() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let text = String(data: data, encoding: .utf8)
        else { return nil }
        return text
    }

    private static func write(_ value: String) {
        let data = Data(value.utf8)

        // Update in place if there is one, add it if there is not. `SecItemAdd`
        // on an existing account fails with `errSecDuplicateItem` rather than
        // overwriting, which is a silent "the token did not change".
        let updated = SecItemUpdate(
            baseQuery as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if updated == errSecSuccess { return }

        var query = baseQuery
        query[kSecValueData as String] = data
        /*
         * Readable after the first unlock, and never copied off the device.
         *
         * `AfterFirstUnlock` rather than `WhenUnlocked` so a background refresh
         * on a locked phone still works; `ThisDeviceOnly` keeps it out of an
         * iCloud Keychain backup, because it is a credential for a machine on
         * one particular network and has no business on another device.
         */
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }

    private static func delete() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}
