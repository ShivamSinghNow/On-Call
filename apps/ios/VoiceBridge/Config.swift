import Foundation

enum Config {
    /// URL of the channel server — must be reachable from the phone over LAN.
    /// Change this to your machine's LAN IP before building.
    static let channelServerURL = ProcessInfo.processInfo.environment["CHANNEL_SERVER_URL"]
        ?? "ws://192.168.1.10:4000"

    /// Shared secret matching BRIDGE_TOKEN in .env
    static let bridgeToken = ProcessInfo.processInfo.environment["BRIDGE_TOKEN"]
        ?? "dev-secret-change-me"
}
