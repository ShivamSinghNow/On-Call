import Foundation
import Cactus

/// Orchestrates the full Twilio call flow:
/// 1. Connects to channel server WebSocket
/// 2. Receives PCM audio chunks
/// 3. Transcribes on-device via CactusSTT
/// 4. Sends transcription back to channel server
@MainActor
final class TwilioCallHandler: ObservableObject {
    @Published var socketConnected = false
    @Published var modelReady = false
    @Published var isProcessing = false
    @Published var statusMessage = "Initialising..."

    private let socket = ChannelSocket()
    private var sttModel: CactusModelT?

    func start() {
        Task {
            await loadModel()
            connectSocket()
        }
    }

    func stop() {
        socket.disconnect()
    }

    // MARK: - Model

    private func loadModel() async {
        statusMessage = "Downloading STT model..."
        do {
            sttModel = try await Task.detached(priority: .userInitiated) {
                let paramsJson = """
                {
                    "model": "moonshine-base",
                    "n_threads": 4
                }
                """
                return try cactusInit(paramsJson, nil, false)
            }.value
            modelReady = true
            statusMessage = "Ready"
        } catch {
            statusMessage = "Model load failed: \(error.localizedDescription)"
        }
    }

    // MARK: - Socket

    private func connectSocket() {
        socket.onConnected = { [weak self] in
            Task { @MainActor in
                self?.socketConnected = true
                self?.statusMessage = "Connected — waiting for calls"
            }
        }

        socket.onDisconnected = { [weak self] in
            Task { @MainActor in
                self?.socketConnected = false
                self?.statusMessage = "Reconnecting..."
            }
        }

        socket.onAudio = { [weak self] pcm, callSid in
            Task { @MainActor in
                await self?.transcribe(pcm: pcm, callSid: callSid)
            }
        }

        socket.connect()
    }

    // MARK: - Transcription

    private func transcribe(pcm: [Float], callSid: String) async {
        guard let model = sttModel else { return }
        isProcessing = true
        statusMessage = "Transcribing..."

        do {
            let text = try await Task.detached(priority: .userInitiated) {
                // Convert Float array to 16-bit PCM Data
                let pcmData = pcm.withUnsafeBufferPointer { buffer -> Data in
                    let int16Samples = buffer.map { sample -> Int16 in
                        let clamped = max(-1.0, min(1.0, sample))
                        return Int16(clamped * Float(Int16.max))
                    }
                    return int16Samples.withUnsafeBufferPointer { Data(buffer: $0) }
                }
                return try cactusTranscribe(model, nil, nil, nil, nil, pcmData)
            }.value

            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                socket.send(text: trimmed, callSid: callSid)
                statusMessage = "Sent: \(trimmed)"
            } else {
                statusMessage = "Connected — waiting for calls"
            }
        } catch {
            statusMessage = "Transcription error: \(error.localizedDescription)"
        }

        isProcessing = false
    }
}
