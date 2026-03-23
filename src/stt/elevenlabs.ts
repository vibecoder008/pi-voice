import { BaseSTTProvider, writeWavHeader } from "./base.js";
import { getApiKey } from "../config.js";
import { redactSecrets } from "../utils.js";
import type { STTConfig, STTProviderName } from "../types.js";

/** ElevenLabs Speech-to-Text REST endpoint. */
const ELEVENLABS_STT_URL =
  "https://api.elevenlabs.io/v1/speech-to-text";

/**
 * Shape of the ElevenLabs Speech-to-Text REST response.
 */
interface ElevenLabsSTTResponse {
  text?: string;
  language_code?: string;
  language_probability?: number;
}

/**
 * ElevenLabs Scribe STT provider.
 *
 * Operates in batch mode: audio chunks are accumulated in memory and
 * sent as a multipart form upload to the ElevenLabs speech-to-text
 * endpoint on stopListening(). Does not support real-time streaming.
 */
export class ElevenLabsSTTProvider extends BaseSTTProvider {
  readonly name: STTProviderName = "elevenlabs";
  readonly displayName = "ElevenLabs Scribe";
  readonly supportsStreaming = false;
  readonly requiresApiKey = true;

  private apiKey: string | null = null;
  private audioChunks: Buffer[] = [];
  private totalAudioBytes = 0;
  private static readonly MAX_AUDIO_BYTES = 25 * 1024 * 1024;

  /**
   * Initialize the provider with the given configuration.
   * Resolves the ElevenLabs API key from config or environment.
   */
  async initialize(config: STTConfig): Promise<void> {
    this.config = config;
    this.apiKey = getApiKey("elevenlabs") ?? null;

    if (!this.apiKey) {
      throw new Error(
        "ElevenLabs API key not found. Set ELEVENLABS_API_KEY or configure via voice settings.",
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
   * Stop listening, send the accumulated audio to ElevenLabs Scribe,
   * and return the transcribed text.
   *
   * @returns The full transcript from the ElevenLabs API.
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
    if (this.totalAudioBytes > ElevenLabsSTTProvider.MAX_AUDIO_BYTES) {
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
   * Concatenate buffered PCM audio, wrap in a WAV container, and send
   * as a multipart form upload to the ElevenLabs Scribe endpoint.
   *
   * @returns The transcribed text, or an empty string on failure.
   */
  private async transcribeAudio(): Promise<string> {
    const pcm = Buffer.concat(this.audioChunks);
    this.audioChunks = [];

    if (pcm.length === 0) return "";

    const wav = writeWavHeader(pcm, 16000, 1, 16);
    const providerOpts =
      (this.config?.providerOptions?.["elevenlabs"] as Record<string, unknown>) ??
      {};

    const modelId = (providerOpts["model_id"] as string) ?? "scribe_v1";

    // Build multipart form data
    const form = new FormData();
    // Copy into a plain ArrayBuffer to satisfy the Blob constructor
    const ab = new ArrayBuffer(wav.byteLength);
    new Uint8Array(ab).set(new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength));
    const audioBlob = new Blob([ab], { type: "audio/wav" });
    form.append("audio", audioBlob, "audio.wav");
    form.append("model_id", modelId);

    // Optionally include language hint
    if (this.config?.language) {
      const langCode = this.config.language.split("-")[0];
      form.append("language_code", langCode);
    }

    const response = await fetch(ELEVENLABS_STT_URL, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey!,
      },
      body: form,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `ElevenLabs STT request failed (${response.status}): ${redactSecrets(errText)}`,
      );
    }

    const data = (await response.json()) as ElevenLabsSTTResponse;
    return data.text ?? "";
  }
}
