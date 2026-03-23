import type {
  VoiceCommand,
  VoiceCommandAction,
  VoiceCommandConfig,
  VoiceCommandResult,
} from "../types.js";
import {
  ACTION_COMMAND_TYPES,
  getCommandsForTier,
  INLINE_COMMAND_TYPES,
} from "./commands.js";

/**
 * Parses transcribed speech text to detect and extract voice commands.
 *
 * Commands fall into two categories:
 * - **Inline** (punctuation, insertion, formatting) — applied within the text
 *   flow so "hello period how are you" becomes "hello. how are you".
 * - **Action** (submit, cancel, slash-commands, etc.) — checked at the end of
 *   the utterance or when the whole utterance is a single command.
 *
 * The parser respects the configured tier, only matching commands the user has
 * enabled. Custom commands from the config are merged on top of the defaults.
 */
export class VoiceCommandParser {
  private config: VoiceCommandConfig;
  private commands: VoiceCommand[];
  private customCommands: VoiceCommand[];

  constructor(config: VoiceCommandConfig) {
    this.config = config;
    this.customCommands = this.buildCustomCommands(config.customCommands);
    this.commands = this.resolveActiveCommands();
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Parse transcribed text and extract any voice commands.
   *
   * Strategy:
   * 1. Try an exact match first (entire utterance is a command).
   * 2. Try a trailing match (command at the end, text before it).
   * 3. If no action command matched, apply inline commands to the full text
   *    and return it as remaining text.
   */
  parse(text: string): VoiceCommandResult {
    if (!this.config.enabled || !text.trim()) {
      return { matched: false, remainingText: text };
    }

    const normalized = text.trim();

    // Whole utterance is a command
    const exact = this.parseExact(normalized);
    if (exact.matched) {
      return exact;
    }

    // Command at the end of the utterance
    const trailing = this.parseTrailing(normalized);
    if (trailing.matched) {
      return trailing;
    }

    // No action command — apply inline punctuation/formatting and return text
    const processed = this.applyInlineCommands(normalized);
    return { matched: false, remainingText: processed };
  }

  /**
   * Check if the entire utterance is exactly one command.
   * Returns the matched command with no remaining text.
   */
  parseExact(text: string): VoiceCommandResult {
    const normalized = text.trim();
    const actionCommands = this.getActionCommands();

    for (const cmd of actionCommands) {
      const match = normalized.match(cmd.pattern);
      if (match && match[0].length === normalized.length) {
        const action = this.resolveAction(cmd, match);
        return { matched: true, command: cmd, action };
      }
    }

    return { matched: false, remainingText: text };
  }

  /**
   * Check if text ends with an action command.
   * Returns the command plus any preceding text (with inline commands applied)
   * as `remainingText`.
   */
  parseTrailing(text: string): VoiceCommandResult {
    const normalized = text.trim();
    const actionCommands = this.getActionCommands();

    // Try each action command, preferring the match closest to the end
    let bestMatch: {
      command: VoiceCommand;
      action: VoiceCommandAction;
      remaining: string;
      matchIndex: number;
    } | null = null;

    for (const cmd of actionCommands) {
      // Build a version of the pattern anchored to the end
      const trailingPattern = new RegExp(
        cmd.pattern.source + "\\s*$",
        cmd.pattern.flags
      );
      const match = normalized.match(trailingPattern);

      if (match && match.index !== undefined) {
        const remaining = normalized.slice(0, match.index).trim();

        // Prefer the match that starts latest (closest to end), so we
        // capture the maximum amount of preceding text as dictation.
        if (!bestMatch || match.index > bestMatch.matchIndex) {
          const action = this.resolveAction(cmd, match);
          bestMatch = { command: cmd, action, remaining, matchIndex: match.index };
        }
      }
    }

    if (bestMatch) {
      const result: VoiceCommandResult = {
        matched: true,
        command: bestMatch.command,
        action: bestMatch.action,
      };
      if (bestMatch.remaining) {
        result.remainingText = this.applyInlineCommands(bestMatch.remaining);
      }
      return result;
    }

    return { matched: false, remainingText: text };
  }

  /**
   * Apply inline punctuation and formatting commands within the text.
   *
   * Walks through the text and replaces command phrases with their
   * corresponding characters. Handles whitespace around punctuation so
   * "hello period how are you question mark" becomes "hello. how are you?"
   */
  applyInlineCommands(text: string): string {
    const inlineCommands = this.getInlineCommands();
    let result = text;

    for (const cmd of inlineCommands) {
      result = result.replace(
        new RegExp(cmd.pattern.source, "gi"),
        (_match: string) => {
          if (cmd.action.type === "punctuation") {
            return cmd.action.char;
          }
          if (cmd.action.type === "insert") {
            return cmd.action.text;
          }
          if (cmd.action.type === "newline") {
            return "\n";
          }
          return _match;
        }
      );
    }

    // Clean up whitespace around punctuation: remove space before punctuation,
    // ensure single space after (unless end of string or next char is a quote/paren).
    result = result.replace(/\s+([.,?!:;\-])/g, "$1");
    result = result.replace(/([.,?!:;])(?=[A-Za-z])/g, "$1 ");

    // Clean up whitespace around quotes and parens
    result = result.replace(/"\s+/g, '"');
    result = result.replace(/\s+"/g, '"');
    result = result.replace(/\(\s+/g, "(");
    result = result.replace(/\s+\)/g, ")");

    // Collapse multiple spaces
    result = result.replace(/ {2,}/g, " ");

    return result.trim();
  }

  /** Return all commands available at the current tier. */
  getAvailableCommands(): VoiceCommand[] {
    return [...this.commands];
  }

  /** Update the parser configuration and rebuild the active command set. */
  updateConfig(config: VoiceCommandConfig): void {
    this.config = config;
    this.customCommands = this.buildCustomCommands(config.customCommands);
    this.commands = this.resolveActiveCommands();
  }

  // ─── Internals ──────────────────────────────────────────────────────

  /**
   * Resolve the final action for a command, filling in dynamic values
   * extracted from regex capture groups.
   */
  private resolveAction(
    cmd: VoiceCommand,
    match: RegExpMatchArray
  ): VoiceCommandAction {
    const action = cmd.action;

    // Dynamic slash-command: extract command (and optional args) from capture group
    if (action.type === "pi-command" && action.command === "" && match[1]) {
      const parts = match[1].trim().split(/\s+/);
      const command = parts[0];
      if (parts.length > 1) {
        return { type: "pi-command", command, args: parts.slice(1).join(" ") };
      }
      return { type: "pi-command", command };
    }

    // Dynamic model selection: extract model name from capture group
    if (action.type === "set-model" && action.model === "" && match[1]) {
      return { type: "set-model", model: match[1].trim() };
    }

    return action;
  }

  /** Filter active commands to only inline types (punctuation, insert, newline). */
  private getInlineCommands(): VoiceCommand[] {
    return this.commands.filter((cmd) =>
      INLINE_COMMAND_TYPES.has(cmd.action.type)
    );
  }

  /** Filter active commands to only action types (submit, cancel, etc.). */
  private getActionCommands(): VoiceCommand[] {
    return this.commands.filter((cmd) =>
      ACTION_COMMAND_TYPES.has(cmd.action.type)
    );
  }

  /**
   * Build the active command list by merging tier-filtered defaults
   * with custom commands. Custom commands override defaults that share
   * the same phrases.
   */
  private resolveActiveCommands(): VoiceCommand[] {
    const tierCommands = getCommandsForTier(this.config.tier);

    if (this.customCommands.length === 0) {
      return tierCommands;
    }

    // Collect phrases from custom commands so we can suppress matching defaults
    const customPhraseSet = new Set<string>();
    for (const custom of this.customCommands) {
      for (const phrase of custom.phrases) {
        customPhraseSet.add(phrase.toLowerCase());
      }
    }

    const filtered = tierCommands.filter(
      (cmd) =>
        !cmd.phrases.some((p) => customPhraseSet.has(p.toLowerCase()))
    );

    return [...filtered, ...this.customCommands];
  }

  /**
   * Convert the `customCommands` config map into VoiceCommand objects.
   *
   * The map is keyed by trigger phrase and valued by an action shorthand:
   * - `"submit"`, `"cancel"`, `"clear"`, etc. → corresponding action
   * - `"/compact"` → pi-command "compact"
   * - `"model:sonnet"` → set-model "sonnet"
   * - Anything else → insert the value as literal text
   */
  private buildCustomCommands(
    map: Record<string, string>
  ): VoiceCommand[] {
    const commands: VoiceCommand[] = [];

    for (const [phrase, value] of Object.entries(map)) {
      const action = this.parseCustomAction(value);
      if (!action) continue;

      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      commands.push({
        pattern: new RegExp(`\\b${escaped}\\b`, "i"),
        phrases: [phrase],
        action,
        tier: this.config.tier,
        description: `Custom command: "${phrase}"`,
      });
    }

    return commands;
  }

  /** Parse a custom command action shorthand string into a VoiceCommandAction. */
  private parseCustomAction(value: string): VoiceCommandAction | null {
    const trimmed = value.trim();

    // Simple action keywords
    const simpleActions: Record<string, VoiceCommandAction> = {
      submit: { type: "submit" },
      cancel: { type: "cancel" },
      clear: { type: "clear" },
      undo: { type: "undo" },
      newline: { type: "newline" },
      "select-all": { type: "select-all" },
      "delete-word": { type: "delete-word" },
      "read-again": { type: "read-again" },
      "stop-reading": { type: "stop-reading" },
      "toggle-voice-mode": { type: "toggle-voice-mode" },
      "scroll-up": { type: "scroll", direction: "up" },
      "scroll-down": { type: "scroll", direction: "down" },
    };

    if (simpleActions[trimmed]) {
      return simpleActions[trimmed];
    }

    // Slash-command shorthand: "/compact", "/reload args"
    if (trimmed.startsWith("/")) {
      const parts = trimmed.slice(1).split(/\s+/);
      const command = parts[0];
      if (parts.length > 1) {
        return { type: "pi-command", command, args: parts.slice(1).join(" ") };
      }
      return { type: "pi-command", command };
    }

    // Model shorthand: "model:sonnet"
    if (trimmed.startsWith("model:")) {
      const model = trimmed.slice(6).trim();
      return model ? { type: "set-model", model } : null;
    }

    // Punctuation shorthand: "punct:."
    if (trimmed.startsWith("punct:")) {
      const char = trimmed.slice(6);
      return char ? { type: "punctuation", char } : null;
    }

    // Fallback: insert the value as literal text
    return { type: "insert", text: trimmed };
  }
}
