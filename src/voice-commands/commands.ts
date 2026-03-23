import type { VoiceCommand, VoiceCommandTier } from "../types.js";

// ─── Basic Tier ─────────────────────────────────────────────────────────
// Punctuation, formatting, and core dictation controls.

/** Punctuation commands — applied inline during dictation. */
const punctuationCommands: VoiceCommand[] = [
  {
    pattern: /\b(?:period|full\s+stop)\b/i,
    phrases: ["period", "full stop"],
    action: { type: "punctuation", char: "." },
    tier: "basic",
    description: "Insert a period",
  },
  {
    pattern: /\bcomma\b/i,
    phrases: ["comma"],
    action: { type: "punctuation", char: "," },
    tier: "basic",
    description: "Insert a comma",
  },
  {
    pattern: /\b(?:question\s+mark)\b/i,
    phrases: ["question mark"],
    action: { type: "punctuation", char: "?" },
    tier: "basic",
    description: "Insert a question mark",
  },
  {
    pattern: /\b(?:exclamation\s+(?:mark|point))\b/i,
    phrases: ["exclamation mark", "exclamation point"],
    action: { type: "punctuation", char: "!" },
    tier: "basic",
    description: "Insert an exclamation mark",
  },
  {
    pattern: /\bcolon\b/i,
    phrases: ["colon"],
    action: { type: "punctuation", char: ":" },
    tier: "basic",
    description: "Insert a colon",
  },
  {
    pattern: /\bsemicolon\b/i,
    phrases: ["semicolon"],
    action: { type: "punctuation", char: ";" },
    tier: "basic",
    description: "Insert a semicolon",
  },
  {
    pattern: /\b(?:hyphen|dash)\b/i,
    phrases: ["hyphen", "dash"],
    action: { type: "punctuation", char: "-" },
    tier: "basic",
    description: "Insert a hyphen",
  },
];

/** Quote and bracket insertion commands. */
const insertionCommands: VoiceCommand[] = [
  {
    pattern: /\b(?:open\s+quote|quote)\b/i,
    phrases: ["open quote", "quote"],
    action: { type: "insert", text: '"' },
    tier: "basic",
    description: 'Insert an opening double quote',
  },
  {
    pattern: /\b(?:close\s+quote|end\s+quote)\b/i,
    phrases: ["close quote", "end quote"],
    action: { type: "insert", text: '"' },
    tier: "basic",
    description: 'Insert a closing double quote',
  },
  {
    pattern: /\b(?:open\s+(?:parenthesis|paren))\b/i,
    phrases: ["open parenthesis", "open paren"],
    action: { type: "insert", text: "(" },
    tier: "basic",
    description: "Insert an opening parenthesis",
  },
  {
    pattern: /\b(?:close\s+(?:parenthesis|paren))\b/i,
    phrases: ["close parenthesis", "close paren"],
    action: { type: "insert", text: ")" },
    tier: "basic",
    description: "Insert a closing parenthesis",
  },
];

/** Formatting commands — newline and paragraph breaks. */
const formattingCommands: VoiceCommand[] = [
  {
    pattern: /\b(?:new\s+line|newline)\b/i,
    phrases: ["new line", "newline"],
    action: { type: "newline" },
    tier: "basic",
    description: "Insert a line break",
  },
  {
    pattern: /\bnew\s+paragraph\b/i,
    phrases: ["new paragraph"],
    action: { type: "insert", text: "\n\n" },
    tier: "basic",
    description: "Insert a paragraph break (two newlines)",
  },
];

/** Core action commands — submit, cancel, clear, undo, selection, deletion. */
const coreActionCommands: VoiceCommand[] = [
  {
    pattern: /\b(?:send\s+it|submit|go|enter)\b/i,
    phrases: ["send it", "submit", "go", "enter"],
    action: { type: "submit" },
    tier: "basic",
    description: "Submit the current input",
  },
  {
    pattern: /\b(?:cancel|never\s+mind|abort)\b/i,
    phrases: ["cancel", "never mind", "abort"],
    action: { type: "cancel" },
    tier: "basic",
    description: "Cancel the current input",
  },
  {
    pattern: /\b(?:clear\s+all|clear|delete\s+all)\b/i,
    phrases: ["clear", "clear all", "delete all"],
    action: { type: "clear" },
    tier: "basic",
    description: "Clear all text in the input",
  },
  {
    pattern: /\b(?:undo\s+that|undo)\b/i,
    phrases: ["undo", "undo that"],
    action: { type: "undo" },
    tier: "basic",
    description: "Undo the last action",
  },
  {
    pattern: /\bselect\s+all\b/i,
    phrases: ["select all"],
    action: { type: "select-all" },
    tier: "basic",
    description: "Select all text in the input",
  },
  {
    pattern: /\b(?:delete\s+word|backspace\s+word)\b/i,
    phrases: ["delete word", "backspace word"],
    action: { type: "delete-word" },
    tier: "basic",
    description: "Delete the previous word",
  },
];

// ─── Pi-Commands Tier ───────────────────────────────────────────────────
// Commands that interact with pi slash-commands and model switching.

/** Dynamic slash-command invocation — extracts the command name from speech. */
const slashCommands: VoiceCommand[] = [
  {
    pattern: /\b(?:run\s+slash|slash)\s+(\S+(?:\s+.+)?)\s*$/i,
    phrases: ["run slash {command}", "slash {command}"],
    action: { type: "pi-command", command: "" },
    tier: "pi-commands",
    description: "Run an arbitrary pi slash command",
  },
  {
    pattern: /\b(?:run\s+compact|compact)\b/i,
    phrases: ["run compact", "compact"],
    action: { type: "pi-command", command: "compact" },
    tier: "pi-commands",
    description: "Run /compact to summarize conversation",
  },
  {
    pattern: /\b(?:run\s+reload|reload)\b/i,
    phrases: ["run reload", "reload"],
    action: { type: "pi-command", command: "reload" },
    tier: "pi-commands",
    description: "Run /reload to reload extensions",
  },
  {
    pattern: /\bnew\s+session\b/i,
    phrases: ["new session"],
    action: { type: "pi-command", command: "new" },
    tier: "pi-commands",
    description: "Start a new session",
  },
];

/** Model switching and settings commands. */
const modelAndSettingsCommands: VoiceCommand[] = [
  {
    pattern: /\b(?:switch\s+model\s+to|use)\s+(.+)\s*$/i,
    phrases: ["switch model to {model}", "use {model}"],
    action: { type: "set-model", model: "" },
    tier: "pi-commands",
    description: "Switch to a different model",
  },
  {
    pattern: /\b(?:open\s+settings|voice\s+settings)\b/i,
    phrases: ["open settings", "voice settings"],
    action: { type: "pi-command", command: "voice", args: "settings" },
    tier: "pi-commands",
    description: "Open voice extension settings",
  },
  {
    pattern: /\b(?:toggle\s+voice|voice\s+mode)\b/i,
    phrases: ["toggle voice", "voice mode"],
    action: { type: "toggle-voice-mode" },
    tier: "pi-commands",
    description: "Toggle voice input mode on or off",
  },
];

// ─── Navigation Tier ────────────────────────────────────────────────────
// Scrolling and TTS playback controls.

/** Scroll and TTS playback commands. */
const navigationCommands: VoiceCommand[] = [
  {
    pattern: /\b(?:scroll\s+up|page\s+up)\b/i,
    phrases: ["scroll up", "page up"],
    action: { type: "scroll", direction: "up" },
    tier: "navigation",
    description: "Scroll the output up",
  },
  {
    pattern: /\b(?:scroll\s+down|page\s+down)\b/i,
    phrases: ["scroll down", "page down"],
    action: { type: "scroll", direction: "down" },
    tier: "navigation",
    description: "Scroll the output down",
  },
  {
    pattern: /\b(?:read\s+again|repeat|say\s+that\s+again)\b/i,
    phrases: ["read again", "repeat", "say that again"],
    action: { type: "read-again" },
    tier: "navigation",
    description: "Re-read the last response",
  },
  {
    pattern: /\b(?:stop\s+reading|shut\s+up|silence|mute)\b/i,
    phrases: ["stop reading", "shut up", "silence", "mute"],
    action: { type: "stop-reading" },
    tier: "navigation",
    description: "Stop text-to-speech playback",
  },
];

// ─── Aggregated Command Lists ───────────────────────────────────────────

/** All basic-tier commands (punctuation, insertion, formatting, core actions). */
export const BASIC_COMMANDS: VoiceCommand[] = [
  ...punctuationCommands,
  ...insertionCommands,
  ...formattingCommands,
  ...coreActionCommands,
];

/** All pi-commands-tier commands (slash commands, model/settings). */
export const PI_COMMANDS: VoiceCommand[] = [
  ...slashCommands,
  ...modelAndSettingsCommands,
];

/** All navigation-tier commands (scroll, TTS playback). */
export const NAVIGATION_COMMANDS: VoiceCommand[] = [...navigationCommands];

/** Every registered voice command across all tiers. */
export const ALL_COMMANDS: VoiceCommand[] = [
  ...BASIC_COMMANDS,
  ...PI_COMMANDS,
  ...NAVIGATION_COMMANDS,
];

// ─── Inline vs. Trailing Classification ─────────────────────────────────

/**
 * Commands that are applied inline within the text flow (punctuation,
 * insertion, formatting). These transform the dictated text rather than
 * triggering a discrete action.
 */
export const INLINE_COMMAND_TYPES = new Set<string>([
  "punctuation",
  "insert",
  "newline",
]);

/**
 * Commands treated as discrete actions — checked at the end of an utterance
 * or when the entire utterance is a single command.
 */
export const ACTION_COMMAND_TYPES = new Set<string>([
  "submit",
  "cancel",
  "clear",
  "undo",
  "select-all",
  "delete-word",
  "pi-command",
  "set-model",
  "scroll",
  "read-again",
  "stop-reading",
  "toggle-voice-mode",
]);

// ─── Tier Helpers ───────────────────────────────────────────────────────

/** Tier inclusion hierarchy — each tier includes all lower tiers. */
const TIER_HIERARCHY: Record<VoiceCommandTier, VoiceCommandTier[]> = {
  basic: ["basic"],
  "pi-commands": ["basic", "pi-commands"],
  navigation: ["basic", "pi-commands", "navigation"],
  all: ["basic", "pi-commands", "navigation"],
};

/**
 * Return commands available at the given tier level.
 * Higher tiers include all commands from lower tiers.
 */
export function getCommandsForTier(tier: VoiceCommandTier): VoiceCommand[] {
  const includedTiers = new Set(TIER_HIERARCHY[tier]);
  return ALL_COMMANDS.filter((cmd) => includedTiers.has(cmd.tier));
}
