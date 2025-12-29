/**
 * Streaming Response Processing
 * Convert Kiro stream to OpenAI/Anthropic SSE format
 */

import consola from "consola"
import { config, getAdaptiveTimeout } from "~/lib/config"
import { generateCompletionId, generateAnthropicMessageId, nowSeconds } from "~/lib/utils"
import { AwsEventStreamParser, parseBracketToolCalls, deduplicateToolCalls, type ToolCall } from "./parsers"

// ==================================================================================================
// Token Counting (Simple estimation)
// ==================================================================================================

/**
 * Simple token count estimation (roughly 4 chars per token)
 */
function countTokens(text: string): number {
    if (!text) return 0
    return Math.ceil(text.length / 4)
}

/**
 * Count tokens in messages
 */
function countMessageTokens(messages: any[]): number {
    let total = 0
    for (const msg of messages) {
        if (typeof msg.content === "string") {
            total += countTokens(msg.content)
        } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block.text) {
                    total += countTokens(block.text)
                }
            }
        }
    }
    return total
}

/**
 * Count tokens in tools
 */
function countToolsTokens(tools: any[]): number {
    if (!tools) return 0
    let total = 0
    for (const tool of tools) {
        if (tool.function) {
            total += countTokens(tool.function.name || "")
            total += countTokens(tool.function.description || "")
            total += countTokens(JSON.stringify(tool.function.parameters || {}))
        }
    }
    return total
}

// ==================================================================================================
// Usage Calculation
// ==================================================================================================

interface UsageInfo {
    promptTokens: number
    completionTokens: number
    totalTokens: number
}

/**
 * Calculate token usage from response
 */
function calculateUsageTokens(
    fullContent: string,
    contextUsagePercentage: number | null,
    maxInputTokens: number,
    requestMessages?: any[],
    requestTools?: any[]
): UsageInfo {
    const completionTokens = countTokens(fullContent)

    let totalTokensFromApi = 0
    if (contextUsagePercentage !== null && contextUsagePercentage > 0) {
        totalTokensFromApi = Math.floor((contextUsagePercentage / 100) * maxInputTokens)
    }

    let promptTokens: number
    let totalTokens: number

    if (totalTokensFromApi > 0) {
        promptTokens = Math.max(0, totalTokensFromApi - completionTokens)
        totalTokens = totalTokensFromApi
    } else {
        promptTokens = 0
        if (requestMessages) {
            promptTokens += countMessageTokens(requestMessages)
        }
        if (requestTools) {
            promptTokens += countToolsTokens(requestTools)
        }
        totalTokens = promptTokens + completionTokens
    }

    return { promptTokens, completionTokens, totalTokens }
}

// ==================================================================================================
// Tool Calls Formatting
// ==================================================================================================

/**
 * Format tool calls for streaming response (with index)
 */
function formatToolCallsForStreaming(toolCalls: ToolCall[]): any[] {
    return toolCalls.map((tc, idx) => ({
        index: idx,
        id: tc.id,
        type: tc.type || "function",
        function: {
            name: tc.function?.name || "",
            arguments: tc.function?.arguments || "{}",
        },
    }))
}

/**
 * Format tool calls for non-streaming response (without index)
 */
function formatToolCallsForNonStreaming(toolCalls: ToolCall[]): any[] {
    return toolCalls.map(tc => ({
        id: tc.id,
        type: tc.type || "function",
        function: {
            name: tc.function?.name || "",
            arguments: tc.function?.arguments || "{}",
        },
    }))
}

// ==================================================================================================
// Timeout Helper
// ==================================================================================================

class StreamReadTimeoutError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "StreamReadTimeoutError"
    }
}

class FirstTokenTimeoutError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "FirstTokenTimeoutError"
    }
}

/**
 * Read chunk with timeout
 */
async function readChunkWithTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    timeout: number
): Promise<{ done: boolean; value?: Uint8Array }> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new StreamReadTimeoutError(`Stream read timeout after ${timeout}ms`))
        }, timeout)

        reader.read()
            .then(result => {
                clearTimeout(timer)
                resolve(result)
            })
            .catch(err => {
                clearTimeout(timer)
                reject(err)
            })
    })
}

// ==================================================================================================
// OpenAI Streaming
// ==================================================================================================

/**
 * Stream Kiro response to OpenAI SSE format (internal)
 */
async function* streamKiroToOpenAIInternal(
    response: Response,
    model: string,
    options: {
        maxInputTokens?: number
        requestMessages?: any[]
        requestTools?: any[]
    } = {}
): AsyncGenerator<string> {
    const { maxInputTokens = config.defaultMaxInputTokens, requestMessages, requestTools } = options

    const completionId = generateCompletionId()
    const createdTime = nowSeconds()
    let firstChunk = true

    const parser = new AwsEventStreamParser()
    let meteringData: number | null = null
    let contextUsagePercentage: number | null = null
    const contentParts: string[] = []

    const adaptiveStreamTimeout = getAdaptiveTimeout(model, config.streamReadTimeout) * 1000
    const firstTokenTimeout = getAdaptiveTimeout(model, config.firstTokenTimeout || config.streamReadTimeout) * 1000

    try {
        const reader = response.body?.getReader()
        if (!reader) {
            yield "data: [DONE]\n\n"
            return
        }

        // Wait for first chunk with timeout
        let result: { done: boolean; value?: Uint8Array }
        try {
            result = await readChunkWithTimeout(reader, firstTokenTimeout)
        } catch (e) {
            if (e instanceof StreamReadTimeoutError) {
                consola.warn(`First token timeout after ${firstTokenTimeout}ms (model: ${model})`)
                throw new FirstTokenTimeoutError(`No response within ${firstTokenTimeout}ms`)
            }
            throw e
        }

        if (result.done) {
            consola.debug("Empty response from Kiro API")
            yield "data: [DONE]\n\n"
            return
        }

        // Process first chunk
        if (!result.value) {
            consola.debug("No value in first chunk")
            yield "data: [DONE]\n\n"
            return
        }
        const events = parser.feed(result.value)
        for (const event of events) {
            if (event.type === "content") {
                const content = event.data as string
                contentParts.push(content)

                const delta: any = { content }
                if (firstChunk) {
                    delta.role = "assistant"
                    firstChunk = false
                }

                const openaiChunk = {
                    id: completionId,
                    object: "chat.completion.chunk",
                    created: createdTime,
                    model,
                    choices: [{ index: 0, delta, finish_reason: null }],
                }

                yield `data: ${JSON.stringify(openaiChunk)}\n\n`

            } else if (event.type === "usage") {
                meteringData = event.data as number

            } else if (event.type === "context_usage") {
                contextUsagePercentage = event.data as number
            }
        }

        // Continue with remaining chunks with consecutive timeout tolerance
        let consecutiveTimeouts = 0
        const maxConsecutiveTimeouts = 3

        while (true) {
            try {
                result = await readChunkWithTimeout(reader, adaptiveStreamTimeout)
                consecutiveTimeouts = 0 // Reset on success
            } catch (e) {
                if (e instanceof StreamReadTimeoutError) {
                    consecutiveTimeouts++
                    if (consecutiveTimeouts <= maxConsecutiveTimeouts) {
                        consola.warn(
                            `Stream read timeout ${consecutiveTimeouts}/${maxConsecutiveTimeouts} ` +
                            `after ${adaptiveStreamTimeout}ms (model: ${model}). ` +
                            `Model may be processing large content - continuing to wait...`
                        )
                        continue // Keep trying
                    }
                    consola.error(`Stream read timeout after ${maxConsecutiveTimeouts} consecutive timeouts`)
                    throw new Error(`Stream timeout after ${maxConsecutiveTimeouts} consecutive failures`)
                }
                throw e
            }

            if (result.done) break
            if (!result.value) continue

            const events = parser.feed(result.value)

            for (const event of events) {
                if (event.type === "content") {
                    const content = event.data as string
                    contentParts.push(content)

                    const delta: any = { content }
                    if (firstChunk) {
                        delta.role = "assistant"
                        firstChunk = false
                    }

                    const openaiChunk = {
                        id: completionId,
                        object: "chat.completion.chunk",
                        created: createdTime,
                        model,
                        choices: [{ index: 0, delta, finish_reason: null }],
                    }

                    yield `data: ${JSON.stringify(openaiChunk)}\n\n`

                } else if (event.type === "usage") {
                    meteringData = event.data as number

                } else if (event.type === "context_usage") {
                    contextUsagePercentage = event.data as number
                }
            }
        }

        // Combine content parts
        const fullContent = contentParts.join("")

        // Check bracket-style tool calls in full content
        const bracketToolCalls = parseBracketToolCalls(fullContent)
        const allToolCalls = deduplicateToolCalls([...parser.getToolCalls(), ...bracketToolCalls])

        const finishReason = allToolCalls.length > 0 ? "tool_calls" : "stop"

        // Calculate usage
        const usage = calculateUsageTokens(
            fullContent,
            contextUsagePercentage,
            maxInputTokens,
            requestMessages,
            requestTools
        )

        // Send tool calls if any
        if (allToolCalls.length > 0) {
            consola.debug(`Processing ${allToolCalls.length} tool calls for streaming response`)
            const indexedToolCalls = formatToolCallsForStreaming(allToolCalls)

            const toolCallsChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created: createdTime,
                model,
                choices: [{
                    index: 0,
                    delta: { tool_calls: indexedToolCalls },
                    finish_reason: null,
                }],
            }
            yield `data: ${JSON.stringify(toolCallsChunk)}\n\n`
        }

        // Final chunk with usage
        const finalChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTime,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: {
                prompt_tokens: usage.promptTokens,
                completion_tokens: usage.completionTokens,
                total_tokens: usage.totalTokens,
            },
        }

        if (meteringData !== null) {
            (finalChunk.usage as any).credits_used = meteringData
        }

        consola.debug(
            `[Usage] ${model}: prompt_tokens=${usage.promptTokens}, completion_tokens=${usage.completionTokens}, total_tokens=${usage.totalTokens}`
        )

        yield `data: ${JSON.stringify(finalChunk)}\n\n`
        yield "data: [DONE]\n\n"

    } catch (e) {
        consola.error(`Error during streaming: ${e}`)
        throw e
    }
}

/**
 * Stream Kiro response to OpenAI SSE format with retry
 */
export async function* streamKiroToOpenAI(
    response: Response,
    model: string,
    options: {
        maxInputTokens?: number
        requestMessages?: any[]
        requestTools?: any[]
    } = {}
): AsyncGenerator<string> {
    yield* streamKiroToOpenAIInternal(response, model, options)
}

/**
 * Stream with automatic retry on first token timeout
 */
export async function* streamKiroWithRetry(
    makeRequest: () => Promise<Response>,
    model: string,
    options: {
        maxInputTokens?: number
        requestMessages?: any[]
        requestTools?: any[]
        maxRetries?: number
    } = {}
): AsyncGenerator<string> {
    const { maxRetries = 3, ...streamOptions } = options

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await makeRequest()
            yield* streamKiroToOpenAIInternal(response, model, streamOptions)
            return // Success
        } catch (e: any) {
            if (e instanceof FirstTokenTimeoutError && attempt < maxRetries - 1) {
                consola.warn(
                    `First token timeout on attempt ${attempt + 1}/${maxRetries}, ` +
                    `retrying... (model: ${model})`
                )
                await new Promise(resolve => setTimeout(resolve, 1000))
                continue
            }
            // Re-throw if not a first token timeout or last attempt
            throw e
        }
    }

    throw new Error(`Failed after ${maxRetries} retries`)
}

/**
 * Collect stream response into single OpenAI response
 */
export async function collectOpenAIResponse(
    response: Response,
    model: string,
    options: {
        maxInputTokens?: number
        requestMessages?: any[]
        requestTools?: any[]
    } = {}
): Promise<any> {
    const contentParts: string[] = []
    let finalUsage: any = null
    const toolCalls: any[] = []
    const completionId = generateCompletionId()

    for await (const chunkStr of streamKiroToOpenAI(response, model, options)) {
        if (!chunkStr.startsWith("data:")) continue

        const dataStr = chunkStr.slice(5).trim()
        if (!dataStr || dataStr === "[DONE]") continue

        try {
            const chunkData = JSON.parse(dataStr)

            const delta = chunkData.choices?.[0]?.delta || {}
            if (delta.content) {
                contentParts.push(delta.content)
            }
            if (delta.tool_calls) {
                toolCalls.push(...delta.tool_calls)
            }

            if (chunkData.usage) {
                finalUsage = chunkData.usage
            }
        } catch {
            continue
        }
    }

    const fullContent = contentParts.join("")

    const message: any = { role: "assistant", content: fullContent }
    if (toolCalls.length > 0) {
        // Remove index field for non-streaming
        message.tool_calls = toolCalls.map(tc => ({
            id: tc.id,
            type: tc.type || "function",
            function: {
                name: tc.function?.name || "",
                arguments: tc.function?.arguments || "{}",
            },
        }))
    }

    const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop"

    return {
        id: completionId,
        object: "chat.completion",
        created: nowSeconds(),
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: finishReason,
        }],
        usage: finalUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }
}

// ==================================================================================================
// Anthropic Streaming
// ==================================================================================================

/**
 * Stream Kiro response to Anthropic SSE format
 */
export async function* streamKiroToAnthropic(
    response: Response,
    model: string,
    options: {
        maxInputTokens?: number
        requestMessages?: any[]
        requestTools?: any[]
        thinkingEnabled?: boolean
    } = {}
): AsyncGenerator<string> {
    const { maxInputTokens = config.defaultMaxInputTokens, requestMessages, requestTools } = options

    const messageId = generateAnthropicMessageId()
    const parser = new AwsEventStreamParser()
    let meteringData: number | null = null
    let contextUsagePercentage: number | null = null
    const contentParts: string[] = []
    let contentBlockIndex = 0
    let textBlockStarted = false

    // Pre-calculate input tokens
    let preCalculatedInputTokens = 0
    if (requestMessages) {
        preCalculatedInputTokens += countMessageTokens(requestMessages)
    }
    if (requestTools) {
        preCalculatedInputTokens += countToolsTokens(requestTools)
    }

    try {
        // message_start
        const messageStart = {
            type: "message_start",
            message: {
                id: messageId,
                type: "message",
                role: "assistant",
                content: [],
                model,
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: preCalculatedInputTokens,
                    output_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            },
        }
        yield `event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`

        const reader = response.body?.getReader()
        if (!reader) {
            yield `event: message_stop\ndata: {"type": "message_stop"}\n\n`
            return
        }

        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            const events = parser.feed(value)

            for (const event of events) {
                if (event.type === "content") {
                    const content = event.data as string
                    contentParts.push(content)

                    // Start text block if not started
                    if (!textBlockStarted) {
                        const blockStart = {
                            type: "content_block_start",
                            index: contentBlockIndex,
                            content_block: { type: "text", text: "" },
                        }
                        yield `event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`
                        textBlockStarted = true
                    }

                    // Send text_delta
                    const delta = {
                        type: "content_block_delta",
                        index: contentBlockIndex,
                        delta: { type: "text_delta", text: content },
                    }
                    yield `event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`

                } else if (event.type === "usage") {
                    meteringData = event.data as number

                } else if (event.type === "context_usage") {
                    contextUsagePercentage = event.data as number
                }
            }
        }

        // Close text block if started
        if (textBlockStarted) {
            const blockStop = {
                type: "content_block_stop",
                index: contentBlockIndex,
            }
            yield `event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`
            contentBlockIndex++
        }

        // Combine content
        const fullContent = contentParts.join("")

        // Process tool calls
        const bracketToolCalls = parseBracketToolCalls(fullContent)
        const allToolCalls = deduplicateToolCalls([...parser.getToolCalls(), ...bracketToolCalls])

        // Send tool_use blocks
        for (const tc of allToolCalls) {
            const toolName = tc.function?.name || ""
            const toolArgsStr = tc.function?.arguments || "{}"
            const toolId = tc.id || `toolu_${generateCompletionId().slice(8)}`

            let toolInput = {}
            try {
                toolInput = JSON.parse(toolArgsStr)
            } catch {
                // Keep empty object
            }

            // content_block_start for tool_use
            const toolBlockStart = {
                type: "content_block_start",
                index: contentBlockIndex,
                content_block: {
                    type: "tool_use",
                    id: toolId,
                    name: toolName,
                    input: {},
                },
            }
            yield `event: content_block_start\ndata: ${JSON.stringify(toolBlockStart)}\n\n`

            // input_json_delta
            if (Object.keys(toolInput).length > 0) {
                const inputDelta = {
                    type: "content_block_delta",
                    index: contentBlockIndex,
                    delta: {
                        type: "input_json_delta",
                        partial_json: JSON.stringify(toolInput),
                    },
                }
                yield `event: content_block_delta\ndata: ${JSON.stringify(inputDelta)}\n\n`
            }

            // content_block_stop
            const toolBlockStop = {
                type: "content_block_stop",
                index: contentBlockIndex,
            }
            yield `event: content_block_stop\ndata: ${JSON.stringify(toolBlockStop)}\n\n`

            contentBlockIndex++
        }

        // Determine stop_reason
        const stopReason = allToolCalls.length > 0 ? "tool_use" : "end_turn"

        // Calculate usage
        const usage = calculateUsageTokens(
            fullContent,
            contextUsagePercentage,
            maxInputTokens,
            requestMessages,
            requestTools
        )

        // message_delta
        const messageDelta = {
            type: "message_delta",
            delta: {
                stop_reason: stopReason,
                stop_sequence: null,
            },
            usage: {
                output_tokens: usage.completionTokens,
            },
        }
        yield `event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`

        // message_stop
        yield `event: message_stop\ndata: {"type": "message_stop"}\n\n`

        consola.debug(
            `[Anthropic Usage] ${model}: input_tokens=${usage.promptTokens}, output_tokens=${usage.completionTokens}`
        )

    } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e)
        consola.error(`Error during Anthropic streaming: ${errorMsg}`)

        const errorEvent = {
            type: "error",
            error: {
                type: "api_error",
                message: errorMsg,
            },
        }
        yield `event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`
    }
}

/**
 * Collect stream response into single Anthropic response
 */
export async function collectAnthropicResponse(
    response: Response,
    model: string,
    options: {
        maxInputTokens?: number
        requestMessages?: any[]
        requestTools?: any[]
    } = {}
): Promise<any> {
    const { maxInputTokens = config.defaultMaxInputTokens, requestMessages, requestTools } = options

    const messageId = generateAnthropicMessageId()
    const parser = new AwsEventStreamParser()
    let meteringData: number | null = null
    let contextUsagePercentage: number | null = null
    const contentParts: string[] = []

    try {
        const reader = response.body?.getReader()
        if (!reader) {
            return {
                id: messageId,
                type: "message",
                role: "assistant",
                content: [],
                model,
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
            }
        }

        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            const events = parser.feed(value)

            for (const event of events) {
                if (event.type === "content") {
                    contentParts.push(event.data as string)
                } else if (event.type === "usage") {
                    meteringData = event.data as number
                } else if (event.type === "context_usage") {
                    contextUsagePercentage = event.data as number
                }
            }
        }
    } catch (e) {
        consola.error(`Error collecting Anthropic response: ${e}`)
    }

    // Combine content
    const fullContent = contentParts.join("")

    // Process tool calls
    const bracketToolCalls = parseBracketToolCalls(fullContent)
    const allToolCalls = deduplicateToolCalls([...parser.getToolCalls(), ...bracketToolCalls])

    // Build content blocks
    const contentBlocks: any[] = []

    // Add text block if there's content
    if (fullContent) {
        contentBlocks.push({
            type: "text",
            text: fullContent,
        })
    }

    // Add tool_use blocks
    for (const tc of allToolCalls) {
        const toolName = tc.function?.name || ""
        const toolArgsStr = tc.function?.arguments || "{}"
        const toolId = tc.id || `toolu_${generateCompletionId().slice(8)}`

        let toolInput = {}
        try {
            toolInput = JSON.parse(toolArgsStr)
        } catch {
            // Keep empty object
        }

        contentBlocks.push({
            type: "tool_use",
            id: toolId,
            name: toolName,
            input: toolInput,
        })
    }

    // Determine stop_reason
    const stopReason = allToolCalls.length > 0 ? "tool_use" : "end_turn"

    // Calculate usage
    const usage = calculateUsageTokens(
        fullContent,
        contextUsagePercentage,
        maxInputTokens,
        requestMessages,
        requestTools
    )

    consola.debug(
        `[Anthropic Usage] ${model}: input_tokens=${usage.promptTokens}, output_tokens=${usage.completionTokens}`
    )

    return {
        id: messageId,
        type: "message",
        role: "assistant",
        content: contentBlocks,
        model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: usage.promptTokens,
            output_tokens: usage.completionTokens,
        },
    }
}

// ==================================================================================================
// Gemini Streaming
// ==================================================================================================

/**
 * Stream Kiro response to Gemini SSE format
 */
export async function* streamKiroToGemini(
    response: Response,
    model: string,
    options: {
        maxInputTokens?: number
        requestMessages?: any[]
        requestTools?: any[]
    } = {}
): AsyncGenerator<string> {
    const { maxInputTokens = config.defaultMaxInputTokens, requestMessages, requestTools } = options

    const parser = new AwsEventStreamParser()
    let meteringData: number | null = null
    let contextUsagePercentage: number | null = null
    const contentParts: string[] = []

    try {
        const reader = response.body?.getReader()
        if (!reader) {
            const emptyResponse = {
                candidates: [{
                    content: { role: "model", parts: [] },
                    finishReason: "STOP"
                }]
            }
            yield `data: ${JSON.stringify(emptyResponse)}\n\n`
            return
        }

        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            const events = parser.feed(value)

            for (const event of events) {
                if (event.type === "content") {
                    const content = event.data as string
                    contentParts.push(content)

                    // Send streaming chunk in Gemini format
                    const geminiChunk = {
                        candidates: [{
                            content: {
                                role: "model",
                                parts: [{ text: content }]
                            }
                        }]
                    }

                    yield `data: ${JSON.stringify(geminiChunk)}\n\n`

                } else if (event.type === "usage") {
                    meteringData = event.data as number

                } else if (event.type === "context_usage") {
                    contextUsagePercentage = event.data as number
                }
            }
        }

        // Combine content parts
        const fullContent = contentParts.join("")

        // Check bracket-style tool calls in full content
        const bracketToolCalls = parseBracketToolCalls(fullContent)
        const allToolCalls = deduplicateToolCalls([...parser.getToolCalls(), ...bracketToolCalls])

        // Calculate usage
        const usage = calculateUsageTokens(
            fullContent,
            contextUsagePercentage,
            maxInputTokens,
            requestMessages,
            requestTools
        )

        // Send tool calls if any
        if (allToolCalls.length > 0) {
            consola.debug(`Processing ${allToolCalls.length} tool calls for Gemini streaming response`)

            for (const tc of allToolCalls) {
                const toolName = tc.function?.name || ""
                const toolArgsStr = tc.function?.arguments || "{}"

                let toolArgs = {}
                try {
                    toolArgs = JSON.parse(toolArgsStr)
                } catch {
                    // Keep empty object
                }

                const functionCallChunk = {
                    candidates: [{
                        content: {
                            role: "model",
                            parts: [{
                                functionCall: {
                                    name: toolName,
                                    args: toolArgs
                                }
                            }]
                        }
                    }]
                }
                yield `data: ${JSON.stringify(functionCallChunk)}\n\n`
            }
        }

        // Final chunk with finish reason and usage
        const finishReason = allToolCalls.length > 0 ? "STOP" : "STOP"

        const finalChunk = {
            candidates: [{
                content: { role: "model", parts: [] },
                finishReason: finishReason
            }],
            usageMetadata: {
                promptTokenCount: usage.promptTokens,
                candidatesTokenCount: usage.completionTokens,
                totalTokenCount: usage.totalTokens,
            }
        }

        consola.debug(
            `[Gemini Usage] ${model}: promptTokenCount=${usage.promptTokens}, candidatesTokenCount=${usage.completionTokens}, totalTokenCount=${usage.totalTokens}`
        )

        yield `data: ${JSON.stringify(finalChunk)}\n\n`

    } catch (e) {
        consola.error(`Error during Gemini streaming: ${e}`)
        throw e
    }
}

/**
 * Collect stream response into single Gemini response
 */
export async function collectGeminiResponse(
    response: Response,
    model: string,
    options: {
        maxInputTokens?: number
        requestMessages?: any[]
        requestTools?: any[]
    } = {}
): Promise<any> {
    const { maxInputTokens = config.defaultMaxInputTokens, requestMessages, requestTools } = options

    const parser = new AwsEventStreamParser()
    let meteringData: number | null = null
    let contextUsagePercentage: number | null = null
    const contentParts: string[] = []

    try {
        const reader = response.body?.getReader()
        if (!reader) {
            return {
                candidates: [{
                    content: { role: "model", parts: [] },
                    finishReason: "STOP"
                }],
                usageMetadata: {
                    promptTokenCount: 0,
                    candidatesTokenCount: 0,
                    totalTokenCount: 0,
                }
            }
        }

        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            const events = parser.feed(value)

            for (const event of events) {
                if (event.type === "content") {
                    contentParts.push(event.data as string)
                } else if (event.type === "usage") {
                    meteringData = event.data as number
                } else if (event.type === "context_usage") {
                    contextUsagePercentage = event.data as number
                }
            }
        }
    } catch (e) {
        consola.error(`Error collecting Gemini response: ${e}`)
    }

    // Combine content
    const fullContent = contentParts.join("")

    // Process tool calls
    const bracketToolCalls = parseBracketToolCalls(fullContent)
    const allToolCalls = deduplicateToolCalls([...parser.getToolCalls(), ...bracketToolCalls])

    // Build parts array
    const parts: any[] = []

    // Add text part if there's content
    if (fullContent) {
        parts.push({ text: fullContent })
    }

    // Add function call parts
    for (const tc of allToolCalls) {
        const toolName = tc.function?.name || ""
        const toolArgsStr = tc.function?.arguments || "{}"

        let toolArgs = {}
        try {
            toolArgs = JSON.parse(toolArgsStr)
        } catch {
            // Keep empty object
        }

        parts.push({
            functionCall: {
                name: toolName,
                args: toolArgs
            }
        })
    }

    // Calculate usage
    const usage = calculateUsageTokens(
        fullContent,
        contextUsagePercentage,
        maxInputTokens,
        requestMessages,
        requestTools
    )

    consola.debug(
        `[Gemini Usage] ${model}: promptTokenCount=${usage.promptTokens}, candidatesTokenCount=${usage.completionTokens}, totalTokenCount=${usage.totalTokens}`
    )

    return {
        candidates: [{
            content: {
                role: "model",
                parts: parts
            },
            finishReason: "STOP"
        }],
        usageMetadata: {
            promptTokenCount: usage.promptTokens,
            candidatesTokenCount: usage.completionTokens,
            totalTokenCount: usage.totalTokens,
        }
    }
}

