import { getApiKey } from "../config.js";
import { redactSecrets } from "../utils.js";
import { BaseTTSProvider } from "./base.js";
import type { TTSProviderName, TTSConfig } from "../types.js";

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;

/** Byte length of a standard WAV file header. */
const WAV_HEADER_SIZE = 44;

/**
 * Google Cloud Text-to-Speech provider.
 *
 * Uses the REST v1 `text:synthesize` endpoint with `LINEAR16` encoding.
 * The response contains base64-encoded audio that starts with a 44-byte
 * WAV header which is stripped before emitting raw PCM chunks.
 */
export class GoogleTTSProvider extends BaseTTSProvider {
  readonly name: TTSProviderName = "google";
  readonly displayName = "Google Cloud TTS";
  readonly requiresApiKey = true;
  readonly supportedVoices = [
    "en-US-Neural2-C",
    "en-US-Neural2-D",
    "en-US-Neural2-F",
    "en-US-Studio-O",
  ];

  private _apiKey = "";
  private _languageCode = "en-US";

  async initialize(config: TTSConfig): Promise<void> {
    await super.initialize(config);

    const key = getApiKey("google");
    if (!key) {
      throw new Error(
        "Google API key not found. Set GOOGLE_APPLICATION_CREDENTIALS or configure via voice settings.",
      );
    }
    this._apiKey = key;

    if (!this._voice) {
      this._voice = "en-US-Neural2-F";
    }

    const opts = config.providerOptions?.google;
    if (opts?.languageCode && typeof opts.languageCode === "string") {
      this._languageCode = opts.languageCode;
    }
  }

  /**
   * Synthesize text via the Google Cloud TTS REST API.
   *
   * The API returns a JSON payload with `audioContent` as base64.
   * We decode it, skip the 44-byte WAV header, and emit the
   * remaining raw PCM data.
   */
  async speak(text: string, signal?: AbortSignal): Promise<void> {
    if (!text.trim()) return;

    const linkedSignal = this.createLinkedAbort(signal);
    const url = "https://texttospeech.googleapis.com/v1/text:synthesize";
    const timeoutSignal = AbortSignal.timeout(15000);
    const combinedSignal = AbortSignal.any([linkedSignal, timeoutSignal]);

    this._speaking = true;
    this.emit("start");

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "X-goog-api-key": this._apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: { text },
          voice: {
            languageCode: this._languageCode,
            name: this._voice,
          },
          audioConfig: {
            audioEncoding: "LINEAR16",
            sampleRateHertz: SAMPLE_RATE,
            speakingRate: this._speed,
          },
        }),
        signal: combinedSignal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Google TTS API error ${response.status}: ${redactSecrets(body)}`,
        );
      }

      const json = (await response.json()) as { audioContent?: string };
      if (!json.audioContent) {
        throw new Error("Google TTS response missing audioContent.");
      }

      const fullAudio = Buffer.from(json.audioContent, "base64");

      // Skip the WAV header — the rest is raw LINEAR16 PCM.
      const pcm = fullAudio.length > WAV_HEADER_SIZE
        ? fullAudio.subarray(WAV_HEADER_SIZE)
        : fullAudio;

      if (linkedSignal.aborted) return;
      this.emitAudioChunk(pcm, SAMPLE_RATE, CHANNELS, BIT_DEPTH);
    } catch (err: any) {
      if (linkedSignal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.emit("error", new Error(redactSecrets(msg)));
    } finally {
      this._speaking = false;
      this.emit("end");
    }
  }
}
