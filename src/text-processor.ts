/**
 * Text Processor — sits between raw agent output and TTS.
 * Handles code block filtering, markdown cleanup, sentence buffering,
 * tool call announcements, and thinking markers.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface TextProcessorConfig {
  codeBlockBehavior: "skip" | "announce" | "read";
  toolCallBehavior: "skip" | "announce" | "announce-and-summarize";
  thinkingBehavior: "skip" | "announce" | "read";
}

export interface TextChunk {
  text: string;
  type: "prose" | "code-announcement" | "tool-announcement" | "thinking-announcement";
}

// ─── Sentence boundary regex ────────────────────────────────────────────

const SENTENCE_BOUNDARY = /([.!?:;])\s+/;
const PARAGRAPH_BOUNDARY = /\n\n+/;

// ─── Markdown cleanup patterns ──────────────────────────────────────────

const MD_BOLD = /\*\*(.+?)\*\*/g;
const MD_ITALIC = /\*(.+?)\*/g;
const MD_BOLD_UNDER = /__(.+?)__/g;
const MD_ITALIC_UNDER = /_(.+?)_/g;
const MD_STRIKETHROUGH = /~~(.+?)~~/g;
const MD_IMAGE = /!\[([^\]]*)\]\([^)]+\)/g;
const MD_LINK = /\[([^\]]+)\]\([^)]+\)/g;
const MD_INLINE_CODE = /`([^`]+)`/g;
const MD_HEADING = /^#{1,6}\s+(.+)$/gm;
const MD_UNORDERED_LIST = /^[\s]*[-*+]\s+/gm;
const MD_ORDERED_LIST = /^[\s]*\d+\.\s+/gm;
const MD_BLOCKQUOTE = /^>\s*/gm;
const MD_HR = /^[-*_]{3,}\s*$/gm;
const MD_HTML_TAG = /<[^>]+>/g;
const MD_MULTIPLE_NEWLINES = /\n{3,}/g;
const MD_MULTIPLE_SPACES = / {2,}/g;

// ─── TextProcessor ──────────────────────────────────────────────────────

export class TextProcessor {
  private config: TextProcessorConfig;
  private buffer = "";
  private inCodeBlock = false;
  private codeBlockLang = "";
  private codeBlockLineCount = 0;
  private codeBlockPartialMarker = "";
  private static readonly MAX_BUFFER_SIZE = 50000;

  constructor(config: TextProcessorConfig) {
    this.config = config;
  }

  // ─── Streaming delta processing ─────────────────────────────────────

  /**
   * Process a streaming text delta from the agent.
   * Accumulates text and yields sentence-sized chunks ready for TTS.
   */
  processDelta(delta: string): TextChunk[] {
    if (!delta) return [];

    // Prepend any partial backtick marker from the previous delta
    if (this.codeBlockPartialMarker) {
      delta = this.codeBlockPartialMarker + delta;
      this.codeBlockPartialMarker = "";
    }

    const chunks: TextChunk[] = [];
    this.buffer += delta;

    // Handle code block transitions
    this.processCodeBlockTransitions(chunks);

    // If inside code block, handle based on config
    if (this.inCodeBlock) {
      if (this.config.codeBlockBehavior === "read") {
        // Count lines for potential future use
        this.codeBlockLineCount += (delta.match(/\n/g) || []).length;
        // Don't buffer code block text — it will be flushed inline
      } else {
        // skip or announce — count lines, discard text
        this.codeBlockLineCount += (delta.match(/\n/g) || []).length;
        return chunks;
      }
    }

    // Extract complete sentences from buffer
    this.extractSentences(chunks);

    // Flush if buffer exceeds maximum size
    if (this.buffer.length > TextProcessor.MAX_BUFFER_SIZE) {
      chunks.push(...this.flush());
    }

    return chunks;
  }

  /**
   * Flush any remaining buffered text (call at message_end).
   */
  flush(): TextChunk[] {
    const chunks: TextChunk[] = [];

    // Close any open code block
    if (this.inCodeBlock) {
      if (this.config.codeBlockBehavior === "announce") {
        const lang = this.codeBlockLang ? ` of ${this.codeBlockLang}` : "";
        chunks.push({
          text: `End of code block, ${this.codeBlockLineCount} lines${lang}.`,
          type: "code-announcement",
        });
      }
      this.inCodeBlock = false;
    }

    // Flush remaining buffer
    if (this.buffer.trim()) {
      const cleaned = this.cleanMarkdown(this.buffer.trim());
      if (cleaned) {
        chunks.push({ text: cleaned, type: "prose" });
      }
    }

    this.buffer = "";
    return chunks;
  }

  // ─── Tool call processing ───────────────────────────────────────────

  /**
   * Process a tool call announcement.
   * Returns text to speak, or null if tool calls should be skipped.
   */
  processToolCall(toolName: string, toolInput: Record<string, unknown>): TextChunk | null {
    if (this.config.toolCallBehavior === "skip") return null;

    const announcement = this.formatToolAnnouncement(toolName, toolInput);
    return { text: announcement, type: "tool-announcement" };
  }

  // ─── Thinking processing ────────────────────────────────────────────

  /** Process thinking start. */
  processThinkingStart(): TextChunk | null {
    if (this.config.thinkingBehavior === "skip") return null;
    return { text: "Pi is thinking...", type: "thinking-announcement" };
  }

  /** Process thinking end. */
  processThinkingEnd(): TextChunk | null {
    // No announcement on thinking end — the response follows naturally
    return null;
  }

  // ─── State management ───────────────────────────────────────────────

  /** Reset internal state for a new response. */
  reset(): void {
    this.buffer = "";
    this.inCodeBlock = false;
    this.codeBlockLang = "";
    this.codeBlockLineCount = 0;
    this.codeBlockPartialMarker = "";
  }

  /** Update config. */
  updateConfig(config: TextProcessorConfig): void {
    this.config = config;
  }

  // ─── Private: Code block detection ──────────────────────────────────

  private processCodeBlockTransitions(chunks: TextChunk[]): void {
    // Look for ``` markers in buffer
    let searchFrom = 0;

    while (searchFrom < this.buffer.length) {
      const markerIdx = this.buffer.indexOf("```", searchFrom);
      if (markerIdx === -1) break;

      if (!this.inCodeBlock) {
        // Opening code block
        // Extract any text before the marker as prose
        const beforeMarker = this.buffer.slice(0, markerIdx).trim();
        if (beforeMarker) {
          const cleaned = this.cleanMarkdown(beforeMarker);
          if (cleaned) {
            chunks.push({ text: cleaned, type: "prose" });
          }
        }

        // Parse language tag (everything after ``` until newline)
        const afterMarker = this.buffer.slice(markerIdx + 3);
        const newlineIdx = afterMarker.indexOf("\n");
        if (newlineIdx === -1) {
          // Haven't received the full opening line yet — wait for more data
          this.buffer = this.buffer.slice(markerIdx);
          return;
        }

        this.codeBlockLang = afterMarker.slice(0, newlineIdx).trim();
        this.codeBlockLineCount = 0;
        this.inCodeBlock = true;

        if (this.config.codeBlockBehavior === "announce") {
          const lang = this.codeBlockLang ? ` in ${this.codeBlockLang}` : "";
          chunks.push({ text: `Code block${lang}.`, type: "code-announcement" });
        }

        // Advance buffer past the opening marker + language + newline
        this.buffer = afterMarker.slice(newlineIdx + 1);
        searchFrom = 0;
      } else {
        // Closing code block
        if (this.config.codeBlockBehavior === "read") {
          const codeContent = this.buffer.slice(0, markerIdx).trim();
          if (codeContent) {
            chunks.push({ text: codeContent, type: "prose" });
          }
        }

        this.inCodeBlock = false;

        // Advance past closing marker
        const afterClose = this.buffer.slice(markerIdx + 3);
        // Skip any trailing newline after closing ```
        this.buffer = afterClose.startsWith("\n") ? afterClose.slice(1) : afterClose;
        searchFrom = 0;
      }
    }

    // Store trailing partial backtick markers (1 or 2 backticks at end of buffer)
    // so they can be reassembled with the next delta into a full ``` marker.
    const trailing = this.buffer.match(/`{1,2}$/);
    if (trailing && !this.inCodeBlock) {
      this.codeBlockPartialMarker = trailing[0];
      this.buffer = this.buffer.slice(0, -this.codeBlockPartialMarker.length);
    }
  }

  // ─── Private: Sentence extraction ───────────────────────────────────

  private extractSentences(chunks: TextChunk[]): void {
    if (this.inCodeBlock && this.config.codeBlockBehavior !== "read") return;

    // Check for paragraph boundaries first
    let paraMatch: RegExpExecArray | null;
    while ((paraMatch = PARAGRAPH_BOUNDARY.exec(this.buffer)) !== null) {
      const sentence = this.buffer.slice(0, paraMatch.index).trim();
      if (sentence) {
        const cleaned = this.cleanMarkdown(sentence);
        if (cleaned) {
          chunks.push({ text: cleaned, type: "prose" });
        }
      }
      this.buffer = this.buffer.slice(paraMatch.index + paraMatch[0].length);
      PARAGRAPH_BOUNDARY.lastIndex = 0;
    }

    // Check for sentence boundaries
    let sentMatch: RegExpExecArray | null;
    while ((sentMatch = SENTENCE_BOUNDARY.exec(this.buffer)) !== null) {
      const endIdx = sentMatch.index + sentMatch[1].length;
      const sentence = this.buffer.slice(0, endIdx).trim();
      if (sentence) {
        const cleaned = this.cleanMarkdown(sentence);
        if (cleaned) {
          chunks.push({ text: cleaned, type: "prose" });
        }
      }
      this.buffer = this.buffer.slice(sentMatch.index + sentMatch[0].length);
      SENTENCE_BOUNDARY.lastIndex = 0;
    }
  }

  // ─── Private: Markdown cleanup ──────────────────────────────────────

  private cleanMarkdown(text: string): string {
    let result = text;

    // Images before links (images have ! prefix)
    result = result.replace(MD_IMAGE, "image: $1");

    // Links → just the text
    result = result.replace(MD_LINK, "$1");

    // Bold/italic
    result = result.replace(MD_BOLD, "$1");
    result = result.replace(MD_BOLD_UNDER, "$1");
    result = result.replace(MD_ITALIC, "$1");
    result = result.replace(MD_ITALIC_UNDER, "$1");
    result = result.replace(MD_STRIKETHROUGH, "$1");

    // Inline code → just the code text
    result = result.replace(MD_INLINE_CODE, "$1");

    // Headings → text with period
    result = result.replace(MD_HEADING, "$1.");

    // Lists → just the content (comma for list flow)
    result = result.replace(MD_UNORDERED_LIST, "");
    result = result.replace(MD_ORDERED_LIST, "");

    // Blockquotes
    result = result.replace(MD_BLOCKQUOTE, "");

    // Horizontal rules
    result = result.replace(MD_HR, "");

    // HTML tags
    result = result.replace(MD_HTML_TAG, "");

    // Clean up whitespace
    result = result.replace(MD_MULTIPLE_NEWLINES, "\n");
    result = result.replace(MD_MULTIPLE_SPACES, " ");

    return result.trim();
  }

  // ─── Private: Tool announcements ────────────────────────────────────

  private formatToolAnnouncement(toolName: string, input: Record<string, unknown>): string {
    const name = toolName.toLowerCase();

    switch (name) {
      case "bash": {
        const cmd = String(input.command ?? "").slice(0, 60);
        return `Running command: ${cmd}`;
      }
      case "read": {
        const path = String(input.path ?? "");
        return `Reading file: ${path}`;
      }
      case "write": {
        const path = String(input.path ?? "");
        return `Writing to file: ${path}`;
      }
      case "edit": {
        const path = String(input.path ?? "");
        return `Editing file: ${path}`;
      }
      case "grep": {
        const pattern = String(input.pattern ?? "");
        return `Searching for: ${pattern}`;
      }
      case "find": {
        const pattern = String(input.pattern ?? "");
        return `Finding files: ${pattern}`;
      }
      case "ls": {
        const path = String(input.path ?? ".");
        return `Listing directory: ${path}`;
      }
      case "lsp": {
        const action = String(input.action ?? "query");
        return `Querying language server: ${action}`;
      }
      case "agent": {
        const desc = String(input.description ?? "task");
        return `Launching sub-agent: ${desc}`;
      }
      case "todo": {
        const action = String(input.action ?? "");
        return `Managing todo: ${action}`;
      }
      default:
        return `Using tool: ${toolName}`;
    }
  }
}
