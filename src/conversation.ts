import type { ConversationConfig } from "./types.js";

// ─── Callback contract ──────────────────────────────────────────────────

/**
 * Functions the {@link ConversationController} calls back into to
 * control the mic and query playback state.  Supplied by the extension
 * entry-point so the controller stays decoupled from audio internals.
 */
export interface ConversationCallbacks {
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  isListening: () => boolean;
  isSpeaking: () => boolean;
}

// ─── Controller ─────────────────────────────────────────────────────────

/**
 * Orchestrates the bidirectional voice conversation loop:
 *
 *   user speaks -> STT transcribes -> prompt submitted -> LLM responds
 *   -> TTS reads response -> (delay) -> mic reopens -> user speaks ...
 *
 * The controller itself owns no audio resources; it simply coordinates
 * transitions via the {@link ConversationCallbacks} interface.
 *
 * Lifecycle:
 * 1. `setEnabled(true)` to enter conversation mode.
 * 2. When TTS finishes a response, the host calls `onTTSEnd()`.
 * 3. After the configured delay, the controller calls `startListening()`.
 * 4. When the user's utterance is submitted as a prompt, the host calls
 *    `onPromptSubmitted()` to reset the cycle.
 * 5. If the user types or otherwise interrupts, `onUserInput()` cancels
 *    any pending auto-listen.
 */
export class ConversationController {
  /** Whether conversation mode is currently active. */
  private enabled = false;

  /** `true` while TTS is actively reading a response. */
  private awaitingTTSEnd = false;

  /** Handle for the auto-listen delay timer, if one is pending. */
  private listenTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param config     Conversation-specific settings.
   * @param callbacks  Hooks into mic and playback managed elsewhere.
   */
  constructor(
    private config: ConversationConfig,
    private callbacks: ConversationCallbacks,
  ) {}

  // ── Enable / Disable ──────────────────────────────────────────────

  /**
   * Turn conversation mode on or off.
   *
   * Disabling clears any pending auto-listen timer and resets internal
   * tracking state.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.cancelPendingListen();
      this.awaitingTTSEnd = false;
    }
  }

  /** Whether conversation mode is currently active. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Whether the controller is waiting for TTS playback to finish. */
  isAwaitingTTSEnd(): boolean {
    return this.awaitingTTSEnd;
  }

  // ── Event Handlers (called by the extension host) ─────────────────

  /**
   * Notify the controller that TTS has finished reading a response.
   *
   * If conversation mode is on and `autoListenAfterTTS` is enabled,
   * the controller schedules mic activation after
   * `delayBeforeListenMs` milliseconds.
   */
  onTTSEnd(): void {
    if (!this.awaitingTTSEnd) return;
    this.awaitingTTSEnd = false;

    if (!this.enabled || !this.config.autoListenAfterTTS) {
      return;
    }

    // Don't stack timers
    this.cancelPendingListen();

    // If the mic is already on (e.g. user toggled manually) do nothing.
    if (this.callbacks.isListening()) {
      return;
    }

    this.listenTimer = setTimeout(async () => {
      this.listenTimer = null;
      // Guard again — user may have toggled state during the delay.
      if (!this.enabled || this.callbacks.isListening()) {
        return;
      }
      try {
        await this.callbacks.startListening();
      } catch {
        // Mic start failure is surfaced elsewhere; swallow here.
      }
    }, this.config.delayBeforeListenMs);
  }

  /**
   * Notify the controller that TTS has started reading a response.
   *
   * Sets the internal flag so we know to expect an `onTTSEnd` call.
   */
  onTTSStart(): void {
    if (!this.enabled) return;
    this.awaitingTTSEnd = true;
    // Cancel any pending listen — TTS is playing, we should not be
    // opening the mic right now.
    this.cancelPendingListen();
  }

  /**
   * Notify the controller that a prompt (voice or typed) was submitted.
   *
   * Resets state for the next response-listen cycle.
   */
  onPromptSubmitted(): void {
    this.cancelPendingListen();
    this.awaitingTTSEnd = false;
  }

  /**
   * Notify the controller that the user is providing manual input
   * (typing, clicking, manual mic toggle).
   *
   * Cancels any pending auto-listen to avoid fighting with the user.
   */
  onUserInput(): void {
    this.cancelPendingListen();
  }

  // ── Configuration ─────────────────────────────────────────────────

  /**
   * Hot-swap the conversation configuration.
   *
   * If the new config disables conversation mode entirely, the
   * controller is also disabled.
   */
  updateConfig(config: ConversationConfig): void {
    this.config = config;
    if (!config.enabled) {
      this.setEnabled(false);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  /**
   * Release all resources.  Safe to call more than once.
   */
  dispose(): void {
    this.cancelPendingListen();
    this.enabled = false;
    this.awaitingTTSEnd = false;
  }

  // ── Internals ─────────────────────────────────────────────────────

  /**
   * Cancel the pending auto-listen timer if one is scheduled.
   */
  private cancelPendingListen(): void {
    if (this.listenTimer !== null) {
      clearTimeout(this.listenTimer);
      this.listenTimer = null;
    }
  }
}
