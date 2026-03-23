import type { VoiceState } from "../types.js";

/**
 * Manages voice-related status bar indicators in the pi TUI.
 *
 * Renders up to three status bar slots:
 * - `voice-mic`: microphone / listening state
 * - `voice-tts`: text-to-speech / playback state
 * - `voice-conv`: conversation mode indicator
 */
export class VoiceStatusBar {
  /** Handle to the pi extension context. */
  private ctx: any;

  /** Timeout id for auto-clearing flash messages. */
  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: any) {
    this.ctx = ctx;
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Refresh every status bar slot to reflect the current {@link VoiceState}.
   *
   * Call this whenever state changes — the method is cheap and idempotent.
   */
  update(state: VoiceState): void {
    this.updateMicStatus(state);
    this.updateTTSStatus(state);
    this.updateConversationStatus(state);
  }

  /**
   * Display a short notification in the status bar that auto-clears after
   * 3 seconds.  Useful for one-shot confirmations like "Mic muted".
   *
   * @param message  Human-readable status text.
   * @param type     Severity — maps to theme colour.
   */
  flash(message: string, type: "info" | "success" | "warning" | "error"): void {
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }

    const theme = this.ctx.ui.theme;
    const colorName = typeToThemeColor(type);
    const styled = theme ? theme.fg(colorName, message) : message;

    this.ctx.ui.setStatus("voice-flash", styled);

    this.flashTimer = setTimeout(() => {
      this.ctx.ui.setStatus("voice-flash", undefined);
      this.flashTimer = null;
    }, 3000);
  }

  /**
   * Remove all voice-related status bar indicators.
   */
  clear(): void {
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
    this.ctx.ui.setStatus("voice-mic", undefined);
    this.ctx.ui.setStatus("voice-tts", undefined);
    this.ctx.ui.setStatus("voice-conv", undefined);
    this.ctx.ui.setStatus("voice-flash", undefined);
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Update the microphone status slot.
   *
   * States (in priority order):
   * 1. Actively listening  -> green "Listening" with waveform level meter
   * 2. Mic on but idle     -> dim   "Ready"
   * 3. Mic off             -> slot cleared
   */
  private updateMicStatus(state: VoiceState): void {
    const theme = this.ctx.ui.theme;

    if (!state.micActive) {
      this.ctx.ui.setStatus("voice-mic", undefined);
      return;
    }

    if (state.isListening) {
      const level = this.renderAudioLevel(state.audioLevel);
      const label = `\u{1F399}\uFE0F Listening ${level}`;
      const styled = theme ? theme.fg("success", label) : label;
      this.ctx.ui.setStatus("voice-mic", styled);
      return;
    }

    // Mic active but not currently listening (e.g. between utterances in toggle mode)
    const label = "\u{1F399}\uFE0F Ready";
    const styled = theme ? theme.fg("muted", label) : label;
    this.ctx.ui.setStatus("voice-mic", styled);
  }

  /**
   * Update the TTS status slot.
   *
   * States:
   * 1. Speaking          -> accent "Speaking"
   * 2. Muted             -> dim    "Muted"
   * 3. TTS active (idle) -> slot cleared (nothing to show)
   * 4. TTS off           -> slot cleared
   */
  private updateTTSStatus(state: VoiceState): void {
    const theme = this.ctx.ui.theme;

    if (!state.ttsActive) {
      this.ctx.ui.setStatus("voice-tts", undefined);
      return;
    }

    if (state.ttsMuted) {
      const label = "\u{1F507} Muted";
      const styled = theme ? theme.fg("muted", label) : label;
      this.ctx.ui.setStatus("voice-tts", styled);
      return;
    }

    if (state.isSpeaking) {
      const label = "\u{1F50A} Speaking";
      const styled = theme ? theme.fg("accent", label) : label;
      this.ctx.ui.setStatus("voice-tts", styled);
      return;
    }

    // TTS active but not currently speaking — nothing to show
    this.ctx.ui.setStatus("voice-tts", undefined);
  }

  /**
   * Update the conversation-mode indicator.
   * Shows a persistent badge when conversation mode is enabled.
   */
  private updateConversationStatus(state: VoiceState): void {
    const theme = this.ctx.ui.theme;

    if (!state.conversationMode) {
      this.ctx.ui.setStatus("voice-conv", undefined);
      return;
    }

    const label = "\u{1F4AC} Conv";
    const styled = theme ? theme.fg("accent", label) : label;
    this.ctx.ui.setStatus("voice-conv", styled);
  }

  /**
   * Render a waveform-style audio level meter using block characters.
   *
   * Uses `▁▂▃▄` for a proper waveform look instead of plain bars.
   *
   * @param level  Normalised audio level in the range `[0, 1]`.
   * @returns      A 4-character waveform string.
   */
  private renderAudioLevel(level: number): string {
    const clamped = Math.max(0, Math.min(1, level));
    // Map 0..1 to 0..4 steps.  Each of the 4 positions gets a height
    // character based on the level reaching that position's threshold.
    const blocks = ["\u2581", "\u2582", "\u2583", "\u2584"]; // ▁▂▃▄
    const thresholds = [0.05, 0.25, 0.50, 0.75];
    const chars = thresholds.map((t, i) => (clamped >= t ? blocks[i] : blocks[0]));
    return chars.join("");
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Map notification type to a pi theme colour name. */
function typeToThemeColor(type: "info" | "success" | "warning" | "error"): string {
  switch (type) {
    case "info":
      return "muted";
    case "success":
      return "success";
    case "warning":
      return "warning";
    case "error":
      return "error";
  }
}
