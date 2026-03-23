/**
 * pi-voice — Bidirectional voice extension for Pi
 *
 * Features:
 * - Voice dictation (STT) with real-time partial transcription
 * - Text-to-speech (TTS) reading of agent responses
 * - Full conversation mode (speak → respond → listen loop)
 * - Voice commands (punctuation, submission, pi commands, navigation)
 * - Multi-provider support (7 STT + 9 TTS providers)
 * - Interactive settings panel and setup wizard
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  loadConfig,
  saveConfig,
  getApiKey,
  setApiKey,
  getSTTProviders,
  getTTSProviders,
  DEFAULT_CONFIG,
} from "./config.js";
import type {
  VoiceConfig,
  VoiceState,
  STTProvider,
  TTSProvider,
  STTTranscript,
  TTSAudioChunk,
  MicRecorder,
  AudioSpeaker,
  VoiceCommandAction,
} from "./types.js";
import { createMicRecorder, createAudioSpeaker } from "./audio/index.js";
import { createSTTProvider } from "./stt/index.js";
import { createTTSProvider } from "./tts/index.js";
import { TextProcessor } from "./text-processor.js";
import { VoiceCommandParser } from "./voice-commands/index.js";
import { ConversationController } from "./conversation.js";
import { VoiceStatusBar } from "./ui/status.js";
import { showSettingsPanel } from "./ui/settings.js";
import { runSetupWizard } from "./ui/wizard.js";
import { showHelpOverlay } from "./ui/help.js";

// ─── Main Extension Entry Point ─────────────────────────────────────────

export default function piVoice(pi: ExtensionAPI) {
  // ── State ──────────────────────────────────────────────────────────
  let config: VoiceConfig = loadConfig();
  let state: VoiceState = {
    micActive: false,
    micMode: config.stt.mode,
    ttsActive: config.tts.triggerMode === "always",
    ttsMuted: false,
    ttsTriggerMode: config.tts.triggerMode,
    conversationMode: config.conversation.enabled,
    isListening: false,
    isSpeaking: false,
    currentTranscript: "",
    sttProvider: config.stt.provider,
    ttsProvider: config.tts.provider,
    audioLevel: 0,
  };

  // ── Components (lazy init) ─────────────────────────────────────────
  let mic: MicRecorder | null = null;
  let speaker: AudioSpeaker | null = null;
  let sttProvider: STTProvider | null = null;
  let ttsProvider: TTSProvider | null = null;
  let textProcessor: TextProcessor | null = null;
  let commandParser: VoiceCommandParser | null = null;
  let conversationCtrl: ConversationController | null = null;
  let statusBar: VoiceStatusBar | null = null;

  // Speech queue for serialized TTS playback
  let speechQueue: Array<{ text: string; type: string }> = [];
  let speechProcessing = false;
  let speechAbort: AbortController | null = null;

  // Track whether we're in an agent response for TTS
  let agentStreaming = false;

  // Track whether "Pi is thinking..." has been announced this message
  let thinkingAnnounced = false;

  // Track push-to-talk key state
  let pushToTalkHeld = false;

  // Mutex for mic start/stop transitions
  let micTransitioning = false;

  // Throttle for audio level updates
  let lastLevelUpdate = 0;

  // ── Lazy Initialization ────────────────────────────────────────────

  function ensureTextProcessor(): TextProcessor {
    if (!textProcessor) {
      textProcessor = new TextProcessor({
        codeBlockBehavior: config.tts.codeBlockBehavior,
        toolCallBehavior: config.tts.toolCallBehavior,
        thinkingBehavior: config.tts.thinkingBehavior,
      });
    }
    return textProcessor;
  }

  function ensureCommandParser(): VoiceCommandParser {
    if (!commandParser) {
      commandParser = new VoiceCommandParser(config.voiceCommands);
    }
    return commandParser;
  }

  function ensureConversationController(): ConversationController {
    if (!conversationCtrl) {
      conversationCtrl = new ConversationController(config.conversation, {
        startListening: () => startListening(currentCtx),
        stopListening: () => stopListening(currentCtx),
        isListening: () => state.isListening,
        isSpeaking: () => state.isSpeaking,
      });
    }
    return conversationCtrl;
  }

  async function ensureMic(): Promise<MicRecorder> {
    if (!mic) {
      mic = createMicRecorder(
        { sampleRate: 16000, channels: 1, bitDepth: 16 },
        config.stt.vadSilenceMs
      );

      mic.onData((chunk) => {
        sttProvider?.sendAudio(chunk);
        const now = Date.now();
        if (now - lastLevelUpdate > 200) {
          state.audioLevel = mic!.getLevel();
          updateStatus();
          lastLevelUpdate = now;
        }
      });

      mic.onSilence(() => {
        if (config.stt.mode === "vad" && state.isListening) {
          stopListening(currentCtx);
        }
      });

      mic.onError((err) => {
        if (!currentCtx?.hasUI) return;
        currentCtx.ui.notify(`Mic error: ${err.message}`, "error");
        state.isListening = false;
        state.micActive = false;
        sttProvider?.stopListening().catch(() => { /* swallow cleanup errors */ });
        state.ttsActive = shouldTTSBeActive();
        updateStatus();
      });
    }
    return mic;
  }

  async function ensureSpeaker(): Promise<AudioSpeaker> {
    if (!speaker) {
      speaker = createAudioSpeaker({ sampleRate: 24000, channels: 1, bitDepth: 16 });
    }
    return speaker;
  }

  function handleSTTError(err: Error): void {
    currentCtx?.ui.notify(`STT error: ${err.message}`, "error");
  }

  async function ensureSTT(): Promise<STTProvider> {
    if (sttProvider && sttProvider.name === config.stt.provider) return sttProvider;

    // Dispose old provider — remove listeners first
    if (sttProvider) {
      sttProvider.off("transcript", handleTranscript);
      sttProvider.off("error", handleSTTError);
      await sttProvider.dispose();
      sttProvider = null;
    }

    // Create and init new provider — only assign on success
    const newProvider = createSTTProvider(config.stt.provider);
    try {
      await newProvider.initialize(config.stt);
    } catch (err) {
      await newProvider.dispose();
      throw err;
    }

    sttProvider = newProvider;
    sttProvider.on("transcript", handleTranscript);
    sttProvider.on("error", handleSTTError);

    return sttProvider;
  }

  function handleTTSStart(): void {
    state.isSpeaking = true;
    updateStatus();
    ensureConversationController().onTTSStart();
  }

  function handleTTSEnd(): void {
    state.isSpeaking = false;
    speaker?.setVolume(1.0);
    updateStatus();
    ensureConversationController().onTTSEnd();
  }

  function handleTTSAudioChunk(chunk: TTSAudioChunk): void {
    void ensureSpeaker().then((spk) => spk.play(chunk.audio));
  }

  function handleTTSError(err: Error): void {
    state.isSpeaking = false;
    updateStatus();
    currentCtx?.ui.notify(`TTS error: ${err.message}`, "error");
  }

  async function ensureTTS(): Promise<TTSProvider> {
    if (ttsProvider && ttsProvider.name === config.tts.provider) return ttsProvider;

    // Dispose old provider — remove listeners first
    if (ttsProvider) {
      ttsProvider.off("start", handleTTSStart);
      ttsProvider.off("end", handleTTSEnd);
      ttsProvider.off("audioChunk", handleTTSAudioChunk);
      ttsProvider.off("error", handleTTSError);
      await ttsProvider.dispose();
      ttsProvider = null;
    }

    // Create and init new provider — only assign on success
    const newProvider = createTTSProvider(config.tts.provider);
    try {
      await newProvider.initialize(config.tts);
    } catch (err) {
      await newProvider.dispose();
      throw err;
    }

    ttsProvider = newProvider;
    ttsProvider.on("start", handleTTSStart);
    ttsProvider.on("end", handleTTSEnd);
    ttsProvider.on("audioChunk", handleTTSAudioChunk);
    ttsProvider.on("error", handleTTSError);

    return ttsProvider;
  }

  // ── Current context reference ──────────────────────────────────────
  let currentCtx: any = null;

  // ── Status bar ─────────────────────────────────────────────────────

  function updateStatus(): void {
    if (!currentCtx?.hasUI) return;
    if (statusBar) statusBar.update(state);
  }

  // ── STT: Start / Stop Listening ────────────────────────────────────

  async function startListening(ctx: any): Promise<void> {
    if (state.isListening || micTransitioning) return;
    if (!ctx?.hasUI) return;
    micTransitioning = true;

    try {
      // Set flag FIRST to prevent race conditions
      state.isListening = true;

      const micInstance = await ensureMic();
      const stt = await ensureSTT();

      await stt.startListening();
      await micInstance.start();

      state.micActive = true;
      state.ttsActive = shouldTTSBeActive();
      state.currentTranscript = "";
      updateStatus();
    } catch (err: any) {
      state.isListening = false;
      ctx?.ui?.notify(`Failed to start listening: ${err.message}`, "error");
    } finally {
      micTransitioning = false;
    }
  }

  async function stopListening(ctx: any): Promise<void> {
    if (!state.isListening || micTransitioning) return;
    micTransitioning = true;

    try {
      await mic?.stop();
      const finalTranscript = await sttProvider?.stopListening();

      state.isListening = false;
      state.micActive = config.stt.mode === "toggle"; // Stay "active" in toggle mode
      state.ttsActive = shouldTTSBeActive();
      state.currentTranscript = "";
      updateStatus();

      if (finalTranscript?.trim()) {
        handleFinalTranscript(finalTranscript.trim(), ctx);
      }
    } catch (err: any) {
      state.isListening = false;
      updateStatus();
      ctx?.ui?.notify(`Failed to stop listening: ${err.message}`, "error");
    } finally {
      micTransitioning = false;
    }
  }

  // ── STT: Handle Transcripts ────────────────────────────────────────

  function handleTranscript(transcript: STTTranscript): void {
    if (!currentCtx?.hasUI) return;
    if (!state.isListening) return; // guard against late transcripts

    if (transcript.isFinal) {
      // Accumulate final transcript
      state.currentTranscript += (state.currentTranscript ? " " : "") + transcript.text;
    }

    // Show real-time partial transcription in editor
    const display = transcript.isFinal
      ? state.currentTranscript
      : state.currentTranscript + (state.currentTranscript ? " " : "") + transcript.text;

    currentCtx.ui.setEditorText(display);
  }

  function sendVoiceMessage(text: string): void {
    if (currentCtx?.isIdle?.()) {
      pi.sendUserMessage(text);
    } else {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    }
    ensureConversationController().onPromptSubmitted();
  }

  function handleFinalTranscript(text: string, ctx: any): void {
    const parser = ensureCommandParser();

    // Parse for voice commands
    const result = parser.parse(text);

    if (result.matched && result.action) {
      // Execute voice command
      executeVoiceCommand(result.action, ctx);

      // If there's remaining text, put it in the editor
      if (result.remainingText?.trim()) {
        const cleaned = parser.applyInlineCommands(result.remainingText.trim());
        if (config.stt.autoSend) {
          sendVoiceMessage(cleaned);
        } else {
          ctx.ui.setEditorText(cleaned);
        }
      }
    } else {
      // No command matched — apply inline formatting and handle text
      const cleaned = parser.applyInlineCommands(text);
      if (config.stt.autoSend) {
        sendVoiceMessage(cleaned);
      } else {
        ctx.ui.setEditorText(cleaned);
      }
    }
  }

  // ── Voice Command Execution ────────────────────────────────────────

  function executeVoiceCommand(action: VoiceCommandAction, ctx: any): void {
    switch (action.type) {
      case "submit":
        // Send whatever is in the current transcript
        if (state.currentTranscript.trim()) {
          const parser = ensureCommandParser();
          const cleaned = parser.applyInlineCommands(state.currentTranscript.trim());
          sendVoiceMessage(cleaned);
        }
        break;

      case "cancel":
        ctx.ui.setEditorText("");
        state.currentTranscript = "";
        break;

      case "clear":
        ctx.ui.setEditorText("");
        state.currentTranscript = "";
        break;

      case "undo":
        // Remove last word from transcript
        const words = state.currentTranscript.trim().split(/\s+/);
        words.pop();
        state.currentTranscript = words.join(" ");
        ctx.ui.setEditorText(state.currentTranscript);
        break;

      case "newline":
        state.currentTranscript += "\n";
        ctx.ui.setEditorText(state.currentTranscript);
        break;

      case "punctuation":
        state.currentTranscript = state.currentTranscript.trimEnd() + action.char + " ";
        ctx.ui.setEditorText(state.currentTranscript);
        break;

      case "insert":
        state.currentTranscript += action.text;
        ctx.ui.setEditorText(state.currentTranscript);
        break;

      case "select-all":
        // In voice context, this doesn't map directly — just notify
        ctx.ui.notify("Select all (use keyboard)", "info");
        break;

      case "delete-word":
        const w = state.currentTranscript.trim().split(/\s+/);
        w.pop();
        state.currentTranscript = w.join(" ");
        ctx.ui.setEditorText(state.currentTranscript);
        break;

      case "pi-command":
        // Execute a pi slash command
        ctx.ui.notify(`Running /${action.command}${action.args ? " " + action.args : ""}`, "info");
        break;

      case "set-model":
        ctx.ui.notify(`Switch model to: ${action.model}`, "info");
        break;

      case "scroll":
        ctx.ui.notify(`Scroll ${action.direction}`, "info");
        break;

      case "read-again":
        replayLastResponse(ctx);
        break;

      case "stop-reading":
        stopTTS();
        break;

      case "toggle-voice-mode":
        toggleConversationMode(ctx);
        break;
    }
  }

  // ── TTS: Speak / Stop ─────────────────────────────────────────────

  async function enqueueSpeech(text: string): Promise<void> {
    if (state.ttsMuted || !text.trim()) return;
    if (speechQueue.length >= 50) {
      speechQueue.pop(); // drop newest, not the one about to play
    }
    speechQueue.push({ text, type: "speech" });
    if (!speechProcessing) processSpeechQueue();
  }

  async function processSpeechQueue(): Promise<void> {
    if (speechProcessing) return;
    speechProcessing = true;

    try {
      while (speechQueue.length > 0) {
        const item = speechQueue.shift()!;
        try {
          const tts = await ensureTTS();
          speechAbort = new AbortController();
          await tts.speak(item.text, speechAbort.signal);
        } catch (err: any) {
          if (err.name === "AbortError") {
            speechQueue = []; // Clear queue on abort
            break;
          }
          currentCtx?.ui.notify(`TTS error: ${err.message}`, "error");
        }
      }
    } finally {
      speechProcessing = false;
      speechAbort = null;
    }
  }

  function stopTTS(): void {
    speechQueue = [];
    speechAbort?.abort();
    speechAbort = null;
    ttsProvider?.stop();
    speaker?.stop();
    state.isSpeaking = false;
    state.ttsActive = shouldTTSBeActive();
    updateStatus();
  }

  async function interruptTTS(): Promise<void> {
    if (!state.isSpeaking) return;

    switch (config.tts.interruptBehavior) {
      case "immediate":
        stopTTS();
        break;
      case "fade":
        if (speaker) {
          await speaker.fadeOut(config.tts.fadeDurationMs);
        }
        stopTTS();
        ensureConversationController().onUserInput(); // cancel auto-listen after fade
        break;
      case "finish-sentence":
        speechQueue = []; // Clear queue to prevent next items
        // Do NOT abort current speech — let it finish
        break;
      case "lower-volume":
        speaker?.setVolume(0.2);
        break;
    }
  }

  // Last response for "read again" command (stores processed text, not raw markdown)
  let lastResponseProcessed = "";

  async function replayLastResponse(ctx: any): Promise<void> {
    if (!lastResponseProcessed.trim()) {
      if (currentCtx?.hasUI) ctx.ui.notify("No previous response to replay", "info");
      return;
    }
    await enqueueSpeech(lastResponseProcessed.trim());
  }

  // ── Conversation Mode ──────────────────────────────────────────────

  function toggleConversationMode(ctx: any): void {
    const ctrl = ensureConversationController();
    const newState = !ctrl.isEnabled();
    ctrl.setEnabled(newState);
    state.conversationMode = newState;
    state.ttsActive = shouldTTSBeActive();
    updateStatus();
    ctx.ui.notify(
      `Conversation mode: ${newState ? "ON" : "OFF"}`,
      newState ? "success" : "info"
    );
  }

  // ── TTS trigger logic ─────────────────────────────────────────────

  function shouldTTSBeActive(): boolean {
    if (state.ttsMuted) return false;
    switch (state.ttsTriggerMode) {
      case "always":
        return true;
      case "voice-mode":
        return state.micActive || state.conversationMode;
      case "manual":
        return false;
    }
  }

  // ── Config Management ──────────────────────────────────────────────

  function applyConfig(newConfig: VoiceConfig): void {
    const sttChanged = newConfig.stt.provider !== config.stt.provider;
    const ttsChanged = newConfig.tts.provider !== config.tts.provider;

    // Stop recording if STT provider is changing
    if (sttChanged && state.isListening) {
      void stopListening(currentCtx);
    }

    // Stop speaking if TTS provider is changing
    if (ttsChanged && state.isSpeaking) {
      stopTTS();
    }

    config = newConfig;
    saveConfig(config);

    // Update sub-components
    state.micMode = config.stt.mode;
    state.ttsTriggerMode = config.tts.triggerMode;
    state.sttProvider = config.stt.provider;
    state.ttsProvider = config.tts.provider;
    state.ttsActive = shouldTTSBeActive();

    textProcessor?.updateConfig({
      codeBlockBehavior: config.tts.codeBlockBehavior,
      toolCallBehavior: config.tts.toolCallBehavior,
      thinkingBehavior: config.tts.thinkingBehavior,
    });
    commandParser?.updateConfig(config.voiceCommands);
    conversationCtrl?.updateConfig(config.conversation);

    updateStatus();
  }

  // ══════════════════════════════════════════════════════════════════════
  // EVENT HOOKS — Wire into pi's lifecycle
  // ══════════════════════════════════════════════════════════════════════

  // ── Session Start ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    statusBar = new VoiceStatusBar(ctx);
    updateStatus();

    // Check if first run (no config file exists)
    const providers = getSTTProviders();
    const hasAnyKey = providers.some((p) => p.hasApiKey);
    const hasConfig = existsSync(join(homedir(), ".pi", "voice.json"));

    if (!hasConfig && !hasAnyKey) {
      // Show setup wizard notification (don't auto-launch — user might not want it)
      ctx.ui.notify(
        "🎙️ pi-voice loaded! Run /voice setup to configure voice input/output.",
        "info"
      );
    } else {
      ctx.ui.notify("🎙️ pi-voice ready", "info");
    }
  });

  // ── Input Interception (for interrupt) ─────────────────────────────

  pi.on("input", async (event, ctx) => {
    currentCtx = ctx;
    // If user types while TTS is speaking, interrupt (non-blocking to avoid fade delay)
    if (state.isSpeaking && event.source === "interactive") {
      void interruptTTS();
    }
    ensureConversationController().onUserInput();
    return { action: "continue" as const };
  });

  // ── Message Streaming (TTS reads responses) ────────────────────────

  pi.on("message_start", async (_event, ctx) => {
    currentCtx = ctx;
    agentStreaming = true;
    thinkingAnnounced = false;
    ensureTextProcessor().reset();
    lastResponseProcessed = "";
  });

  pi.on("message_update", async (event, _ctx) => {
    if (!shouldTTSBeActive() || !agentStreaming) return;

    const msgEvent = event.assistantMessageEvent;

    if (msgEvent.type === "text_delta") {
      const processor = ensureTextProcessor();
      const chunks = processor.processDelta(msgEvent.delta);

      // Queue chunks for TTS and accumulate processed text for "read again"
      for (const chunk of chunks) {
        if (chunk.text.trim()) {
          lastResponseProcessed += chunk.text + " ";
          enqueueSpeech(chunk.text);
        }
      }
    }

    if (msgEvent.type === "thinking_delta") {
      if (!thinkingAnnounced) {
        thinkingAnnounced = true;
        const processor = ensureTextProcessor();
        const chunk = processor.processThinkingStart();
        if (chunk) enqueueSpeech(chunk.text);
      }
    }
  });

  pi.on("message_end", async (_event, _ctx) => {
    agentStreaming = false;
    if (shouldTTSBeActive()) {
      const processor = ensureTextProcessor();
      const remaining = processor.flush();
      for (const chunk of remaining) {
        if (chunk.text.trim()) {
          await enqueueSpeech(chunk.text);
        }
      }
    }
  });

  // ── Tool Call Announcements ────────────────────────────────────────

  pi.on("tool_call", async (event, _ctx) => {
    if (!shouldTTSBeActive()) return;

    const processor = ensureTextProcessor();
    const chunk = processor.processToolCall(event.toolName, event.input as Record<string, unknown>);
    if (chunk) {
      enqueueSpeech(chunk.text);
    }
  });

  // ── Agent End ──────────────────────────────────────────────────────

  pi.on("agent_end", async (_event, _ctx) => {
    agentStreaming = false;
  });

  // ── Keyboard Handling ──────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Register keybinding handler via widget with input handling
    ctx.ui.setWidget("voice-keys", (_tui: any, _theme: any) => ({
      render: () => [],
      invalidate: () => {},
      handleInput: (data: string) => {
        // Alt+V — Toggle mic
        if (matchesKey(data, config.keybindings.toggleMic)) {
          if (state.isListening) {
            stopListening(ctx);
          } else {
            startListening(ctx);
          }
          return;
        }

        // Alt+M — Mute/unmute TTS
        if (matchesKey(data, config.keybindings.muteTTS)) {
          state.ttsMuted = !state.ttsMuted;
          if (state.ttsMuted && state.isSpeaking) {
            stopTTS();
          }
          updateStatus();
          statusBar?.flash(
            state.ttsMuted ? "🔇 TTS muted" : "🔊 TTS unmuted",
            state.ttsMuted ? "warning" : "success"
          );
          return;
        }

        // Alt+Space — Push-to-talk
        if (matchesKey(data, config.keybindings.pushToTalk)) {
          if (config.stt.mode === "push-to-talk") {
            if (state.isListening) {
              // This is the release — stop
              pushToTalkHeld = false;
              stopListening(ctx);
            } else if (!pushToTalkHeld) {
              // This is the press — start
              pushToTalkHeld = true;
              startListening(ctx);
            }
          } else {
            // In other modes, Alt+Space acts as toggle
            if (state.isListening) {
              stopListening(ctx);
            } else {
              startListening(ctx);
            }
          }
        }
      },
      wantsKeyRelease: true,
    }));
  });

  // ══════════════════════════════════════════════════════════════════════
  // COMMANDS
  // ══════════════════════════════════════════════════════════════════════

  pi.registerCommand("voice", {
    description:
      "Voice control — /voice [start|stop|mute|unmute|settings|setup|help|status|conversation|provider]",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const parts = (args ?? "").trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() || "status";

      switch (subcommand) {
        case "start":
          await startListening(ctx);
          break;

        case "stop":
          await stopListening(ctx);
          break;

        case "mute":
          state.ttsMuted = true;
          if (state.isSpeaking) stopTTS();
          updateStatus();
          ctx.ui.notify("🔇 TTS muted", "info");
          break;

        case "unmute":
          state.ttsMuted = false;
          updateStatus();
          ctx.ui.notify("🔊 TTS unmuted", "info");
          break;

        case "settings":
          if (!ctx?.hasUI) return;
          await showSettingsPanel(ctx, config, applyConfig);
          break;

        case "setup":
          if (!ctx?.hasUI) return;
          await runSetupWizard(ctx, (partial) => {
            // Deep merge: spread wizard's partial stt/tts over existing config
            const newConfig: VoiceConfig = {
              ...config,
              stt: { ...config.stt, ...(partial.stt ?? {}) },
              tts: { ...config.tts, ...(partial.tts ?? {}) },
              voiceCommands: { ...config.voiceCommands, ...(partial.voiceCommands ?? {}) },
              conversation: { ...config.conversation, ...(partial.conversation ?? {}) },
              keybindings: { ...config.keybindings, ...(partial.keybindings ?? {}) },
            };
            applyConfig(newConfig);
          });
          break;

        case "conversation":
        case "conv":
          toggleConversationMode(ctx);
          break;

        case "provider": {
          const type = parts[1]?.toLowerCase();
          const name = parts[2];

          if (type === "stt" && name) {
            const validSTT = getSTTProviders().some((p) => p.name === name);
            if (!validSTT) {
              ctx.ui.notify(`Unknown STT provider: ${name}. Use /voice status to see available providers.`, "error");
              break;
            }
            const updated = { ...config, stt: { ...config.stt, provider: name as any } };
            applyConfig(updated);
            ctx.ui.notify(`STT provider: ${name}`, "success");
          } else if (type === "tts" && name) {
            const validTTS = getTTSProviders().some((p) => p.name === name);
            if (!validTTS) {
              ctx.ui.notify(`Unknown TTS provider: ${name}. Use /voice status to see available providers.`, "error");
              break;
            }
            const updated = { ...config, tts: { ...config.tts, provider: name as any } };
            applyConfig(updated);
            ctx.ui.notify(`TTS provider: ${name}`, "success");
          } else {
            ctx.ui.notify(
              `Current: STT=${config.stt.provider}, TTS=${config.tts.provider}\n` +
                `Usage: /voice provider stt|tts <name>`,
              "info"
            );
          }
          break;
        }

        case "mode": {
          const mode = parts[1]?.toLowerCase();
          if (mode && ["push-to-talk", "toggle", "wake-word", "vad"].includes(mode)) {
            const updated = { ...config, stt: { ...config.stt, mode: mode as any } };
            applyConfig(updated);
            ctx.ui.notify(`STT mode: ${mode}`, "success");
          } else {
            ctx.ui.notify(
              `Current mode: ${config.stt.mode}\nOptions: push-to-talk, toggle, wake-word, vad`,
              "info"
            );
          }
          break;
        }

        case "trigger": {
          const trigger = parts[1]?.toLowerCase();
          if (trigger && ["always", "voice-mode", "manual"].includes(trigger)) {
            const updated = { ...config, tts: { ...config.tts, triggerMode: trigger as any } };
            applyConfig(updated);
            ctx.ui.notify(`TTS trigger: ${trigger}`, "success");
          } else {
            ctx.ui.notify(
              `Current trigger: ${config.tts.triggerMode}\nOptions: always, voice-mode, manual`,
              "info"
            );
          }
          break;
        }

        case "key": {
          const provider = parts[1];
          if (!provider) {
            ctx.ui.notify("Usage: /voice key <provider>\nProviders: deepgram, openai, azure, google, assemblyai, elevenlabs, cartesia", "info");
            break;
          }
          const key = await ctx.ui.input(`Enter API key for ${provider}:`);
          if (key) {
            setApiKey(provider, key);
            ctx.ui.notify(`API key set for ${provider}`, "success");
          }
          break;
        }

        case "help":
          if (!ctx?.hasUI) return;
          await showHelpOverlay(ctx, config);
          break;

        case "say": {
          const textToSpeak = parts.slice(1).join(" ");
          if (!textToSpeak.trim()) {
            ctx.ui.notify("Usage: /voice say <text>", "info");
            break;
          }
          await enqueueSpeech(textToSpeak);
          break;
        }

        case "status":
        default: {
          const sttProviders = getSTTProviders();
          const ttsProviders = getTTSProviders();
          const activeStt = sttProviders.find((p) => p.name === config.stt.provider);
          const activeTts = ttsProviders.find((p) => p.name === config.tts.provider);

          const lines = [
            `🎙️ pi-voice Status`,
            ``,
            `STT: ${activeStt?.displayName ?? config.stt.provider} (${config.stt.mode})`,
            `TTS: ${activeTts?.displayName ?? config.tts.provider} (${config.tts.triggerMode})`,
            `Voice: ${config.tts.voice}`,
            `Mic: ${state.isListening ? "🟢 Listening" : state.micActive ? "🟡 Ready" : "⚪ Off"}`,
            `TTS: ${state.isSpeaking ? "🟢 Speaking" : state.ttsMuted ? "🔇 Muted" : "⚪ Idle"}`,
            `Conversation: ${state.conversationMode ? "🟢 ON" : "⚪ OFF"}`,
            `Commands: ${config.voiceCommands.enabled ? `ON (${config.voiceCommands.tier})` : "OFF"}`,
            ``,
            `Keybindings:`,
            `  ${config.keybindings.toggleMic} — Toggle mic`,
            `  ${config.keybindings.muteTTS} — Mute/unmute TTS`,
            `  ${config.keybindings.pushToTalk} — Push-to-talk / toggle`,
            ``,
            `Commands: /voice [start|stop|mute|unmute|settings|setup|conversation|provider|mode|trigger|key|status]`,
          ];

          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }
      }
    },
  });

  // ── Cleanup on shutdown ────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    stopTTS();
    if (state.isListening) {
      await mic?.stop();
    }
    // Remove listeners before dispose (matching ensureSTT/ensureTTS pattern)
    if (sttProvider) {
      sttProvider.off("transcript", handleTranscript);
      sttProvider.off("error", handleSTTError);
    }
    if (ttsProvider) {
      ttsProvider.off("start", handleTTSStart);
      ttsProvider.off("end", handleTTSEnd);
      ttsProvider.off("audioChunk", handleTTSAudioChunk);
      ttsProvider.off("error", handleTTSError);
    }
    await sttProvider?.dispose();
    await ttsProvider?.dispose();
    mic?.dispose();
    speaker?.dispose();
    conversationCtrl?.dispose();
    statusBar?.clear();
  });
}
