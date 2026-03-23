import WebSocket from "ws";
import { BaseSTTProvider } from "./base.js";
import { getApiKey } from "../config.js";
import type { STTConfig, STTProviderName } from "../types.js";

/**
 * Azure Speech-to-Text provider.
 *
 * Connects to the Azure Cognitive Services WebSocket endpoint and
 * streams raw PCM audio for real-time transcription. Handles both
 * partial (hypothesis) and final (recognized) results.
 */
export class AzureSTTProvider extends BaseSTTProvider {
  readonly name: STTProviderName = "azure";
  readonly displayName = "Azure Speech";
  readonly supportsStreaming = true;
  readonly requiresApiKey = true;

  private ws: WebSocket | null = null;
  private subscriptionKey: string | null = null;
  private region: string | null = null;
  private requestId: string | null = null;
  private closing = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MAX_RECONNECT_ATTEMPTS = 3;
  private static readonly RECONNECT_BASE_DELAY_MS = 1000;

  /**
   * Initialize the provider with the given configuration.
   * Resolves the Azure subscription key and region.
   */
  async initialize(config: STTConfig): Promise<void> {
    this.config = config;
    this.subscriptionKey = getApiKey("azure") ?? null;
    this.region = getApiKey("azure-region") ?? "eastus";

    if (!this.subscriptionKey) {
      throw new Error(
        "Azure Speech key not found. Set AZURE_SPEECH_KEY or configure via voice settings.",
      );
    }
  }

  /**
   * Open a WebSocket connection to Azure and begin listening.
   */
  async startListening(): Promise<void> {
    if (this.listening) return;

    this.resetState();
    this.listening = true;
    this.closing = false;
    this.reconnectAttempts = 0;
    this.requestId = generateRequestId();

    await this.connect();
  }

  /**
   * Stop listening and close the WebSocket connection.
   *
   * @returns The full accumulated transcript.
   */
  async stopListening(): Promise<string> {
    if (!this.listening) return this.accumulatedTranscript;

    this.listening = false;
    this.closing = true;

    this.closeWebSocket();
    return this.accumulatedTranscript;
  }

  /**
   * Send a raw PCM audio chunk to Azure over the WebSocket.
   *
   * Azure Speech WebSocket binary frames require a structured header:
   * [2-byte header length (BE)] [header text] [audio payload]
   */
  sendAudio(chunk: Buffer): void {
    if (!this.listening) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      const requestId = this.requestId || generateRequestId();
      const timestamp = new Date().toISOString();

      const headerText =
        `Path: audio\r\n` +
        `X-RequestId: ${requestId}\r\n` +
        `X-Timestamp: ${timestamp}\r\n` +
        `Content-Type: audio/x-wav\r\n`;

      const headerBuf = Buffer.from(headerText, "utf-8");
      const headerLen = Buffer.alloc(2);
      headerLen.writeUInt16BE(headerBuf.length, 0);

      const frame = Buffer.concat([headerLen, headerBuf, chunk]);
      this.ws.send(frame);
    } catch (err) {
      this.emitError(err);
    }
  }

  /**
   * Dispose of the provider, releasing all resources.
   */
  async dispose(): Promise<void> {
    this.closing = true;
    this.listening = false;
    this.clearReconnectTimer();
    this.closeWebSocket();
  }

  // ─── Private Helpers ───────────────────────────────────────────────

  /**
   * Build the Azure Speech WebSocket URL.
   */
  private buildUrl(): string {
    const lang = this.config?.language ?? "en-US";
    return (
      `wss://${this.region}.stt.speech.microsoft.com` +
      `/speech/recognition/conversation/cognitiveservices/v1` +
      `?language=${encodeURIComponent(lang)}&format=detailed`
    );
  }

  /**
   * Establish the WebSocket connection and bind message handlers.
   */
  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = this.buildUrl();

      this.ws = new WebSocket(url, {
        headers: {
          "Ocp-Apim-Subscription-Key": this.subscriptionKey!,
        },
      });

      let resolved = false;

      const connectTimeout = setTimeout(() => {
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          this.ws.close();
          const err = new Error("Azure STT: connection timeout");
          this.emitError(err);
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        }
      }, 10000);

      this.ws.on("open", () => {
        clearTimeout(connectTimeout);
        this.sendSpeechConfig();
        if (!resolved) {
          resolved = true;
          this.reconnectAttempts = 0;
          this.emit("ready");
          resolve();
        }
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (err: Error) => {
        clearTimeout(connectTimeout);
        this.emitError(err);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      this.ws.on("close", (code: number) => {
        clearTimeout(connectTimeout);
        this.ws = null;
        if (this.listening && !this.closing && code !== 1000) {
          this.scheduleReconnect();
        } else {
          this.emit("closed");
        }
      });
    });
  }

  /**
   * Send the initial speech.config message to Azure.
   *
   * This JSON payload configures the recognition session with
   * audio format details and recognition parameters.
   */
  private sendSpeechConfig(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const speechConfig = {
      context: {
        system: {
          name: "pi-voice",
          version: "1.0.0",
          build: "typescript",
          lang: "TypeScript",
        },
        os: {
          platform: process.platform,
          name: process.platform,
          version: process.version,
        },
        audio: {
          source: {
            bitspersample: 16,
            channelcount: 1,
            connectivity: "Unknown",
            manufacturer: "pi-voice",
            model: "microphone",
            samplerate: 16000,
            type: "Microphones",
          },
        },
      },
    };

    const configHeader =
      `Path: speech.config\r\n` +
      `X-RequestId: ${this.requestId}\r\n` +
      `X-Timestamp: ${new Date().toISOString()}\r\n` +
      `Content-Type: application/json\r\n\r\n`;

    this.ws.send(configHeader + JSON.stringify(speechConfig));
  }

  /**
   * Parse incoming Azure WebSocket messages.
   *
   * Azure sends text-framed messages with headers separated from the
   * JSON body by a blank line. Message types of interest:
   * - `speech.hypothesis` — partial recognition result
   * - `speech.phrase` — final recognition result
   * - `turn.end` — recognition turn complete
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const raw = data.toString();

      // Azure frames: headers\r\n\r\nbody
      const separatorIdx = raw.indexOf("\r\n\r\n");
      if (separatorIdx === -1) return;

      const headers = raw.substring(0, separatorIdx);
      const body = raw.substring(separatorIdx + 4);

      const pathMatch = headers.match(/Path:\s*(.+)/i);
      if (!pathMatch) return;

      const path = pathMatch[1].trim().toLowerCase();

      if (path === "speech.hypothesis" && body) {
        const msg = JSON.parse(body);
        this.emitTranscript({
          text: msg.Text ?? "",
          isFinal: false,
          confidence: 0.5,
        });
      } else if (path === "speech.phrase" && body) {
        const msg = JSON.parse(body);

        if (msg.RecognitionStatus === "Success") {
          // Use the best result from NBest if available
          const nBest = msg.NBest;
          if (nBest && nBest.length > 0) {
            this.emitTranscript({
              text: nBest[0].Display ?? nBest[0].Lexical ?? "",
              isFinal: true,
              confidence: nBest[0].Confidence ?? 1.0,
            });
          } else {
            this.emitTranscript({
              text: msg.DisplayText ?? "",
              isFinal: true,
              confidence: 1.0,
            });
          }
        } else if (msg.RecognitionStatus === "NoMatch") {
          // No speech detected — emit empty final
          this.emitTranscript({
            text: "",
            isFinal: true,
            confidence: 0,
          });
        }
      }
      // turn.end and speech.endDetected are informational — no action needed
    } catch (err) {
      this.emitError(err);
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= AzureSTTProvider.MAX_RECONNECT_ATTEMPTS) {
      this.emitError(
        new Error(
          `Azure STT: failed to reconnect after ${AzureSTTProvider.MAX_RECONNECT_ATTEMPTS} attempts`,
        ),
      );
      this.listening = false;
      this.emit("closed");
      return;
    }

    const delay =
      AzureSTTProvider.RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // connect() already emitted the error; backoff continues via on-close
      }
    }, delay);
  }

  /**
   * Cancel any pending reconnection timer.
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Close the WebSocket connection if open.
   */
  private closeWebSocket(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}

/**
 * Generate a unique request ID for the Azure session (UUID v4-like).
 */
function generateRequestId(): string {
  const hex = (n: number): string =>
    Array.from({ length: n }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join("");
  return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
}
