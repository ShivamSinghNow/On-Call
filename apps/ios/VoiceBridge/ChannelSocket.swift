import Foundation

private struct AudioMessage: Decodable {
    let type: String
    let pcm: [Float]
    let callSid: String
}

private struct TranscriptionMessage: Encodable {
    let type = "transcription"
    let text: String
    let callSid: String
}

/// Manages the WebSocket connection to the channel server's /phone/stream endpoint.
final class ChannelSocket: NSObject, URLSessionWebSocketDelegate {
    var onConnected: (() -> Void)?
    var onDisconnected: (() -> Void)?
    var onAudio: (([Float], String) -> Void)?

    private var task: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var reconnectTimer: Timer?
    private var stopped = false

    func connect() {
        stopped = false
        let base = Config.channelServerURL
            .replacingOccurrences(of: "http://", with: "ws://")
            .replacingOccurrences(of: "https://", with: "wss://")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        guard let url = URL(string: "\(base)/phone/stream") else { return }
        urlSession = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
        task = urlSession?.webSocketTask(with: url)
        task?.resume()
        receive()
    }

    func disconnect() {
        stopped = true
        reconnectTimer?.invalidate()
        task?.cancel(with: .goingAway, reason: nil)
    }

    func send(text: String, callSid: String) {
        let msg = TranscriptionMessage(text: text, callSid: callSid)
        guard let data = try? JSONEncoder().encode(msg),
              let json = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(json)) { _ in }
    }

    // MARK: - Private

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                if case .string(let text) = message {
                    self.handleMessage(text)
                }
                self.receive()
            case .failure:
                self.scheduleReconnect()
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let msg = try? JSONDecoder().decode(AudioMessage.self, from: data),
              msg.type == "audio" else { return }
        onAudio?(msg.pcm, msg.callSid)
    }

    private func scheduleReconnect() {
        guard !stopped else { return }
        onDisconnected?()
        reconnectTimer?.invalidate()
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
            self?.connect()
        }
    }

    // MARK: - URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        onConnected?()
    }

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                    reason: Data?) {
        scheduleReconnect()
    }
}
