import { getApiKey } from "../config.js";
import { redactSecrets } from "../utils.js";
import { BaseTTSProvider } from "./base.js";
import type { TTSProviderName, TTSConfig } from "../types.js";

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;

/**
 * Azure Cognitive Services Text-to-Speech provider.
 *
 * Uses the REST endpoint with SSML input and the
 * `raw-24khz-16bit-mono-pcm` output format for raw PCM streaming.
 */
export class AzureTTSProvider extends BaseTTSProvider {
  readonly name: TTSProviderName = "azure";
  readonly displayName = "Azure TTS";
  readonly requiresApiKey = true;
  readonly supportedVoices = [
    "en-US-AriaNeural",
    "en-US-GuyNeural",
    "en-US-JennyNeural",
    "en-US-DavisNeural",
  ];

  private _subscriptionKey = "";
  private _region = "eastus";

  async initialize(config: TTSConfig): Promise<void> {
    await super.initialize(config);

    const key = getApiKey("azure");
    if (!key) {
      throw new Error(
        "Azure Speech subscription key not found. Set AZURE_SPEECH_KEY or configure via voice settings.",
      );
    }
    this._subscriptionKey = key;

    // Region can come from a separate config entry or env var.
    const region = getApiKey("azure-region");
    if (region) {
      this._region = region;
    }

    if (!this._voice) {
      this._voice = "en-US-AriaNeural";
    }

    const opts = config.providerOptions?.azure;
    if (opts?.region && typeof opts.region === "string") {
      this._region = opts.region;
    }
  }

  /**
   * Build the SSML document for the given text, voice, and speed.
   */
  private _buildSSML(text: string): string {
    // Azure prosody rate: a percentage string like "+50%" or "-25%".
    // speed=1.0 => "+0%", speed=1.5 => "+50%", speed=0.5 => "-50%".
    const ratePercent = Math.round((this._speed - 1.0) * 100);
    const rateStr =
      ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;

    // Escape XML special characters in the text.
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

    const safeVoice = this._voice.replace(/[<>&"']/g, "");

    return (
      `<speak version='1.0' xml:lang='en-US'>` +
      `<voice name='${safeVoice}'>` +
      `<prosody rate='${rateStr}'>${escaped}</prosody>` +
      `</voice></speak>`
    );
  }

  /**
   * Synthesize text via Azure TTS REST API and stream the raw PCM response.
   */
  async speak(text: string, signal?: AbortSignal): Promise<void> {
    if (!text.trim()) return;

    const linkedSignal = this.createLinkedAbort(signal);
    const url = `https://${this._region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const ssml = this._buildSSML(text);

    this._speaking = true;
    this.emit("start");

    try {
      const timeoutSignal = AbortSignal.timeout(15000);
      const combinedSignal = AbortSignal.any([linkedSignal, timeoutSignal]);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": this._subscriptionKey,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "raw-24khz-16bit-mono-pcm",
          "User-Agent": "pi-voice/1.0",
        },
        body: ssml,
        signal: combinedSignal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Azure TTS API error ${response.status}: ${redactSecrets(body)}`);
      }

      if (!response.body) {
        throw new Error("Empty response body from Azure TTS API.");
      }

      for await (const raw of response.body as any as AsyncIterable<Uint8Array>) {
        if (linkedSignal.aborted) break;
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        this.emitAudioChunk(buf, SAMPLE_RATE, CHANNELS, BIT_DEPTH);
      }
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
