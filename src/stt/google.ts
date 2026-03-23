import { BaseSTTProvider } from "./base.js";
import { getApiKey } from "../config.js";
import { redactSecrets } from "../utils.js";
import type { STTConfig, STTProviderName } from "../types.js";

/** Google Speech-to-Text REST endpoint. */
const GOOGLE_STT_URL =
  "https://speech.googleapis.com/v1/speech:recognize";

/**
 * Recognition config sent in the request body.
 */
interface GoogleRecognitionConfig {
  encoding: string;
  sampleRateHertz: number;
  languageCode: string;
  enableAutomaticPunctuation: boolean;
  model: string;
}

/**
 * Shape of the Google Speech-to-Text REST response.
 */
interface GoogleRecognizeResponse {
  results?: Array<{
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
    }>;
    languageCode?: string;
  }>;
}

/**
 * Google Cloud Speech-to-Text provider.
 *
 * Operates in batch mode: audio chunks are accumulated in memory and
 * sent as a single base64-encoded payload to the REST recognize endpoint
 * on stopListening(). Does not support real-time streaming.
 */
export class GoogleSTTProvider extends BaseSTTProvider {
  readonly name: STTProviderName = "google";
  readonly displayName = "Google Cloud STT";
  readonly supportsStreaming = false;
  readonly requiresApiKey = true;

  private apiKey: string | null = null;
  private audioChunks: Buffer[] = [];
  private totalAudioBytes = 0;
  private static readonly MAX_AUDIO_BYTES = 10 * 1024 * 1024;

  /**
   * Initialize the provider with the given configuration.
   * Resolves the Google API key from config or environment.
   */
  async initialize(config: STTConfig): Promise<void> {
    this.config = config;
    this.apiKey = getApiKey("google") ?? null;

    if (!this.apiKey) {
      throw new Error(
        "Google API key not found. Set GOOGLE_APPLICATION_CREDENTIALS or configure via voice settings.",
      );
    }
  }

  /**
   * Begin accumulating audio chunks for batch transcription.
   */
  async startListening(): Promise<void> {
    if (this.listening) return;

    this.resetState();
    this.audioChunks = [];
    this.totalAudioBytes = 0;
    this.listening = true;
    this.emit("ready");
  }

  /**
   * Stop listening, send the accumulated audio to the Google Speech API,
   * and return the transcribed text.
   *
   * @returns The full transcript from the Google API.
   */
  async stopListening(): Promise<string> {
    if (!this.listening) return this.accumulatedTranscript;

    this.listening = false;

    if (this.audioChunks.length === 0) {
      return this.accumulatedTranscript;
    }

    try {
      const transcript = await this.transcribeAudio();
      if (transcript) {
        this.emitTranscript({
          text: transcript,
          isFinal: true,
          confidence: 1.0,
        });
      }
    } catch (err) {
      this.emitError(err);
    }

    return this.accumulatedTranscript;
  }

  /**
   * Buffer an audio chunk for later batch transcription.
   */
  sendAudio(chunk: Buffer): void {
    if (!this.listening) return;
    this.totalAudioBytes += chunk.length;
    if (this.totalAudioBytes > GoogleSTTProvider.MAX_AUDIO_BYTES) {
      this.emitError(new Error("Audio buffer limit exceeded. Stop and restart recording."));
      return;
    }
    this.audioChunks.push(chunk);
  }

  /**
   * Dispose of the provider, releasing all resources.
   */
  async dispose(): Promise<void> {
    this.listening = false;
    this.apiKey = null;
    this.audioChunks = [];
  }

  // ─── Private Helpers ───────────────────────────────────────────────

  /**
   * Concatenate buffered PCM audio, encode to base64, and send to the
   * Google Cloud Speech-to-Text REST endpoint.
   *
   * @returns The transcribed text, or an empty string on failure.
   */
  private async transcribeAudio(): Promise<string> {
    const pcm = Buffer.concat(this.audioChunks);
    this.audioChunks = [];

    if (pcm.length === 0) return "";

    const languageCode = this.config?.language ?? "en-US";
    const providerOpts =
      (this.config?.providerOptions?.["google"] as Record<string, unknown>) ?? {};

    const recognitionConfig: GoogleRecognitionConfig = {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      languageCode,
      enableAutomaticPunctuation: true,
      model: (providerOpts["model"] as string) ?? "latest_long",
    };

    const body = JSON.stringify({
      config: recognitionConfig,
      audio: {
        content: pcm.toString("base64"),
      },
    });

    const response = await fetch(GOOGLE_STT_URL, {
      method: "POST",
      headers: {
        "X-goog-api-key": this.apiKey!,
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Google STT request failed (${response.status}): ${redactSecrets(errText)}`);
    }

    const data = (await response.json()) as GoogleRecognizeResponse;

    // Concatenate all result alternatives
    const segments: string[] = [];
    let totalConfidence = 0;
    let count = 0;

    if (data.results) {
      for (const result of data.results) {
        const alt = result.alternatives?.[0];
        if (alt?.transcript) {
          segments.push(alt.transcript);
          totalConfidence += alt.confidence ?? 1.0;
          count++;
        }
      }
    }

    const text = segments.join(" ");

    // Return text directly — stopListening() handles emitTranscript
    return text;
  }
}
