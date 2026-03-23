import OpenAI, { toFile } from "openai";
import { BaseSTTProvider, writeWavHeader } from "./base.js";
import { getApiKey } from "../config.js";
import type { STTConfig, STTProviderName } from "../types.js";

/**
 * OpenAI Whisper STT provider.
 *
 * Operates in batch mode: audio chunks are accumulated in memory
 * and sent as a single WAV file to the Whisper API on stopListening().
 * Does not support real-time streaming.
 */
export class OpenAISTTProvider extends BaseSTTProvider {
  readonly name: STTProviderName = "openai";
  readonly displayName = "OpenAI Whisper";
  readonly supportsStreaming = false;
  readonly requiresApiKey = true;

  private client: OpenAI | null = null;
  private audioChunks: Buffer[] = [];
  private totalAudioBytes = 0;
  private static readonly MAX_AUDIO_BYTES = 25 * 1024 * 1024;

  /**
   * Initialize the provider with the given configuration.
   * Creates the OpenAI client with the resolved API key.
   */
  async initialize(config: STTConfig): Promise<void> {
    this.config = config;
    const apiKey = getApiKey("openai");

    if (!apiKey) {
      throw new Error(
        "OpenAI API key not found. Set OPENAI_API_KEY or configure via voice settings.",
      );
    }

    this.client = new OpenAI({ apiKey });
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
   * Stop listening, send the accumulated audio to the Whisper API,
   * and return the transcribed text.
   *
   * @returns The full transcript from the Whisper API.
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
    if (this.totalAudioBytes > OpenAISTTProvider.MAX_AUDIO_BYTES) {
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
    this.client = null;
    this.audioChunks = [];
  }

  // ─── Private Helpers ───────────────────────────────────────────────

  /**
   * Concatenate buffered PCM audio, wrap in a WAV container,
   * and send to the OpenAI Whisper transcription endpoint.
   *
   * @returns The transcribed text, or an empty string on failure.
   */
  private async transcribeAudio(): Promise<string> {
    if (!this.client) {
      throw new Error("OpenAI client not initialized");
    }

    const pcm = Buffer.concat(this.audioChunks);
    this.audioChunks = [];

    if (pcm.length === 0) return "";

    const wav = writeWavHeader(pcm, 16000, 1, 16);
    const file = await toFile(wav, "audio.wav", { type: "audio/wav" });

    const language = this.config?.language?.split("-")[0] ?? "en";
    const providerOpts =
      (this.config?.providerOptions?.["openai"] as Record<string, unknown>) ?? {};

    const response = await this.client.audio.transcriptions.create({
      file,
      model: (providerOpts["model"] as string) ?? "whisper-1",
      language,
      response_format: "json",
    }, { signal: AbortSignal.timeout(15000) });

    return response.text ?? "";
  }
}
