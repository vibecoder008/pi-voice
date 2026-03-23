import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type {
  VoiceConfig,
  VoiceConfigFile,
  STTConfig,
  TTSConfig,
  VoiceCommandConfig,
  ConversationConfig,
  KeybindingConfig,
  STTProviderName,
  TTSProviderName,
  STTMode,
  TTSTriggerMode,
  VoiceCommandTier,
} from "./types.js";

// ─── Default Configuration ──────────────────────────────────────────────

const DEFAULT_STT: STTConfig = {
  provider: "deepgram",
  mode: "toggle",
  language: "en-US",
  wakeWord: "hey pi",
  autoSend: false,
  vadSilenceMs: 1500,
  interimResults: true,
  providerOptions: {},
};

const DEFAULT_TTS: TTSConfig = {
  provider: "edge-tts",
  triggerMode: "voice-mode",
  voice: "en-US-AriaNeural",
  speed: 1.0,
  codeBlockBehavior: "announce",
  toolCallBehavior: "announce",
  thinkingBehavior: "announce",
  interruptBehavior: "fade",
  fadeDurationMs: 500,
  providerOptions: {},
};

const DEFAULT_VOICE_COMMANDS: VoiceCommandConfig = {
  enabled: true,
  tier: "all",
  customCommands: {},
};

const DEFAULT_CONVERSATION: ConversationConfig = {
  enabled: false,
  autoListenAfterTTS: true,
  delayBeforeListenMs: 500,
};

const DEFAULT_KEYBINDINGS: KeybindingConfig = {
  toggleMic: "alt+v",
  muteTTS: "alt+m",
  pushToTalk: "alt+space",
};

export const DEFAULT_CONFIG: VoiceConfig = {
  stt: DEFAULT_STT,
  tts: DEFAULT_TTS,
  voiceCommands: DEFAULT_VOICE_COMMANDS,
  conversation: DEFAULT_CONVERSATION,
  keybindings: DEFAULT_KEYBINDINGS,
};

// ─── Config File Path ───────────────────────────────────────────────────

function getConfigPath(): string {
  return join(homedir(), ".pi", "voice.json");
}

// ─── Load / Save ────────────────────────────────────────────────────────

export function loadConfig(): VoiceConfig {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return {
      stt: { ...DEFAULT_STT, providerOptions: {} },
      tts: { ...DEFAULT_TTS, providerOptions: {} },
      voiceCommands: { ...DEFAULT_VOICE_COMMANDS, customCommands: {} },
      conversation: { ...DEFAULT_CONVERSATION },
      keybindings: { ...DEFAULT_KEYBINDINGS },
    };
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const file: Partial<VoiceConfigFile> = JSON.parse(raw);
    return mergeConfig(file);
  } catch {
    return {
      stt: { ...DEFAULT_STT, providerOptions: {} },
      tts: { ...DEFAULT_TTS, providerOptions: {} },
      voiceCommands: { ...DEFAULT_VOICE_COMMANDS, customCommands: {} },
      conversation: { ...DEFAULT_CONVERSATION },
      keybindings: { ...DEFAULT_KEYBINDINGS },
    };
  }
}

export function saveConfig(config: VoiceConfig): void {
  const configPath = getConfigPath();
  const dir = dirname(configPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const file: VoiceConfigFile = {
    version: 1,
    apiKeys: loadApiKeys(),
    stt: config.stt,
    tts: config.tts,
    voiceCommands: config.voiceCommands,
    conversation: config.conversation,
    keybindings: config.keybindings,
  };

  writeFileSync(configPath, JSON.stringify(file, null, 2), { encoding: "utf-8", mode: 0o600 });
}

// ─── API Key Management ─────────────────────────────────────────────────

export function loadApiKeys(): Record<string, string> {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) return {};

  try {
    const raw = readFileSync(configPath, "utf-8");
    const file: Partial<VoiceConfigFile> = JSON.parse(raw);
    return file.apiKeys ?? {};
  } catch {
    return {};
  }
}

export function getApiKey(provider: string): string | undefined {
  // 1. Check environment variables first
  const envMap: Record<string, string> = {
    deepgram: "DEEPGRAM_API_KEY",
    openai: "OPENAI_API_KEY",
    azure: "AZURE_SPEECH_KEY",
    "azure-region": "AZURE_SPEECH_REGION",
    google: "GOOGLE_APPLICATION_CREDENTIALS",
    assemblyai: "ASSEMBLYAI_API_KEY",
    elevenlabs: "ELEVENLABS_API_KEY",
    cartesia: "CARTESIA_API_KEY",
  };

  const envKey = envMap[provider];
  if (envKey && process.env[envKey]) {
    return process.env[envKey];
  }

  // 2. Check config file
  const keys = loadApiKeys();
  return keys[provider];
}

export function setApiKey(provider: string, key: string): void {
  const currentConfig = loadConfig();
  const configPath = getConfigPath();
  const dir = dirname(configPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const file: VoiceConfigFile = {
    version: 1,
    apiKeys: { ...loadApiKeys(), [provider]: key },
    stt: currentConfig.stt,
    tts: currentConfig.tts,
    voiceCommands: currentConfig.voiceCommands,
    conversation: currentConfig.conversation,
    keybindings: currentConfig.keybindings,
  };

  writeFileSync(configPath, JSON.stringify(file, null, 2), { encoding: "utf-8", mode: 0o600 });
}

// ─── Provider Availability ──────────────────────────────────────────────

export interface ProviderInfo {
  name: string;
  displayName: string;
  requiresApiKey: boolean;
  hasApiKey: boolean;
  isAvailable: boolean;
  description: string;
}

export function getSTTProviders(): ProviderInfo[] {
  return [
    { name: "deepgram", displayName: "Deepgram Nova-3", requiresApiKey: true, hasApiKey: !!getApiKey("deepgram"), isAvailable: !!getApiKey("deepgram"), description: "Best real-time streaming ($0.008/min)" },
    { name: "openai", displayName: "OpenAI Whisper", requiresApiKey: true, hasApiKey: !!getApiKey("openai"), isAvailable: !!getApiKey("openai"), description: "Batch transcription ($0.003/min)" },
    { name: "azure", displayName: "Azure Speech", requiresApiKey: true, hasApiKey: !!getApiKey("azure"), isAvailable: !!getApiKey("azure"), description: "Built-in mic capture ($0.017/min)" },
    { name: "google", displayName: "Google Cloud STT", requiresApiKey: true, hasApiKey: !!getApiKey("google"), isAvailable: !!getApiKey("google"), description: "125+ languages ($0.016/min)" },
    { name: "assemblyai", displayName: "AssemblyAI", requiresApiKey: true, hasApiKey: !!getApiKey("assemblyai"), isAvailable: !!getApiKey("assemblyai"), description: "Cheapest streaming ($0.003/min)" },
    { name: "elevenlabs", displayName: "ElevenLabs Scribe", requiresApiKey: true, hasApiKey: !!getApiKey("elevenlabs"), isAvailable: !!getApiKey("elevenlabs"), description: "Lowest latency (150ms)" },
    { name: "whisper-local", displayName: "Whisper Local", requiresApiKey: false, hasApiKey: true, isAvailable: true, description: "Free, offline, private" },
  ];
}

export function getTTSProviders(): ProviderInfo[] {
  return [
    { name: "edge-tts", displayName: "Edge TTS (Free)", requiresApiKey: false, hasApiKey: true, isAvailable: true, description: "Free, no API key, good quality" },
    { name: "openai", displayName: "OpenAI TTS", requiresApiKey: true, hasApiKey: !!getApiKey("openai"), isAvailable: !!getApiKey("openai"), description: "High quality ($15/1M chars)" },
    { name: "elevenlabs", displayName: "ElevenLabs", requiresApiKey: true, hasApiKey: !!getApiKey("elevenlabs"), isAvailable: !!getApiKey("elevenlabs"), description: "Premium voices ($120/1M chars)" },
    { name: "cartesia", displayName: "Cartesia Sonic", requiresApiKey: true, hasApiKey: !!getApiKey("cartesia"), isAvailable: !!getApiKey("cartesia"), description: "Best balance ($11/1M chars, 40ms)" },
    { name: "google", displayName: "Google Cloud TTS", requiresApiKey: true, hasApiKey: !!getApiKey("google"), isAvailable: !!getApiKey("google"), description: "WaveNet voices ($4/1M chars)" },
    { name: "azure", displayName: "Azure TTS", requiresApiKey: true, hasApiKey: !!getApiKey("azure"), isAvailable: !!getApiKey("azure"), description: "Neural voices ($16/1M chars)" },
    { name: "deepgram", displayName: "Deepgram Aura", requiresApiKey: true, hasApiKey: !!getApiKey("deepgram"), isAvailable: !!getApiKey("deepgram"), description: "Fast TTS ($15/1M chars)" },
    { name: "piper", displayName: "Piper (Local)", requiresApiKey: false, hasApiKey: true, isAvailable: true, description: "Free, offline, neural quality" },
    { name: "system", displayName: "System TTS", requiresApiKey: false, hasApiKey: true, isAvailable: true, description: "OS built-in (say/espeak)" },
  ];
}

// ─── Provider Validation ────────────────────────────────────────────────

const VALID_STT_PROVIDERS = new Set<string>(["deepgram","openai","azure","google","assemblyai","elevenlabs","whisper-local"]);
const VALID_TTS_PROVIDERS = new Set<string>(["openai","elevenlabs","cartesia","google","azure","deepgram","edge-tts","piper","system"]);

export function isValidSTTProvider(name: string): boolean {
  return VALID_STT_PROVIDERS.has(name);
}
export function isValidTTSProvider(name: string): boolean {
  return VALID_TTS_PROVIDERS.has(name);
}

// ─── Merge Helper ───────────────────────────────────────────────────────

function mergeConfig(file: Partial<VoiceConfigFile>): VoiceConfig {
  return {
    stt: {
      ...DEFAULT_STT,
      ...(file.stt ?? {}),
      provider: isValidSTTProvider(file.stt?.provider ?? "")
        ? (file.stt!.provider as STTProviderName)
        : DEFAULT_STT.provider,
      mode: (["push-to-talk", "toggle", "wake-word", "vad"] as const).includes(file.stt?.mode as any)
        ? (file.stt!.mode as STTMode)
        : DEFAULT_STT.mode,
      providerOptions: { ...(file.stt?.providerOptions ?? {}) },
    },
    tts: {
      ...DEFAULT_TTS,
      ...(file.tts ?? {}),
      provider: isValidTTSProvider(file.tts?.provider ?? "")
        ? (file.tts!.provider as TTSProviderName)
        : DEFAULT_TTS.provider,
      triggerMode: (["always", "voice-mode", "manual"] as const).includes(file.tts?.triggerMode as any)
        ? (file.tts!.triggerMode as TTSTriggerMode)
        : DEFAULT_TTS.triggerMode,
      providerOptions: { ...(file.tts?.providerOptions ?? {}) },
    },
    voiceCommands: {
      ...DEFAULT_VOICE_COMMANDS,
      ...(file.voiceCommands ?? {}),
      tier: (["basic", "pi-commands", "navigation", "all"] as const).includes(file.voiceCommands?.tier as any)
        ? (file.voiceCommands!.tier as VoiceCommandTier)
        : DEFAULT_VOICE_COMMANDS.tier,
      customCommands: { ...(file.voiceCommands?.customCommands ?? {}) },
    },
    conversation: { ...DEFAULT_CONVERSATION, ...(file.conversation ?? {}) },
    keybindings: { ...DEFAULT_KEYBINDINGS, ...(file.keybindings ?? {}) },
  };
}
