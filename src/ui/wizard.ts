import type {
  VoiceConfig,
  STTProviderName,
  TTSProviderName,
  STTMode,
} from "../types.js";
import { getSTTProviders, getTTSProviders, setApiKey, getApiKey } from "../config.js";
import { truncateToWidth, matchesKey } from "@mariozechner/pi-tui";

// ─── Types ──────────────────────────────────────────────────────────────

interface ProviderRow {
  name: string;
  displayName: string;
  cost: string;
  type: string; // "Streaming" | "Batch"
  status: "available" | "needs-key" | "free";
  hasKey: boolean;
}

interface ModeRow {
  value: STTMode;
  label: string;
  description: string;
}

type WizardStepKind = "stt" | "stt-key" | "tts" | "tts-key" | "mode" | "summary";

interface WizardState {
  step: WizardStepKind;
  stepIndex: number;
  totalSteps: number;
  selectedIndex: number;
  sttProvider: STTProviderName | null;
  ttsProvider: TTSProviderName | null;
  sttMode: STTMode | null;
  apiKeyBuffer: string;
  apiKeyTarget: string; // provider name for current key entry
  sttRows: ProviderRow[];
  ttsRows: ProviderRow[];
  modeRows: ModeRow[];
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Run the first-time setup wizard for pi-voice.
 *
 * Presents a single polished overlay that guides through STT/TTS provider
 * selection, API key entry, input mode, and a final summary.
 *
 * Returns via `onComplete` when the user confirms.  Resolves silently
 * if cancelled.
 */
export async function runSetupWizard(
  ctx: any,
  onComplete: (config: Partial<VoiceConfig>) => void,
): Promise<void> {
  const result = await ctx.ui.custom(
    (tui: any, theme: any, _keybindings: any, done: (result: Partial<VoiceConfig> | null) => void) => {
      const state = buildInitialState();
      let cachedLines: string[] | null = null;

      function invalidate(): void {
        cachedLines = null;
        tui.requestRender();
      }

      // ── Navigation ────────────────────────────────────────────────

      function itemCount(): number {
        switch (state.step) {
          case "stt":
            return state.sttRows.length;
          case "tts":
            return state.ttsRows.length;
          case "mode":
            return state.modeRows.length;
          case "summary":
            return 2; // Save / Go back
          default:
            return 0;
        }
      }

      function advanceStep(): void {
        switch (state.step) {
          case "stt": {
            const row = state.sttRows[state.selectedIndex];
            state.sttProvider = row.name as STTProviderName;
            if (row.status === "needs-key" && !row.hasKey) {
              goToStep("stt-key", row.name);
            } else {
              goToStep("tts");
            }
            break;
          }
          case "stt-key":
            if (state.apiKeyBuffer.trim().length > 0) {
              setApiKey(state.apiKeyTarget, state.apiKeyBuffer.trim());
              goToStep("tts");
            }
            break;
          case "tts": {
            const row = state.ttsRows[state.selectedIndex];
            state.ttsProvider = row.name as TTSProviderName;
            if (row.status === "needs-key" && !row.hasKey && row.name !== state.sttProvider) {
              goToStep("tts-key", row.name);
            } else {
              goToStep("mode");
            }
            break;
          }
          case "tts-key":
            if (state.apiKeyBuffer.trim().length > 0) {
              setApiKey(state.apiKeyTarget, state.apiKeyBuffer.trim());
              goToStep("mode");
            }
            break;
          case "mode":
            state.sttMode = state.modeRows[state.selectedIndex].value;
            goToStep("summary");
            break;
          case "summary":
            if (state.selectedIndex === 0) {
              // Save
              done({
                stt: { provider: state.sttProvider!, mode: state.sttMode! } as any,
                tts: { provider: state.ttsProvider! } as any,
              });
            } else {
              // Go back
              goBack();
            }
            break;
        }
      }

      function goToStep(step: WizardStepKind, keyTarget?: string): void {
        state.step = step;
        state.selectedIndex = 0;
        state.apiKeyBuffer = "";
        state.apiKeyTarget = keyTarget ?? "";
        recalcStepIndex();
        invalidate();
      }

      function goBack(): void {
        switch (state.step) {
          case "stt":
            done(null); // cancel
            return;
          case "stt-key":
            goToStep("stt");
            return;
          case "tts":
            goToStep("stt");
            return;
          case "tts-key":
            goToStep("tts");
            return;
          case "mode":
            goToStep("tts");
            return;
          case "summary":
            goToStep("mode");
            return;
        }
      }

      function recalcStepIndex(): void {
        const steps = computeStepSequence();
        state.totalSteps = steps.length;
        state.stepIndex = steps.indexOf(state.step) + 1;
      }

      function computeStepSequence(): WizardStepKind[] {
        const seq: WizardStepKind[] = ["stt"];
        if (state.sttProvider) {
          const row = state.sttRows.find((r) => r.name === state.sttProvider);
          if (row && row.status === "needs-key" && !row.hasKey) seq.push("stt-key");
        }
        seq.push("tts");
        if (state.ttsProvider) {
          const row = state.ttsRows.find((r) => r.name === state.ttsProvider);
          if (row && row.status === "needs-key" && !row.hasKey && row.name !== state.sttProvider) {
            seq.push("tts-key");
          }
        }
        seq.push("mode", "summary");
        return seq;
      }

      // ── Input Handling ────────────────────────────────────────────

      return {
        render(width: number): string[] {
          if (cachedLines) return cachedLines;
          cachedLines = renderWizard(state, width, theme);
          return cachedLines;
        },

        invalidate(): void {
          cachedLines = null;
        },

        handleInput(data: string): void {
          const isKeyStep = state.step === "stt-key" || state.step === "tts-key";

          if (matchesKey(data, "escape")) {
            goBack();
            return;
          }

          if (isKeyStep) {
            handleKeyInput(data, state, invalidate, advanceStep);
            return;
          }

          if (matchesKey(data, "up")) {
            const count = itemCount();
            if (count > 0) {
              state.selectedIndex = (state.selectedIndex - 1 + count) % count;
              invalidate();
            }
            return;
          }

          if (matchesKey(data, "down")) {
            const count = itemCount();
            if (count > 0) {
              state.selectedIndex = (state.selectedIndex + 1) % count;
              invalidate();
            }
            return;
          }

          if (matchesKey(data, "enter")) {
            advanceStep();
            return;
          }
        },
      };
    },
    { overlay: true },
  );

  if (result) {
    onComplete(result);
  }
}

// ─── Input Handler for API Key Steps ────────────────────────────────────

function handleKeyInput(
  data: string,
  state: WizardState,
  invalidate: () => void,
  advanceStep: () => void,
): void {
  if (matchesKey(data, "enter")) {
    advanceStep();
    return;
  }

  if (matchesKey(data, "backspace")) {
    if (state.apiKeyBuffer.length > 0) {
      state.apiKeyBuffer = state.apiKeyBuffer.slice(0, -1);
      invalidate();
    }
    return;
  }

  // Accept printable ASCII characters
  if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
    state.apiKeyBuffer += data;
    invalidate();
  }
}

// ─── State Builder ──────────────────────────────────────────────────────

function buildInitialState(): WizardState {
  const sttProviders = getSTTProviders();
  const ttsProviders = getTTSProviders();

  const sttCosts: Record<string, string> = {
    deepgram: "$0.008/min",
    openai: "$0.003/min",
    azure: "$0.017/min",
    google: "$0.016/min",
    assemblyai: "$0.003/min",
    elevenlabs: "$0.007/min",
    "whisper-local": "Free",
  };

  const sttTypes: Record<string, string> = {
    deepgram: "Streaming",
    openai: "Batch",
    azure: "Streaming",
    google: "Batch",
    assemblyai: "Streaming",
    elevenlabs: "Batch",
    "whisper-local": "Batch",
  };

  const sttRows: ProviderRow[] = sttProviders.map((p) => ({
    name: p.name,
    displayName: p.displayName,
    cost: sttCosts[p.name] ?? "",
    type: sttTypes[p.name] ?? "",
    status: p.requiresApiKey ? (p.hasApiKey ? "available" : "needs-key") : "free",
    hasKey: p.hasApiKey,
  }));

  const ttsRows: ProviderRow[] = ttsProviders.map((p) => ({
    name: p.name,
    displayName: p.displayName,
    cost: "",
    type: "",
    status: p.requiresApiKey ? (p.hasApiKey ? "available" : "needs-key") : "free",
    hasKey: p.hasApiKey,
  }));

  const modeRows: ModeRow[] = [
    { value: "push-to-talk", label: "Push-to-talk", description: "Hold Alt+Space to record, release to stop" },
    { value: "toggle", label: "Toggle", description: "Press Alt+V to start/stop recording" },
    { value: "vad", label: "Voice activity detection", description: "Auto-detect speech, auto-stop on silence" },
  ];

  return {
    step: "stt",
    stepIndex: 1,
    totalSteps: 4, // minimum: stt, tts, mode, summary
    selectedIndex: 0,
    sttProvider: null,
    ttsProvider: null,
    sttMode: null,
    apiKeyBuffer: "",
    apiKeyTarget: "",
    sttRows,
    ttsRows,
    modeRows,
  };
}

// ─── Rendering ──────────────────────────────────────────────────────────

function renderWizard(state: WizardState, width: number, theme: any): string[] {
  const t = (text: string, w: number) => truncateToWidth(text, w);
  const fg = (color: string, text: string): string => (theme ? theme.fg(color, text) : text);
  const bold = (text: string): string => (theme ? theme.bold(text) : text);

  const lines: string[] = [];
  const pad = "  ";
  const inner = width - 4; // padding on both sides

  // ── Header ────────────────────────────────────────────────────────

  const progressDots = renderProgressDots(state, fg);
  const headerLeft = `${pad}\u{1F399}\uFE0F pi-voice Setup`;
  const headerRight = `[${state.stepIndex}/${state.totalSteps}]${pad}`;
  const headerGap = Math.max(1, width - visibleLen(headerLeft) - headerRight.length);
  const headerLine = headerLeft + " ".repeat(headerGap) + headerRight;

  lines.push("");
  lines.push(t(fg("accent", "\u2500".repeat(width)), width));
  lines.push(t(headerLine, width));
  lines.push(t(`${pad}${progressDots}`, width));
  lines.push(t(fg("accent", "\u2500".repeat(width)), width));
  lines.push("");

  // ── Body ──────────────────────────────────────────────────────────

  switch (state.step) {
    case "stt":
      lines.push(t(`${pad}${bold("Step 1: Choose your speech-to-text provider")}`, width));
      lines.push("");
      lines.push(t(`${pad}${fg("muted", "This controls how your voice is converted to text.")}`, width));
      lines.push(t(`${pad}${fg("muted", "Streaming providers give real-time feedback as you speak.")}`, width));
      lines.push("");
      lines.push(...renderProviderList(state.sttRows, state.selectedIndex, inner, pad, fg, true));
      lines.push("");
      lines.push(t(`${pad}${fg("success", "\u25CF")} Key available  ${fg("warning", "\u25CB")} Needs key  ${fg("accent", "\u2605")} Free/Local`, width));
      break;

    case "stt-key":
      lines.push(t(`${pad}${bold(`Step 2: Enter your ${providerDisplayName(state.apiKeyTarget)} API key`)}`, width));
      lines.push("");
      lines.push(t(`${pad}${fg("muted", keyInstructions(state.apiKeyTarget))}`, width));
      lines.push("");
      lines.push(...renderApiKeyInput(state.apiKeyBuffer, inner, pad, fg));
      break;

    case "tts":
      lines.push(t(`${pad}${bold("Step 3: Choose your text-to-speech provider")}`, width));
      lines.push("");
      lines.push(t(`${pad}${fg("muted", "This controls how pi speaks responses back to you.")}`, width));
      lines.push("");
      lines.push(...renderProviderList(state.ttsRows, state.selectedIndex, inner, pad, fg, false));
      lines.push("");
      lines.push(t(`${pad}${fg("success", "\u25CF")} Key available  ${fg("warning", "\u25CB")} Needs key  ${fg("accent", "\u2605")} Free`, width));
      break;

    case "tts-key":
      lines.push(t(`${pad}${bold(`Step 4: Enter your ${providerDisplayName(state.apiKeyTarget)} API key`)}`, width));
      lines.push("");
      lines.push(t(`${pad}${fg("muted", keyInstructions(state.apiKeyTarget))}`, width));
      lines.push("");
      lines.push(...renderApiKeyInput(state.apiKeyBuffer, inner, pad, fg));
      break;

    case "mode":
      lines.push(t(`${pad}${bold("Step 5: Choose your default input mode")}`, width));
      lines.push("");
      lines.push(t(`${pad}${fg("muted", "How you activate the microphone. You can change this anytime.")}`, width));
      lines.push("");
      lines.push(...renderModeList(state.modeRows, state.selectedIndex, pad, fg, width));
      break;

    case "summary":
      lines.push(t(`${pad}${bold("Setup Summary")}`, width));
      lines.push("");
      lines.push(t(`${pad}STT Provider:  ${fg("accent", providerDisplayName(state.sttProvider ?? ""))}`, width));
      lines.push(t(`${pad}TTS Provider:  ${fg("accent", providerDisplayName(state.ttsProvider ?? ""))}`, width));
      lines.push(t(`${pad}Input Mode:    ${fg("accent", state.sttMode ?? "")}`, width));
      lines.push("");
      lines.push(t(`${pad}${state.selectedIndex === 0 ? fg("accent", "> ") : "  "}${fg("success", "Save and finish")}`, width));
      lines.push(t(`${pad}${state.selectedIndex === 1 ? fg("accent", "> ") : "  "}${fg("muted", "Go back")}`, width));
      break;
  }

  // ── Footer ────────────────────────────────────────────────────────

  lines.push("");
  lines.push(t(fg("accent", "\u2500".repeat(width)), width));

  const isKeyStep = state.step === "stt-key" || state.step === "tts-key";
  const footerHint = isKeyStep
    ? `${pad}${fg("muted", "Type key \u2022 Enter confirm \u2022 Esc back")}`
    : state.step === "summary"
      ? `${pad}${fg("muted", "\u2191\u2193 select \u2022 Enter confirm \u2022 Esc back")}`
      : `${pad}${fg("muted", "\u2191\u2193 select \u2022 Enter next \u2022 Esc cancel")}`;
  lines.push(t(footerHint, width));
  lines.push(t(fg("accent", "\u2500".repeat(width)), width));

  return lines;
}

// ─── Sub-renderers ──────────────────────────────────────────────────────

function renderProgressDots(
  state: WizardState,
  fg: (color: string, text: string) => string,
): string {
  const parts: string[] = [];
  for (let i = 1; i <= state.totalSteps; i++) {
    if (i < state.stepIndex) {
      parts.push(fg("success", "\u25CF"));
    } else if (i === state.stepIndex) {
      parts.push(fg("accent", "\u25CF"));
    } else {
      parts.push(fg("muted", "\u25CB"));
    }
  }
  return parts.join(" ");
}

function renderProviderList(
  rows: ProviderRow[],
  selectedIndex: number,
  innerWidth: number,
  pad: string,
  fg: (color: string, text: string) => string,
  showCostAndType: boolean,
): string[] {
  const lines: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const isSelected = i === selectedIndex;
    const cursor = isSelected ? fg("accent", "> ") : "  ";

    let icon: string;
    if (row.status === "free") {
      icon = fg("accent", "\u2605");
    } else if (row.hasKey) {
      icon = fg("success", "\u25CF");
    } else {
      icon = fg("warning", "\u25CB");
    }

    const name = isSelected ? fg("accent", row.displayName) : row.displayName;

    let suffix = "";
    if (showCostAndType) {
      const costPart = row.cost.padEnd(12);
      const typePart = `[${row.type}]`;
      suffix = fg("muted", `${costPart}${typePart}`);
      if (row.status === "needs-key" && !row.hasKey) {
        suffix += fg("warning", "  Needs key");
      } else if (row.status === "free") {
        suffix += fg("muted", "  Offline");
      }
    } else {
      if (row.status === "needs-key" && !row.hasKey) {
        suffix = fg("warning", "Needs key");
      } else if (row.status === "free") {
        const isFreeRec = row.name === "edge-tts";
        suffix = isFreeRec ? fg("success", "\u2605 Recommended (Free)") : fg("muted", "Free");
      }
    }

    const nameCol = row.displayName.length < 24 ? row.displayName.padEnd(24) : row.displayName;
    const styledName = isSelected ? fg("accent", nameCol) : nameCol;
    const line = `${pad}${cursor}${icon} ${styledName} ${suffix}`;
    lines.push(truncateToWidth(line, innerWidth + 4));
  }

  return lines;
}

function renderModeList(
  rows: ModeRow[],
  selectedIndex: number,
  pad: string,
  fg: (color: string, text: string) => string,
  width: number,
): string[] {
  const lines: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const isSelected = i === selectedIndex;
    const cursor = isSelected ? fg("accent", "> ") : "  ";
    const icon = isSelected ? fg("accent", "\u25CF") : fg("muted", "\u25CB");
    const label = isSelected ? fg("accent", row.label) : row.label;

    lines.push(truncateToWidth(`${pad}${cursor}${icon} ${label}`, width));
    lines.push(truncateToWidth(`${pad}     ${fg("muted", row.description)}`, width));
    if (i < rows.length - 1) lines.push("");
  }

  return lines;
}

function renderApiKeyInput(
  buffer: string,
  _innerWidth: number,
  pad: string,
  fg: (color: string, text: string) => string,
): string[] {
  const masked = buffer.length > 0
    ? "*".repeat(Math.max(0, buffer.length - 4)) + buffer.slice(-4)
    : "";
  const display = masked.length > 0 ? masked : fg("muted", "(type your key here)");
  const cursor = fg("accent", "\u2588");

  return [
    `${pad}  ${display}${cursor}`,
    "",
    `${pad}  ${fg("muted", `${buffer.length} characters entered`)}`,
  ];
}

// ─── Helpers ────────────────────────────────────────────────────────────

function providerDisplayName(provider: string): string {
  const map: Record<string, string> = {
    deepgram: "Deepgram Nova-3",
    openai: "OpenAI Whisper",
    azure: "Azure Speech",
    google: "Google Cloud",
    assemblyai: "AssemblyAI",
    elevenlabs: "ElevenLabs",
    cartesia: "Cartesia",
    "whisper-local": "Whisper Local",
    "edge-tts": "Edge TTS",
    piper: "Piper",
    system: "System TTS",
  };
  return map[provider] ?? provider;
}

function keyInstructions(provider: string): string {
  const map: Record<string, string> = {
    deepgram: "Get your key at console.deepgram.com",
    openai: "Get your key at platform.openai.com/api-keys",
    azure: "Get your key from the Azure Portal > Speech resource",
    google: "Set GOOGLE_APPLICATION_CREDENTIALS or paste a key",
    assemblyai: "Get your key at assemblyai.com/dashboard",
    elevenlabs: "Get your key at elevenlabs.io/profile",
    cartesia: "Get your key at play.cartesia.ai/console",
  };
  return map[provider] ?? `Enter the API key for ${providerDisplayName(provider)}`;
}

/**
 * Approximate visible length of a string (strips ANSI escape codes).
 */
function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
