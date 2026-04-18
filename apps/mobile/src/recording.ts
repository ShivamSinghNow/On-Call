import { Audio } from "expo-av";

const RECORDING_OPTIONS: Audio.RecordingOptions = {
  isMeteringEnabled: true,
  android: {
    extension: ".wav",
    outputFormat: Audio.AndroidOutputFormat.DEFAULT,
    audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 256000,
  },
  ios: {
    extension: ".wav",
    audioQuality: Audio.IOSAudioQuality.HIGH,
    outputFormat: Audio.IOSOutputFormat.LINEARPCM,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 256000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: "audio/wav",
    bitsPerSecond: 256000,
  },
};

export class Recorder {
  private rec: Audio.Recording | null = null;

  async ensurePermission(): Promise<boolean> {
    const existing = await Audio.getPermissionsAsync();
    if (existing.granted) return true;
    const req = await Audio.requestPermissionsAsync();
    return req.granted;
  }

  async start(): Promise<void> {
    if (this.rec) throw new Error("recording already in progress");
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });
    this.rec = new Audio.Recording();
    await this.rec.prepareToRecordAsync(RECORDING_OPTIONS);
    await this.rec.startAsync();
  }

  async stop(): Promise<string> {
    if (!this.rec) throw new Error("no active recording");
    await this.rec.stopAndUnloadAsync();
    const uri = this.rec.getURI();
    this.rec = null;
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
    if (!uri) throw new Error("recording produced no file");
    return uri;
  }

  async cancel(): Promise<void> {
    if (!this.rec) return;
    try {
      await this.rec.stopAndUnloadAsync();
    } catch {
      // ignore
    }
    this.rec = null;
  }
}
