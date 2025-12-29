/**
 * AWS Event Stream Parser
 * Parses binary AWS SSE stream and extracts JSON events
 */

import consola from "consola";
import { generateToolCallId, safeParseJSON } from "~/lib/utils";

/**
 * Find matching closing brace considering nesting and strings
 */
export function findMatchingBrace(text: string, startPos: number): number {
  if (startPos >= text.length || text[startPos] !== "{") {
    return -1;
  }

  let braceCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startPos; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === "\\" && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === "{") {
        braceCount++;
      } else if (char === "}") {
        braceCount--;
        if (braceCount === 0) {
          return i;
        }
      }
    }
  }

  return -1;
}

/**
 * Parse tool calls in bracket format: [Called func_name with args: {...}]
 */
export function parseBracketToolCalls(responseText: string): ToolCall[] {
  if (!responseText || !responseText.includes("[Called")) {
    return [];
  }

  const toolCalls: ToolCall[] = [];
  const pattern = /\[Called\s+(\w+)\s+with\s+args:\s*/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(responseText)) !== null) {
    const funcName = match[1];
    const argsStart = match.index + match[0].length;

    // Find start of JSON - must be close to the pattern match (within 10 chars)
    const jsonStart = responseText.indexOf("{", argsStart);
    if (jsonStart === -1 || jsonStart - argsStart > 10) continue;

    // Find end of JSON considering nesting
    const jsonEnd = findMatchingBrace(responseText, jsonStart);
    if (jsonEnd === -1) continue;

    // Verify the bracket closes with ]
    const afterJson = responseText.slice(jsonEnd + 1, jsonEnd + 3).trim();
    if (!afterJson.startsWith("]")) {
      // Not a proper bracket tool call format, skip silently
      continue;
    }

    const jsonStr = responseText.slice(jsonStart, jsonEnd + 1);

    const args = safeParseJSON(jsonStr);
    if (typeof args === "object" && args !== null) {
      toolCalls.push({
        id: generateToolCallId(),
        type: "function",
        function: {
          name: funcName,
          arguments: JSON.stringify(args),
        },
      });
    } else {
      // Only log as debug since this might be false positive from content
      consola.debug(
        `Could not parse bracket tool call arguments: ${jsonStr.slice(0, 100)}`
      );
    }
  }

  return toolCalls;
}

/**
 * Deduplicate tool calls by id and name+arguments
 */
export function deduplicateToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  // First deduplicate by id - keep the one with more arguments
  const byId = new Map<string, ToolCall>();

  for (const tc of toolCalls) {
    const tcId = tc.id || "";
    if (!tcId) continue;

    const existing = byId.get(tcId);
    if (!existing) {
      byId.set(tcId, tc);
    } else {
      // Keep the one with more arguments
      const existingArgs = existing.function?.arguments || "{}";
      const currentArgs = tc.function?.arguments || "{}";

      if (
        currentArgs !== "{}" &&
        (existingArgs === "{}" || currentArgs.length > existingArgs.length)
      ) {
        consola.debug(
          `Replacing tool call ${tcId} with better arguments: ${existingArgs.length} -> ${currentArgs.length}`
        );
        byId.set(tcId, tc);
      }
    }
  }

  // Collect tool calls: first those with id, then without
  const resultWithId = Array.from(byId.values());
  const resultWithoutId = toolCalls.filter((tc) => !tc.id);

  // Deduplicate by name+arguments
  const seen = new Set<string>();
  const unique: ToolCall[] = [];

  for (const tc of [...resultWithId, ...resultWithoutId]) {
    const funcName = tc.function?.name || "";
    const funcArgs = tc.function?.arguments || "{}";
    const key = `${funcName}-${funcArgs}`;

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(tc);
    }
  }

  if (toolCalls.length !== unique.length) {
    consola.debug(
      `Deduplicated tool calls: ${toolCalls.length} -> ${unique.length}`
    );
  }

  return unique;
}

// Types
export interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ParsedEvent {
  type:
    | "content"
    | "tool_start"
    | "tool_input"
    | "tool_stop"
    | "usage"
    | "context_usage"
    | "followup";
  data: any;
}

// Pattern type mapping
const PATTERN_TYPE_MAP: Record<string, ParsedEvent["type"]> = {
  '{"content":': "content",
  '{"name":': "tool_start",
  '{"input":': "tool_input",
  '{"stop":': "tool_stop",
  '{"followupPrompt":': "followup",
  '{"usage":': "usage",
  '{"contextUsagePercentage":': "context_usage",
};

// Pattern regex for quick matching
const PATTERN_REGEX =
  /\{"(?:content|name|input|stop|followupPrompt|usage|contextUsagePercentage)":/g;

/**
 * AWS Event Stream Parser
 * Parses binary AWS SSE stream and extracts JSON events
 */
export class AwsEventStreamParser {
  private buffer: string = "";
  private lastContent: string | null = null;
  private currentToolCall: ToolCall | null = null;
  private toolCalls: ToolCall[] = [];

  /**
   * Feed chunk to parser and return parsed events
   */
  feed(chunk: Uint8Array | string): ParsedEvent[] {
    try {
      if (typeof chunk === "string") {
        this.buffer += chunk;
      } else {
        this.buffer += new TextDecoder().decode(chunk);
      }
    } catch {
      return [];
    }

    const events: ParsedEvent[] = [];

    while (true) {
      // Find next event pattern
      PATTERN_REGEX.lastIndex = 0;
      const match = PATTERN_REGEX.exec(this.buffer);
      if (!match) break;

      const earliestPos = match.index;

      // Find the colon to get full pattern prefix
      const colonPos = this.buffer.indexOf(":", earliestPos);
      if (colonPos === -1) break;

      const patternPrefix = this.buffer.slice(earliestPos, colonPos + 1);
      const eventType = PATTERN_TYPE_MAP[patternPrefix];

      if (!eventType) {
        // Unknown pattern, skip
        this.buffer = this.buffer.slice(earliestPos + 1);
        continue;
      }

      // Find end of JSON
      const jsonEnd = findMatchingBrace(this.buffer, earliestPos);
      if (jsonEnd === -1) {
        // JSON not complete, wait for more data
        break;
      }

      const jsonStr = this.buffer.slice(earliestPos, jsonEnd + 1);
      this.buffer = this.buffer.slice(jsonEnd + 1);

      const data = safeParseJSON(jsonStr);
      if (typeof data === "object" && data !== null) {
        const event = this._processEvent(data, eventType);
        if (event) {
          events.push(event);
        }
      } else {
        // Log as debug - non-critical, parsing continues
        consola.debug(`Could not parse event JSON: ${jsonStr.slice(0, 100)}`);
      }
    }

    return events;
  }

  /**
   * Process parsed event
   */
  private _processEvent(
    data: any,
    eventType: ParsedEvent["type"]
  ): ParsedEvent | null {
    switch (eventType) {
      case "content":
        return this._processContentEvent(data);
      case "tool_start":
        return this._processToolStartEvent(data);
      case "tool_input":
        return this._processToolInputEvent(data);
      case "tool_stop":
        return this._processToolStopEvent(data);
      case "usage":
        return { type: "usage", data: data.usage || 0 };
      case "context_usage":
        return {
          type: "context_usage",
          data: data.contextUsagePercentage || 0,
        };
      default:
        return null;
    }
  }

  /**
   * Process content event
   */
  private _processContentEvent(data: any): ParsedEvent | null {
    const content = data.content || "";

    // Skip followupPrompt
    if (data.followupPrompt) {
      return null;
    }

    // Deduplicate repeated content
    if (content === this.lastContent) {
      return null;
    }

    this.lastContent = content;
    return { type: "content", data: content };
  }

  /**
   * Process tool start event
   */
  private _processToolStartEvent(data: any): ParsedEvent | null {
    // Finalize previous tool call if exists
    if (this.currentToolCall) {
      this._finalizeToolCall();
    }

    // Input can be string or object
    let inputStr: string;
    if (typeof data.input === "object") {
      inputStr = JSON.stringify(data.input);
    } else {
      inputStr = data.input ? String(data.input) : "";
    }

    this.currentToolCall = {
      id: data.toolUseId || generateToolCallId(),
      type: "function",
      function: {
        name: data.name || "",
        arguments: inputStr,
      },
    };

    if (data.stop) {
      this._finalizeToolCall();
    }

    return null;
  }

  /**
   * Process tool input event
   */
  private _processToolInputEvent(data: any): ParsedEvent | null {
    if (this.currentToolCall) {
      if (typeof data.input === "object" && data.input !== null) {
        // Merge object inputs instead of concatenating stringified versions
        try {
          const existingArgs = this.currentToolCall.function.arguments;
          const existingObj = existingArgs ? safeParseJSON(existingArgs) : {};

          if (typeof existingObj === "object" && existingObj !== null) {
            // Merge the new input into existing object
            const merged = { ...existingObj, ...data.input };
            this.currentToolCall.function.arguments = JSON.stringify(merged);
          } else {
            // Existing args couldn't be parsed, use new input directly
            this.currentToolCall.function.arguments = JSON.stringify(data.input);
          }
        } catch {
          // Fallback to direct stringify
          this.currentToolCall.function.arguments = JSON.stringify(data.input);
        }
      } else {
        // String input - append as before (for streamed JSON fragments)
        const inputStr = data.input ? String(data.input) : "";
        this.currentToolCall.function.arguments += inputStr;
      }
    }
    return null;
  }

  /**
   * Process tool stop event
   */
  private _processToolStopEvent(data: any): ParsedEvent | null {
    if (this.currentToolCall && data.stop) {
      this._finalizeToolCall();
    }
    return null;
  }

  /**
   * Finalize current tool call and add to list
   */
  private _finalizeToolCall(): void {
    if (!this.currentToolCall) return;

    const args = this.currentToolCall.function.arguments;
    const toolName = this.currentToolCall.function.name || "unknown";

    consola.debug(
      `Finalizing tool call '${toolName}' with raw arguments: ${args.slice(
        0,
        200
      )}`
    );

    if (typeof args === "string") {
      if (args.trim()) {
        const parsed = safeParseJSON(args);
        if (typeof parsed === "object" && parsed !== null) {
          this.currentToolCall.function.arguments = JSON.stringify(parsed);
          consola.debug(`Tool '${toolName}' arguments parsed successfully`);
        } else {
          // Log as debug - tool call will still work with empty args
          consola.debug(
            `Could not parse tool '${toolName}' arguments, using empty object. Raw: ${args.slice(
              0,
              200
            )}`
          );
          this.currentToolCall.function.arguments = "{}";
        }
      } else {
        this.currentToolCall.function.arguments = "{}";
      }
    }

    this.toolCalls.push(this.currentToolCall);
    this.currentToolCall = null;
  }

  /**
   * Get all collected tool calls (deduplicated)
   */
  getToolCalls(): ToolCall[] {
    if (this.currentToolCall) {
      this._finalizeToolCall();
    }
    return deduplicateToolCalls(this.toolCalls);
  }

  /**
   * Reset parser state
   */
  reset(): void {
    this.buffer = "";
    this.lastContent = null;
    this.currentToolCall = null;
    this.toolCalls = [];
  }
}
