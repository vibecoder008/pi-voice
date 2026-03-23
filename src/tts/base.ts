import type {
  TTSProvider,
  TTSProviderName,
  TTSProviderEvents,
  TTSConfig,
  TTSAudioChunk,
} from "../types.js";

/**
 * Regex matching sentence-ending punctuation followed by whitespace.
 * Used to split streaming text into sentence-sized chunks for TTS.
 */
const SENTENCE_BOUNDARY = /(?<=[.!?:;])\s+/;

/**
 * Minimum character count before we force-flush the sentence buffer
 * during streaming, even without a sentence boundary.
 */
const MAX_BUFFER_CHARS = 400;

/**
 * Abstract base class for all TTS providers.
 *
 * Implements the event emitter pattern and provides a default
 * sentence-buffered `speakStreaming` implementation that subclasses
 * can override when the underlying API supports native streaming input.
 */
export abstract class BaseTTSProvider implements TTSProvider {
  abstract readonly name: TTSProviderName;
  abstract readonly displayName: string;
  abstract readonly requiresApiKey: boolean;
  abstract readonly supportedVoices: string[];

  // ── Shared state ────────────────────────────────────────────────────

  protected _speaking = false;
  protected _voice = "";
  protected _speed = 1.0;
  protected _abortController: AbortController | null = null;
  protected _config: TTSConfig | null = null;

  /** Typed listener map. */
  private _listeners: {
    [E in keyof TTSProviderEvents]?: Set<TTSProviderEvents[E]>;
  } = {};

  // ── Event emitter ───────────────────────────────────────────────────

  /** Register an event handler. */
  on<E extends keyof TTSProviderEvents>(
    event: E,
    handler: TTSProviderEvents[E],
  ): void {
    if (!this._listeners[event]) {
      this._listeners[event] = new Set() as any;
    }
    (this._listeners[event] as Set<TTSProviderEvents[E]>).add(handler);
  }

  /** Remove a previously-registered event handler. */
  off<E extends keyof TTSProviderEvents>(
    event: E,
    handler: TTSProviderEvents[E],
  ): void {
    (this._listeners[event] as Set<TTSProviderEvents[E]> | undefined)?.delete(
      handler,
    );
  }

  /** Emit an event to all registered listeners. */
  protected emit<E extends keyof TTSProviderEvents>(
    event: E,
    ...args: Parameters<TTSProviderEvents[E]>
  ): void {
    const set = this._listeners[event] as
      | Set<TTSProviderEvents[E]>
      | undefined;
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as (...a: any[]) => void)(...args);
      } catch {
        // swallow listener errors
      }
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Default initialize — stores config and sets voice/speed. */
  async initialize(config: TTSConfig): Promise<void> {
    this._config = config;
    if (config.voice) {
      this._voice = config.voice;
    }
    this._speed = config.speed ?? 1.0;
  }

  /** Whether audio is currently being produced. */
  isSpeaking(): boolean {
    return this._speaking;
  }

  /** Set the active voice identifier. */
  setVoice(voice: string): void {
    this._voice = voice;
  }

  /** Set playback speed multiplier. */
  setSpeed(speed: number): void {
    this._speed = speed;
  }

  /**
   * Abort any in-progress speech.
   * Subclasses should check `this._abortController?.signal.aborted`
   * inside their speak loops.
   */
  stop(): void {
    this._abortController?.abort();
    this._abortController = null;
    if (this._speaking) {
      this._speaking = false;
      this.emit("end");
    }
  }

  /** Clean up resources. Override in subclasses that hold connections. */
  async dispose(): Promise<void> {
    this.stop();
    this._listeners = {};
  }

  // ── Abstract ────────────────────────────────────────────────────────

  /**
   * Synthesize and emit audio for the given text.
   * Must be implemented by every concrete provider.
   */
  abstract speak(text: string, signal?: AbortSignal): Promise<void>;

  // ── Default streaming implementation ────────────────────────────────

  /**
   * Consume an async text stream, buffer it into sentences, and call
   * `speak()` for each sentence sequentially.
   *
   * Providers with native streaming input support (e.g. Cartesia
   * WebSocket) should override this with a more efficient version.
   */
  async speakStreaming(
    textStream: AsyncIterable<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    let buffer = "";

    const speakSentence = async (sentence: string): Promise<void> => {
      const trimmed = sentence.trim();
      if (!trimmed) return;
      if (signal?.aborted) return;
      await this.speak(trimmed, signal);
    };

    for await (const chunk of textStream) {
      if (signal?.aborted) break;

      buffer += chunk;

      // Attempt to split on sentence boundaries.
      while (true) {
        const match = SENTENCE_BOUNDARY.exec(buffer);
        if (!match) break;

        const sentence = buffer.slice(0, match.index + match[0].length);
        buffer = buffer.slice(match.index + match[0].length);
        await speakSentence(sentence);
        if (signal?.aborted) return;
      }

      // Safety valve: if the buffer grows too large without a boundary,
      // flush everything accumulated so far.
      if (buffer.length >= MAX_BUFFER_CHARS) {
        await speakSentence(buffer);
        buffer = "";
        if (signal?.aborted) return;
      }
    }

    // Flush remaining text.
    if (buffer.trim() && !signal?.aborted) {
      await speakSentence(buffer);
    }
  }

  // ── Helpers for subclasses ──────────────────────────────────────────

  /**
   * Create a fresh AbortController that also listens to an external signal.
   * Returns the internal signal subclasses should observe.
   */
  protected createLinkedAbort(externalSignal?: AbortSignal): AbortSignal {
    this._abortController = new AbortController();
    const internal = this._abortController;

    if (externalSignal) {
      if (externalSignal.aborted) {
        internal.abort();
      } else {
        const onAbort = () => internal.abort();
        externalSignal.addEventListener("abort", onAbort, { once: true });
        // Clean up the external listener when internal aborts first
        internal.signal.addEventListener(
          "abort",
          () => externalSignal.removeEventListener("abort", onAbort),
          { once: true },
        );
      }
    }

    return internal.signal;
  }

  /**
   * Emit an audio chunk with standard metadata.
   */
  protected emitAudioChunk(
    audio: Buffer,
    sampleRate: number,
    channels: number,
    bitDepth: number,
  ): void {
    const chunk: TTSAudioChunk = { audio, sampleRate, channels, bitDepth };
    this.emit("audioChunk", chunk);
  }
}
