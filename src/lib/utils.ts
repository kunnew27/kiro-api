/**
 * Utility Functions
 * Fingerprint generation, headers, ID generation
 */

import { createHash, randomUUID } from "crypto"
import { hostname, userInfo } from "os"
import type { KiroAuthManager } from "./auth"

/**
 * Generate unique machine fingerprint based on hostname and username
 */
export function getMachineFingerprint(): string {
    try {
        const host = hostname()
        const user = userInfo().username
        const uniqueString = `${host}-${user}-kiro-gateway`
        return createHash("sha256").update(uniqueString).digest("hex")
    } catch {
        return createHash("sha256").update("default-kiro-gateway").digest("hex")
    }
}

/**
 * Build headers for Kiro API requests
 */
export function getKiroHeaders(authManager: KiroAuthManager, token: string): Record<string, string> {
    const fingerprint = authManager.fingerprint

    return {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": `aws-sdk-js/1.0.27 ua/2.1 os/win32#10.0.19044 lang/js md/nodejs#22.21.1 api/codewhispererstreaming#1.0.27 m/E KiroGateway-${fingerprint.slice(0, 32)}`,
        "x-amz-user-agent": `aws-sdk-js/1.0.27 KiroGateway-${fingerprint.slice(0, 32)}`,
        "x-amzn-codewhisperer-optout": "true",
        "x-amzn-kiro-agent-mode": "vibe",
        "amz-sdk-invocation-id": randomUUID(),
        "amz-sdk-request": "attempt=1; max=3",
    }
}

/**
 * Generate unique ID for chat completion
 */
export function generateCompletionId(): string {
    return `chatcmpl-${randomUUID().replace(/-/g, "")}`
}

/**
 * Generate unique conversation ID
 */
export function generateConversationId(): string {
    return randomUUID()
}

/**
 * Generate unique tool call ID
 */
export function generateToolCallId(): string {
    return `call_${randomUUID().replace(/-/g, "").slice(0, 8)}`
}

/**
 * Generate Anthropic-style message ID
 */
export function generateAnthropicMessageId(): string {
    return `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`
}

/**
 * Mask token for logging (show only first and last 4 chars)
 */
export function maskToken(token: string): string {
    if (token.length <= 8) {
        return "***"
    }
    return `${token.slice(0, 4)}...${token.slice(-4)}`
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Get current timestamp in seconds
 */
export function nowSeconds(): number {
    return Math.floor(Date.now() / 1000)
}

/**
 * Get current ISO timestamp
 */
export function nowISO(): string {
    return new Date().toISOString()
}

// ==================================================================================================
// Enhanced Utilities from AIClient-2-API
// ==================================================================================================

/**
 * Repair malformed JSON strings
 * Based on AIClient-2-API's repairJson function
 */
export function repairJson(jsonStr: string): string {
    let repaired = jsonStr

    // Remove trailing commas before } or ]
    repaired = repaired.replace(/,\s*([}\]])/g, "$1")

    // Add quotes to unquoted keys (e.g., {foo: "bar"} -> {"foo": "bar"})
    repaired = repaired.replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":')

    // Fix unquoted string values that are simple identifiers
    // Be careful not to break numbers, booleans, null
    repaired = repaired.replace(/:\s*([a-zA-Z_][a-zA-Z0-9_]*)(?=[,\}\]])/g, (_, val) => {
        // Don't quote boolean or null values
        if (val === "true" || val === "false" || val === "null") {
            return `: ${val}`
        }
        return `: "${val}"`
    })

    return repaired
}

/**
 * Find matching bracket position considering nesting
 * Supports both {} and []
 */
export function findMatchingBracket(text: string, startPos: number): number {
    const openChar = text[startPos]
    const closeChar = openChar === "{" ? "}" : openChar === "[" ? "]" : null

    if (!closeChar) return -1

    let depth = 1
    let inString = false
    let escapeNext = false

    for (let i = startPos + 1; i < text.length; i++) {
        const char = text[i]

        if (escapeNext) {
            escapeNext = false
            continue
        }

        if (char === "\\") {
            escapeNext = true
            continue
        }

        if (char === '"') {
            inString = !inString
            continue
        }

        if (inString) continue

        if (char === openChar) {
            depth++
        } else if (char === closeChar) {
            depth--
            if (depth === 0) {
                return i
            }
        }
    }

    return -1
}

/**
 * Safe JSON parsing with truncated escape sequence handling and repair
 * Handles incomplete escape sequences that can occur in streamed JSON
 */
export function safeParseJSON<T = unknown>(str: string | null | undefined): T | string {
    if (!str) return str as string

    let cleanedStr = str.trim()

    // Handle truncated escape sequences at the end
    if (cleanedStr.endsWith("\\") && !cleanedStr.endsWith("\\\\")) {
        cleanedStr = cleanedStr.substring(0, cleanedStr.length - 1)
    } else if (
        cleanedStr.endsWith("\\u") ||
        cleanedStr.endsWith("\\u0") ||
        cleanedStr.endsWith("\\u00") ||
        cleanedStr.endsWith("\\u000")
    ) {
        const idx = cleanedStr.lastIndexOf("\\u")
        cleanedStr = cleanedStr.substring(0, idx)
    }

    // First attempt: direct parse
    try {
        return JSON.parse(cleanedStr || "{}") as T
    } catch {
        // Continue to repair attempts
    }

    // Second attempt: try to repair common JSON issues
    try {
        const repaired = repairJson(cleanedStr)
        return JSON.parse(repaired) as T
    } catch {
        // Continue to control character fix
    }

    // Third attempt: fix unescaped control characters in strings
    try {
        const fixed = cleanedStr.replace(/[\x00-\x1F\x7F]/g, (char) => {
            const code = char.charCodeAt(0)
            if (code === 0x09) return "\\t"
            if (code === 0x0A) return "\\n"
            if (code === 0x0D) return "\\r"
            return `\\u${code.toString(16).padStart(4, "0")}`
        })
        return JSON.parse(fixed) as T
    } catch {
        // Continue to combined repair
    }

    // Fourth attempt: combine repair and control character fix
    try {
        let combined = repairJson(cleanedStr)
        combined = combined.replace(/[\x00-\x1F\x7F]/g, (char) => {
            const code = char.charCodeAt(0)
            if (code === 0x09) return "\\t"
            if (code === 0x0A) return "\\n"
            if (code === 0x0D) return "\\r"
            return `\\u${code.toString(16).padStart(4, "0")}`
        })
        return JSON.parse(combined) as T
    } catch {
        // Return original string on failure
        return str
    }
}

/**
 * Map finish reason between different API formats
 */
export type FinishReasonFormat = "openai" | "anthropic" | "gemini" | "kiro"

const FINISH_REASON_MAPPINGS: Record<string, Record<string, Record<string, string>>> = {
    openai: {
        anthropic: {
            stop: "end_turn",
            length: "max_tokens",
            content_filter: "stop_sequence",
            tool_calls: "tool_use",
        },
        gemini: {
            stop: "STOP",
            length: "MAX_TOKENS",
            content_filter: "SAFETY",
            tool_calls: "STOP",
        },
    },
    anthropic: {
        openai: {
            end_turn: "stop",
            max_tokens: "length",
            stop_sequence: "stop",
            tool_use: "tool_calls",
        },
        gemini: {
            end_turn: "STOP",
            max_tokens: "MAX_TOKENS",
            stop_sequence: "STOP",
            tool_use: "STOP",
        },
    },
    gemini: {
        openai: {
            STOP: "stop",
            MAX_TOKENS: "length",
            SAFETY: "content_filter",
            RECITATION: "stop",
        },
        anthropic: {
            STOP: "end_turn",
            MAX_TOKENS: "max_tokens",
            SAFETY: "stop_sequence",
            RECITATION: "stop_sequence",
        },
    },
}

export function mapFinishReason(
    reason: string | null | undefined,
    sourceFormat: FinishReasonFormat,
    targetFormat: FinishReasonFormat
): string {
    if (!reason) return targetFormat === "anthropic" ? "end_turn" : "stop"
    if (sourceFormat === targetFormat) return reason

    try {
        const mapped = FINISH_REASON_MAPPINGS[sourceFormat]?.[targetFormat]?.[reason]
        if (mapped) return mapped
    } catch {
        // Fall through to default
    }

    // Default values by target format
    if (targetFormat === "anthropic") return "end_turn"
    if (targetFormat === "gemini") return "STOP"
    return "stop"
}

/**
 * Extract thinking content from text (handles <thinking> tags)
 */
export interface ThinkingBlock {
    type: "text" | "thinking"
    text?: string
    thinking?: string
}

export function extractThinkingFromText(text: string): string | ThinkingBlock[] {
    if (!text) return text

    const thinkingPattern = /<thinking>\s*(.*?)\s*<\/thinking>/gs
    const matches = [...text.matchAll(thinkingPattern)]

    if (matches.length === 0) return text

    const contentBlocks: ThinkingBlock[] = []
    let lastEnd = 0

    for (const match of matches) {
        const beforeText = text.substring(lastEnd, match.index).trim()
        if (beforeText) {
            contentBlocks.push({ type: "text", text: beforeText })
        }

        const thinkingText = match[1].trim()
        if (thinkingText) {
            contentBlocks.push({ type: "thinking", thinking: thinkingText })
        }

        lastEnd = match.index! + match[0].length
    }

    const afterText = text.substring(lastEnd).trim()
    if (afterText) {
        contentBlocks.push({ type: "text", text: afterText })
    }

    // If only one text block, return as string
    if (contentBlocks.length === 1 && contentBlocks[0].type === "text") {
        return contentBlocks[0].text || ""
    }

    return contentBlocks
}

/**
 * Clean JSON Schema properties (remove unsupported fields for different APIs)
 */
const SAFE_SCHEMA_PROPERTIES = new Set([
    "type",
    "description",
    "properties",
    "required",
    "enum",
    "items",
    "default",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "anyOf",
    "oneOf",
    "allOf",
])

export function cleanJsonSchemaProperties(schema: Record<string, unknown> | null | undefined): Record<string, unknown> {
    if (!schema || typeof schema !== "object") return schema || {}

    const sanitized: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(schema)) {
        if (SAFE_SCHEMA_PROPERTIES.has(key)) {
            sanitized[key] = value
        }
    }

    // Recursively clean nested properties
    if (sanitized.properties && typeof sanitized.properties === "object") {
        const cleanProperties: Record<string, unknown> = {}
        for (const [propName, propSchema] of Object.entries(sanitized.properties as Record<string, unknown>)) {
            cleanProperties[propName] = cleanJsonSchemaProperties(propSchema as Record<string, unknown>)
        }
        sanitized.properties = cleanProperties
    }

    // Recursively clean items (for arrays)
    if (sanitized.items && typeof sanitized.items === "object") {
        sanitized.items = cleanJsonSchemaProperties(sanitized.items as Record<string, unknown>)
    }

    return sanitized
}

/**
 * Format expiry time for display
 */
export function formatExpiryTime(expiryTimestamp: number | null | undefined): string {
    if (!expiryTimestamp || typeof expiryTimestamp !== "number") {
        return "No expiry date available"
    }

    const diffMs = expiryTimestamp - Date.now()
    if (diffMs <= 0) return "Token has expired"

    let totalSeconds = Math.floor(diffMs / 1000)
    const hours = Math.floor(totalSeconds / 3600)
    totalSeconds %= 3600
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60

    const pad = (num: number) => String(num).padStart(2, "0")
    return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`
}

/**
 * Generate MD5 hash for object (useful for caching/deduplication)
 */
export function getMD5Hash(obj: unknown): string {
    const jsonString = JSON.stringify(obj)
    return createHash("md5").update(jsonString).digest("hex")
}

/**
 * Determine reasoning effort from budget tokens (for thinking models)
 */
export function determineReasoningEffortFromBudget(budgetTokens: number | null | undefined): "low" | "medium" | "high" {
    if (budgetTokens === null || budgetTokens === undefined) {
        return "high"
    }

    const LOW_THRESHOLD = 50
    const HIGH_THRESHOLD = 200

    if (budgetTokens <= LOW_THRESHOLD) return "low"
    if (budgetTokens <= HIGH_THRESHOLD) return "medium"
    return "high"
}

