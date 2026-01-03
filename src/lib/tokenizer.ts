/**
 * Token Counting Module
 *
 * Uses tiktoken (OpenAI's Rust-based library) for approximate token counting.
 * The cl100k_base encoding is close to Claude's tokenization.
 *
 * Note: This is approximate counting since Claude's exact tokenizer is not public.
 * Anthropic doesn't publish their tokenizer, so we use tiktoken with a correction factor.
 *
 * The CLAUDE_CORRECTION_FACTOR = 1.15 is based on empirical observations:
 * Claude tokenizes text approximately 15% more than GPT-4 (cl100k_base).
 * This is due to differences in BPE vocabularies.
 */

import consola from "consola"

// Lazy load tiktoken for faster imports
let encoding: any = null
let tiktokenFailed = false

// Correction factor for Claude models
// Claude tokenizes text approximately 15% more than GPT-4 (cl100k_base)
// This is an empirical value based on comparison with context_usage from API
const CLAUDE_CORRECTION_FACTOR = 1.15

/**
 * Lazy initialization of tokenizer
 * Uses cl100k_base - encoding for GPT-4/ChatGPT,
 * which is close enough to Claude's tokenization
 */
async function getEncoding(): Promise<any> {
    if (encoding !== null) return encoding
    if (tiktokenFailed) return null

    try {
        const tiktoken = await import("tiktoken")
        encoding = tiktoken.get_encoding("cl100k_base")
        consola.debug("[Tokenizer] Initialized tiktoken with cl100k_base encoding")
        return encoding
    } catch (e) {
        consola.warn(
            "[Tokenizer] tiktoken not available. " +
            "Token counting will use fallback estimation."
        )
        tiktokenFailed = true
        return null
    }
}

// Synchronous encoding reference (set after first async call)
let syncEncoding: any = null

/**
 * Initialize tokenizer (call once at startup)
 */
export async function initTokenizer(): Promise<void> {
    syncEncoding = await getEncoding()
}

/**
 * Count tokens in text
 * @param text - Text to count tokens for
 * @param applyClaudeCorrection - Apply correction factor for Claude (default true)
 * @returns Approximate token count (with Claude correction)
 */
export function countTokens(text: string, applyClaudeCorrection: boolean = true): number {
    if (!text) return 0

    if (syncEncoding) {
        try {
            const baseTokens = syncEncoding.encode(text).length
            if (applyClaudeCorrection) {
                return Math.floor(baseTokens * CLAUDE_CORRECTION_FACTOR)
            }
            return baseTokens
        } catch (e) {
            consola.warn(`[Tokenizer] Error encoding text: ${e}`)
        }
    }

    // Fallback: rough estimate ~4 chars per token for English,
    // ~2-3 chars for other languages (average ~3.5)
    // For Claude we add correction
    const baseEstimate = Math.floor(text.length / 4) + 1
    if (applyClaudeCorrection) {
        return Math.floor(baseEstimate * CLAUDE_CORRECTION_FACTOR)
    }
    return baseEstimate
}

/**
 * Count tokens in chat messages
 *
 * Accounts for OpenAI/Claude message structure:
 * - role: ~1 token
 * - content: text tokens
 * - Service tokens between messages: ~3-4 tokens
 *
 * @param messages - List of messages in OpenAI format
 * @param applyClaudeCorrection - Apply correction factor for Claude
 * @returns Approximate token count (with Claude correction)
 */
export function countMessageTokens(messages: any[], applyClaudeCorrection: boolean = true): number {
    if (!messages || messages.length === 0) return 0

    let totalTokens = 0

    for (const message of messages) {
        // Base tokens per message (role, separators)
        totalTokens += 4  // ~4 tokens for service info

        // Role tokens (without correction, these are short strings)
        const role = message.role || ""
        totalTokens += countTokens(role, false)

        // Content tokens
        const content = message.content
        if (content) {
            if (typeof content === "string") {
                totalTokens += countTokens(content, false)
            } else if (Array.isArray(content)) {
                // Multimodal content (text + images)
                for (const item of content) {
                    if (typeof item === "object" && item !== null) {
                        if (item.type === "text") {
                            totalTokens += countTokens(item.text || "", false)
                        } else if (item.type === "image_url" || item.type === "image") {
                            // Images take ~85-170 tokens depending on size
                            totalTokens += 100  // Average estimate
                        }
                    }
                }
            }
        }

        // Tool calls tokens (if present)
        const toolCalls = message.tool_calls
        if (toolCalls) {
            for (const tc of toolCalls) {
                totalTokens += 4  // Service tokens
                const func = tc.function || {}
                totalTokens += countTokens(func.name || "", false)
                totalTokens += countTokens(func.arguments || "", false)
            }
        }

        // Tool call ID tokens (for tool responses)
        if (message.tool_call_id) {
            totalTokens += countTokens(message.tool_call_id, false)
        }
    }

    // Final service tokens
    totalTokens += 3

    // Apply correction to total
    if (applyClaudeCorrection) {
        return Math.floor(totalTokens * CLAUDE_CORRECTION_FACTOR)
    }
    return totalTokens
}

/**
 * Count tokens in tool definitions
 *
 * @param tools - List of tools in OpenAI format
 * @param applyClaudeCorrection - Apply correction factor for Claude
 * @returns Approximate token count (with Claude correction)
 */
export function countToolsTokens(tools: any[] | null | undefined, applyClaudeCorrection: boolean = true): number {
    if (!tools || tools.length === 0) return 0

    let totalTokens = 0

    for (const tool of tools) {
        totalTokens += 4  // Service tokens

        if (tool.type === "function" || tool.function) {
            const func = tool.function || {}

            // Function name
            totalTokens += countTokens(func.name || "", false)

            // Function description
            totalTokens += countTokens(func.description || "", false)

            // Parameters (JSON schema)
            const params = func.parameters
            if (params) {
                const paramsStr = JSON.stringify(params)
                totalTokens += countTokens(paramsStr, false)
            }
        }
    }

    // Apply correction to total
    if (applyClaudeCorrection) {
        return Math.floor(totalTokens * CLAUDE_CORRECTION_FACTOR)
    }
    return totalTokens
}

/**
 * Estimate total tokens in a request
 *
 * @param messages - List of messages
 * @param tools - List of tools (optional)
 * @param systemPrompt - System prompt (optional, if not in messages)
 * @returns Object with token breakdown
 */
export function estimateRequestTokens(
    messages: any[],
    tools?: any[] | null,
    systemPrompt?: string | null
): { messagesTokens: number; toolsTokens: number; systemTokens: number; totalTokens: number } {
    const messagesTokens = countMessageTokens(messages)
    const toolsTokens = countToolsTokens(tools)
    const systemTokens = systemPrompt ? countTokens(systemPrompt) : 0

    return {
        messagesTokens,
        toolsTokens,
        systemTokens,
        totalTokens: messagesTokens + toolsTokens + systemTokens,
    }
}
