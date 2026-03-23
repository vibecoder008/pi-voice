import type { VoiceConfig } from "../types.js";
import { truncateToWidth, matchesKey } from "@mariozechner/pi-tui";

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Show a quick-reference help overlay for pi-voice.
 *
 * Displays keybindings, slash commands, voice commands, and the current
 * configuration at a glance.  Dismissed with Escape.
 */
export async function showHelpOverlay(ctx: any, config: VoiceConfig): Promise<void> {
  await ctx.ui.custom(
    (_tui: any, theme: any, _keybindings: any, done: (result: undefined) => void) => {
      let cachedLines: string[] | null = null;

      return {
        render(width: number): string[] {
          if (cachedLines) return cachedLines;
          cachedLines = renderHelp(config, width, theme);
          return cachedLines;
        },

        invalidate(): void {
          cachedLines = null;
        },

        handleInput(data: string): void {
          if (matchesKey(data, "escape") || matchesKey(data, "q")) {
            done(undefined);
          }
        },
      };
    },
    { overlay: true },
  );
}

// ─── Rendering ──────────────────────────────────────────────────────────

function renderHelp(config: VoiceConfig, width: number, theme: any): string[] {
  const t = (text: string) => truncateToWidth(text, width);
  const fg = (color: string, text: string): string => (theme ? theme.fg(color, text) : text);
  const bold = (text: string): string => (theme ? theme.bold(text) : text);

  const pad = "  ";
  const lines: string[] = [];
  const rule = fg("accent", "\u2500".repeat(width));

  // ── Header ────────────────────────────────────────────────────────

  lines.push("");
  lines.push(t(rule));
  lines.push(t(`${pad}\u{1F399}\uFE0F pi-voice Quick Reference`));
  lines.push(t(rule));
  lines.push("");

  // ── Keybindings ───────────────────────────────────────────────────

  lines.push(t(`${pad}${bold("Keybindings")}`));
  lines.push(t(`${pad}  ${fg("accent", padRight(config.keybindings.toggleMic, 14))}Toggle microphone`));
  lines.push(t(`${pad}  ${fg("accent", padRight(config.keybindings.muteTTS, 14))}Mute/unmute TTS`));
  lines.push(t(`${pad}  ${fg("accent", padRight(config.keybindings.pushToTalk, 14))}Push-to-talk / Toggle`));
  lines.push("");

  // ── Commands ──────────────────────────────────────────────────────

  lines.push(t(`${pad}${bold("Commands")}`));
  lines.push(t(`${pad}  ${fg("accent", padRight("/voice", 22))}Show status`));
  lines.push(t(`${pad}  ${fg("accent", padRight("/voice start|stop", 22))}Control mic`));
  lines.push(t(`${pad}  ${fg("accent", padRight("/voice mute|unmute", 22))}Control TTS`));
  lines.push(t(`${pad}  ${fg("accent", padRight("/voice settings", 22))}Open settings panel`));
  lines.push(t(`${pad}  ${fg("accent", padRight("/voice setup", 22))}Run setup wizard`));
  lines.push(t(`${pad}  ${fg("accent", padRight("/voice conversation", 22))}Toggle conversation mode`));
  lines.push(t(`${pad}  ${fg("accent", padRight("/voice help", 22))}Show this help`));
  lines.push("");

  // ── Voice Commands ────────────────────────────────────────────────

  lines.push(t(`${pad}${bold("Voice Commands")} ${fg("muted", "(say these while dictating)")}`));
  lines.push(t(`${pad}  ${fg("accent", padRight('"send it"', 22))}Submit prompt`));
  lines.push(t(`${pad}  ${fg("accent", padRight('"cancel"', 22))}Cancel dictation`));
  lines.push(t(`${pad}  ${fg("accent", padRight('"period" "comma"', 22))}Insert punctuation`));
  lines.push(t(`${pad}  ${fg("accent", padRight('"new line"', 22))}Insert newline`));
  lines.push(t(`${pad}  ${fg("accent", padRight('"slash compact"', 22))}Run /compact`));
  lines.push("");

  // ── Current Config ────────────────────────────────────────────────

  lines.push(t(`${pad}${bold("Current Config")}`));
  lines.push(t(`${pad}  STT: ${fg("accent", providerLabel(config.stt.provider))} (${config.stt.mode} mode)`));
  lines.push(t(`${pad}  TTS: ${fg("accent", providerLabel(config.tts.provider))} (${config.tts.triggerMode} trigger)`));
  lines.push(t(`${pad}  Voice: ${fg("accent", config.tts.voice)}`));
  lines.push("");

  // ── Footer ────────────────────────────────────────────────────────

  lines.push(t(rule));
  lines.push(t(`${pad}${fg("muted", "Esc close \u2022 /voice settings for full config")}`));
  lines.push(t(rule));

  return lines;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function padRight(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function providerLabel(provider: string): string {
  const map: Record<string, string> = {
    deepgram: "Deepgram Nova-3",
    openai: "OpenAI Whisper",
    azure: "Azure Speech",
    google: "Google Cloud",
    assemblyai: "AssemblyAI",
    elevenlabs: "ElevenLabs",
    "whisper-local": "Whisper Local",
    "edge-tts": "Edge TTS",
    cartesia: "Cartesia Sonic",
    piper: "Piper",
    system: "System TTS",
  };
  return map[provider] ?? provider;
}
