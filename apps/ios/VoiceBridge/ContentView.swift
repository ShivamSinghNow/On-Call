import SwiftUI

struct ContentView: View {
    @StateObject private var handler = TwilioCallHandler()

    var body: some View {
        ZStack {
            Color(red: 0.04, green: 0.06, blue: 0.10)
                .ignoresSafeArea()

            VStack(spacing: 24) {
                Text("Voice Bridge")
                    .font(.system(size: 32, weight: .bold))
                    .foregroundColor(.white)

                Text("Listening for Twilio calls")
                    .font(.system(size: 15))
                    .foregroundColor(Color(white: 0.54))

                Circle()
                    .fill(handler.isProcessing ? Color.red : Color.blue)
                    .frame(width: 120, height: 120)
                    .overlay(
                        Image(systemName: handler.isProcessing ? "waveform" : "phone.fill")
                            .font(.system(size: 40))
                            .foregroundColor(.white)
                    )
                    .shadow(color: handler.isProcessing ? .red : .blue, radius: 20)
                    .animation(.easeInOut, value: handler.isProcessing)

                VStack(spacing: 8) {
                    statusDot(handler.socketConnected, label: "Channel server")
                    statusDot(handler.modelReady, label: "STT model")
                }

                if !handler.statusMessage.isEmpty {
                    Text(handler.statusMessage)
                        .font(.system(size: 13))
                        .foregroundColor(Color(white: 0.7))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
            }
        }
        .onAppear { handler.start() }
        .onDisappear { handler.stop() }
    }

    private func statusDot(_ active: Bool, label: String) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(active ? Color.green : Color.gray)
                .frame(width: 8, height: 8)
            Text(label)
                .font(.system(size: 13))
                .foregroundColor(Color(white: 0.6))
        }
    }
}
