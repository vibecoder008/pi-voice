import type {
  STTProvider,
  STTProviderEvents,
  STTProviderName,
  STTConfig,
  STTTranscript,
} from "../types.js";

/**
 * Creates a WAV file header for raw PCM audio data.
 *
 * @param pcmBuffer - Raw PCM audio buffer
 * @param sampleRate - Sample rate in Hz (e.g. 16000)
 * @param channels - Number of audio channels (1 = mono, 2 = stereo)
 * @param bitDepth - Bits per sample (e.g. 16)
 * @returns A complete WAV file as a Buffer (header + PCM data)
 */
export function writeWavHeader(
  pcmBuffer: Buffer,
  sampleRate: number,
  channels: number,
  bitDepth: number,
): Buffer {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const dataSize = pcmBuffer.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;

  const header = Buffer.alloc(headerSize);

  // RIFF chunk descriptor
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize - 8, 4);
  header.write("WAVE", 8);

  // fmt sub-chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // sub-chunk size (PCM = 16)
  header.writeUInt16LE(1, 20); // audio format (1 = PCM)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);

  // data sub-chunk
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Type-safe event handler storage entry.
 */
type HandlerEntry = {
  [E in keyof STTProviderEvents]: {
    event: E;
    handler: STTProviderEvents[E];
  };
}[keyof STTProviderEvents];

/**
 * Abstract base class for STT providers.
 *
 * Implements the event emitter pattern (on/off/emit) and shared state
 * management including listening flag and transcript accumulation.
 * Subclasses must implement the abstract members and provider-specific logic.
 */
export abstract class BaseSTTProvider implements STTProvider {
  abstract readonly name: STTProviderName;
  abstract readonly displayName: string;
  abstract readonly supportsStreaming: boolean;
  abstract readonly requiresApiKey: boolean;

  /** Current STT configuration, set during initialize(). */
  protected config: STTConfig | null = null;

  /** Whether the provider is currently listening for audio. */
  protected listening = false;

  /** Accumulated final transcript segments from streaming results. */
  protected accumulatedTranscript = "";

  /** Registered event handlers. */
  private handlers: HandlerEntry[] = [];

  // ─── Event Emitter ──────────────────────────────────────────────────

  /**
   * Register an event handler.
   */
  on<E extends keyof STTProviderEvents>(
    event: E,
    handler: STTProviderEvents[E],
  ): void {
    this.handlers.push({ event, handler } as HandlerEntry);
  }

  /**
   * Remove a previously registered event handler.
   */
  off<E extends keyof STTProviderEvents>(
    event: E,
    handler: STTProviderEvents[E],
  ): void {
    this.handlers = this.handlers.filter(
      (h) => !(h.event === event && h.handler === handler),
    );
  }

  /**
   * Emit an event to all registered handlers.
   */
  protected emit<E extends keyof STTProviderEvents>(
    event: E,
    ...args: Parameters<STTProviderEvents[E]>
  ): void {
    for (const entry of this.handlers) {
      if (entry.event === event) {
        try {
          (entry.handler as (...a: unknown[]) => void)(...args);
        } catch (err) {
          // Prevent handler errors from crashing the provider
          if (event !== "error") {
            this.emit("error", err instanceof Error ? err : new Error(String(err)));
          }
        }
      }
    }
  }

  // ─── Shared State ───────────────────────────────────────────────────

  /**
   * Returns whether the provider is currently listening for audio.
   */
  isListening(): boolean {
    return this.listening;
  }

  /**
   * Append a final transcript segment to the accumulated transcript.
   * Handles whitespace joining between segments.
   */
  protected appendTranscript(text: string): void {
    if (!text) return;
    if (this.accumulatedTranscript) {
      this.accumulatedTranscript += " " + text;
    } else {
      this.accumulatedTranscript = text;
    }
  }

  /**
   * Reset accumulated transcript and listening state.
   * Call at the start of each listening session.
   */
  protected resetState(): void {
    this.accumulatedTranscript = "";
    this.listening = false;
  }

  /**
   * Emit a transcript event and accumulate final results.
   */
  protected emitTranscript(transcript: STTTranscript): void {
    if (transcript.isFinal && transcript.text) {
      this.appendTranscript(transcript.text);
    }
    this.emit("transcript", transcript);
  }

  /**
   * Emit an error event, wrapping non-Error values.
   */
  protected emitError(err: unknown): void {
    this.emit(
      "error",
      err instanceof Error ? err : new Error(String(err)),
    );
  }

  // ─── Abstract Members ──────────────────────────────────────────────

  abstract initialize(config: STTConfig): Promise<void>;
  abstract startListening(): Promise<void>;
  abstract stopListening(): Promise<string>;
  abstract sendAudio(chunk: Buffer): void;
  abstract dispose(): Promise<void>;
}
