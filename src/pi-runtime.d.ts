/**
 * Ambient module declarations for pi host packages.
 *
 * These packages are provided by the pi runtime and are not installed as
 * local npm dependencies. The declarations here give TypeScript enough
 * type information to compile the extension without errors.
 *
 * At runtime, pi's jiti loader resolves these modules from its own
 * node_modules, so everything "just works" when loaded by pi.
 */

declare module "@mariozechner/pi-tui" {
  export class SettingsList {
    constructor(
      items: Array<{
        id: string;
        label: string;
        currentValue: string;
        values: string[];
        section?: string;
      }>,
      maxHeight: number,
      theme: unknown,
      onChange: (id: string, value: string) => void,
      onClose: () => void,
    );
    render(width: number): string[];
    handleInput?(data: string): void;
    invalidate(): void;
  }

  export class SelectList<T = unknown> {
    onSelect: ((item: T) => void) | null;
    onCancel: (() => void) | null;
    constructor(
      items: T[],
      maxVisible: number,
      options?: Record<string, unknown>,
    );
    render(width: number): string[];
    handleInput?(data: string): void;
    invalidate(): void;
  }

  export class Text {
    constructor(content: string, paddingLeft?: number, paddingTop?: number);
    render(width: number): string[];
    invalidate(): void;
  }

  export class Container {
    addChild(child: unknown): void;
    render(width: number): string[];
    invalidate(): void;
  }

  export function truncateToWidth(text: string, width: number, suffix?: string): string;
  export function visibleWidth(text: string): number;

  export function matchesKey(data: string, key: string): boolean;
}

declare module "@mariozechner/pi-coding-agent" {
  export function getSettingsListTheme(): unknown;

  export class DynamicBorder {
    constructor(styleFn: (s: string) => string);
    render(width: number): string[];
    invalidate(): void;
  }

  /** The API object passed to every extension's default export function. */
  export interface ExtensionAPI {
    /** Subscribe to a lifecycle event. */
    on(event: string, handler: (...args: any[]) => any): void;

    /** Register a slash command. */
    registerCommand(
      name: string,
      options: {
        description: string;
        getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
        handler: (args: string | undefined, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ): void;

    /** Register a custom tool callable by the LLM. */
    registerTool(tool: Record<string, unknown>): void;

    /** Send a user message programmatically. */
    sendUserMessage(
      text: string | Array<Record<string, unknown>>,
      options?: { deliverAs?: "steer" | "followUp" },
    ): void;

    /** Append a custom entry to the session. */
    appendEntry(type: string, data: unknown): void;

    /** Execute a command and return stdout/stderr. */
    exec(cmd: string, args: string[], options?: Record<string, unknown>): Promise<{ stdout: string; stderr: string }>;
  }

  /** Context available inside command handlers. Extends ExtensionContext. */
  export interface ExtensionCommandContext extends ExtensionContext {
    waitForIdle(): Promise<void>;
    newSession(options?: Record<string, unknown>): Promise<unknown>;
    fork(entryId: string): Promise<unknown>;
    navigateTree(targetId: string, options?: Record<string, unknown>): Promise<unknown>;
    reload(): Promise<void>;
  }

  /** Context available in event handlers. */
  export interface ExtensionContext {
    ui: ExtensionUI;
    hasUI: boolean;
    cwd: string;
    sessionManager: {
      getBranch(): any[];
      getEntries(): any[];
      getSessionFile(): string;
    };
    modelRegistry: unknown;
    model?: unknown;
    isIdle(): boolean;
    abort(): Promise<void>;
    hasPendingMessages(): boolean;
    shutdown(): void;
    getContextUsage(): { tokens: number } | undefined;
    getSystemPrompt(): string;
    compact(options?: Record<string, unknown>): void;
  }

  export interface ExtensionUI {
    setStatus(id: string, content: string | undefined): void;
    setWidget(
      id: string,
      content:
        | string[]
        | ((tui: any, theme: any) => { render(w: number): string[]; invalidate(): void; handleInput?(data: string): void; wantsKeyRelease?: boolean })
        | undefined,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ): void;
    setEditorText(text: string): void;
    setFooter(factory: unknown): void;
    custom<T>(
      factory: (
        tui: any,
        theme: any,
        keybindings: any,
        done: (result: T) => void,
      ) => { render(width: number): string[]; invalidate(): void; handleInput?(data: string): void; wantsKeyRelease?: boolean },
      options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
    ): Promise<T>;
    notify(message: string, type: "info" | "success" | "warning" | "error"): void;
    confirm(title: string, message: string): Promise<boolean>;
    input(prompt: string): Promise<string | null>;
    select(prompt: string, options: string[]): Promise<string | null>;
    editor(title: string, content?: string): Promise<string | null>;
    theme: {
      fg(color: string, text: string): string;
      bg(color: string, text: string): string;
      bold(text: string): string;
    };
  }
}
