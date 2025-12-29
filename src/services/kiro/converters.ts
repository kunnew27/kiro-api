/**
 * Request Converters
 * Convert OpenAI/Anthropic formats to Kiro API format
 */

import consola from "consola"
import { getInternalModelId, config } from "~/lib/config"
import { generateToolCallId } from "~/lib/utils"
import type { OpenAIChatMessage, OpenAIChatRequest, OpenAITool } from "~/routes/openai/types"
import type { AnthropicMessage, AnthropicMessagesRequest, AnthropicTool } from "~/routes/anthropic/types"
import type { GeminiGenerateContentRequest, GeminiContent, GeminiPart, GeminiTool } from "~/routes/gemini/types"

// ==================================================================================================
// Convert Tools to Kiro Format (like kiro2Api's convertToQTool)
// ==================================================================================================

interface KiroToolSpec {
    toolSpecification: {
        name: string
        description: string
        inputSchema: { json: any }
    }
}

/**
 * Convert any tool format directly to Kiro format (toolSpecification)
 * Based on kiro2Api's convertToQTool - handles 7 formats
 */
export function convertToKiroTools(tools: any[] | null | undefined): KiroToolSpec[] {
    if (!tools || tools.length === 0) {
        return []
    }

    const result: KiroToolSpec[] = []

    for (const tool of tools) {
        if (!tool || typeof tool !== "object") {
            continue
        }

        const toolName = getToolName(tool)

        // Skip web_search tools
        if (toolName === "web_search" || toolName === "websearch") {
            continue
        }

        const converted = convertSingleToolToKiro(tool)
        if (converted) {
            result.push(converted)
        }
    }

    return result
}

function getToolName(tool: any): string | null {
    // OpenAI format
    if (tool.function && typeof tool.function === "object") {
        return tool.function.name || null
    }
    // Kiro native
    if (tool.toolSpecification && typeof tool.toolSpecification === "object") {
        return tool.toolSpecification.name || null
    }
    // Anthropic/flat format
    if (tool.name) return tool.name
    // ID format
    if (tool.id) return tool.id
    return null
}

function convertSingleToolToKiro(tool: any): KiroToolSpec | null {
    // Format 1: OpenAI format { type: "function", function: { name, parameters } }
    if (tool.function && typeof tool.function === "object") {
        return {
            toolSpecification: {
                name: tool.function.name,
                description: tool.function.description || "",
                inputSchema: { json: tool.function.parameters || { type: "object", properties: {} } },
            },
        }
    }

    // Format 2: Kiro native format { toolSpecification: {...} }
    if (tool.toolSpecification && typeof tool.toolSpecification === "object") {
        return tool as KiroToolSpec
    }

    // Format 3: Anthropic format { name, description, input_schema }
    if (tool.name && (tool.input_schema || tool.schema)) {
        const schema = tool.input_schema || tool.schema
        return {
            toolSpecification: {
                name: tool.name,
                description: tool.description || "",
                inputSchema: { json: schema },
            },
        }
    }

    // Format 4: Flat format { name, parameters }
    if (tool.name && tool.parameters) {
        return {
            toolSpecification: {
                name: tool.name,
                description: tool.description || "",
                inputSchema: { json: tool.parameters },
            },
        }
    }

    // Format 5: ID + parameters { id, parameters }
    if (tool.id && tool.parameters) {
        return {
            toolSpecification: {
                name: tool.id,
                description: tool.description || "",
                inputSchema: { json: tool.parameters },
            },
        }
    }

    // Format 6: ID + schema { id, schema }
    if (tool.id && tool.schema) {
        return {
            toolSpecification: {
                name: tool.id,
                description: tool.description || "",
                inputSchema: { json: tool.schema },
            },
        }
    }

    // Format 7: Flat format with only name and description (no params)
    if (tool.name) {
        return {
            toolSpecification: {
                name: tool.name,
                description: tool.description || "",
                inputSchema: { json: { type: "object", properties: {} } },
            },
        }
    }

    consola.warn(`Unknown tool format, skipping: ${JSON.stringify(tool).slice(0, 100)}`)
    return null
}

// ==================================================================================================
// Text Content Extraction
// ==================================================================================================

/**
 * Extract text content from various formats
 */
export function extractTextContent(content: any): string {
    if (content === null || content === undefined) {
        return ""
    }
    if (typeof content === "string") {
        return content
    }
    if (Array.isArray(content)) {
        const textParts: string[] = []
        for (const item of content) {
            if (typeof item === "object" && item !== null) {
                if (item.type === "text") {
                    textParts.push(item.text || "")
                } else if ("text" in item) {
                    textParts.push(item.text)
                }
            } else if (typeof item === "string") {
                textParts.push(item)
            }
        }
        return textParts.join("")
    }
    return String(content)
}

// ==================================================================================================
// Image Extraction
// ==================================================================================================

interface KiroImage {
    format: string
    source: {
        bytes: string
    }
}

/**
 * Extract images from content and convert to Kiro API format
 */
export function extractImagesFromContent(content: any): KiroImage[] {
    const images: KiroImage[] = []

    if (!Array.isArray(content)) {
        return images
    }

    for (let idx = 0; idx < content.length; idx++) {
        const item = content[idx]
        if (typeof item !== "object" || item === null) continue

        const itemType = item.type

        try {
            // Anthropic format: {"type": "image", "source": {...}}
            if (itemType === "image") {
                const source = item.source || {}
                if (source.type === "base64") {
                    const mediaType = source.media_type || "image/png"
                    const base64Data = source.data || ""

                    if (!base64Data) {
                        consola.warn(`Image block ${idx} has empty base64 data, skipping`)
                        continue
                    }

                    // Extract format from media_type: 'image/png' -> 'png'
                    const formatName = mediaType.split("/").pop() || "png"

                    images.push({
                        format: formatName,
                        source: { bytes: base64Data },
                    })
                    consola.debug(`Extracted Anthropic image #${idx}: ${formatName}, size: ${base64Data.length} chars`)
                }
            }

            // OpenAI format: {"type": "image_url", "image_url": {"url": "data:..."}}
            else if (itemType === "image_url") {
                const imageUrl = item.image_url || {}
                const url = imageUrl.url || ""

                if (!url) {
                    consola.warn(`Image block ${idx} has empty URL, skipping`)
                    continue
                }

                // Handle data URL: data:image/png;base64,iVBORw0KG...
                if (url.startsWith("data:")) {
                    try {
                        const [header, base64Data] = url.split(",", 2)
                        const mediaPart = header.split(":")[1].split(";")[0]
                        const formatName = mediaPart.split("/").pop() || "png"

                        if (!base64Data) {
                            consola.warn(`Image block ${idx} has empty base64 data after parsing, skipping`)
                            continue
                        }

                        images.push({
                            format: formatName,
                            source: { bytes: base64Data },
                        })
                        consola.debug(`Extracted OpenAI image #${idx}: ${formatName}, size: ${base64Data.length} chars`)
                    } catch (e) {
                        consola.warn(`Failed to parse data URL in image block ${idx}: ${e}`)
                    }
                } else {
                    consola.warn(`Image block ${idx} has URL (not data URL), skipping: ${url.slice(0, 50)}...`)
                }
            }
        } catch (e) {
            consola.error(`Error extracting image from block ${idx}: ${e}`)
        }
    }

    if (images.length > 0) {
        consola.info(`Successfully extracted ${images.length} image(s) from content`)
    }

    return images
}

// ==================================================================================================
// Tool Results Extraction
// ==================================================================================================

interface KiroToolResult {
    content: Array<{ text: string }>
    status: string
    toolUseId: string
}

/**
 * Extract tool results from message content
 */
export function extractToolResults(content: any): KiroToolResult[] {
    const toolResults: KiroToolResult[] = []

    if (Array.isArray(content)) {
        for (const item of content) {
            if (typeof item === "object" && item !== null && item.type === "tool_result") {
                toolResults.push({
                    content: [{ text: extractTextContent(item.content) }],
                    status: "success",
                    toolUseId: item.tool_use_id || "",
                })
            }
        }
    }

    return toolResults
}

// ==================================================================================================
// Tool Uses Extraction
// ==================================================================================================

interface KiroToolUse {
    name: string
    input: any
    toolUseId: string
}

/**
 * Extract tool uses from assistant message
 */
export function extractToolUses(msg: OpenAIChatMessage): KiroToolUse[] {
    const toolUses: KiroToolUse[] = []

    // From tool_calls field
    if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
            if (typeof tc === "object" && tc !== null) {
                const func = tc.function || {}
                let input = {}
                try {
                    input = JSON.parse(func.arguments || "{}")
                } catch {
                    // Keep empty object
                }
                toolUses.push({
                    name: func.name || "",
                    input,
                    toolUseId: tc.id || "",
                })
            }
        }
    }

    // From content (if there are tool_use blocks)
    if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
            if (typeof item === "object" && item !== null && item.type === "tool_use") {
                toolUses.push({
                    name: item.name || "",
                    input: item.input || {},
                    toolUseId: item.id || "",
                })
            }
        }
    }

    return toolUses
}

// ==================================================================================================
// Message Merging
// ==================================================================================================

/**
 * Merge adjacent messages with same role and handle tool messages
 */
export function mergeAdjacentMessages(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
    if (!messages.length) return []

    // First convert tool messages to user messages with tool_results
    const processed: OpenAIChatMessage[] = []
    let pendingToolResults: any[] = []

    for (const msg of messages) {
        if (msg.role === "tool") {
            // Collect tool results
            pendingToolResults.push({
                type: "tool_result",
                tool_use_id: msg.tool_call_id || "",
                content: extractTextContent(msg.content) || "(empty result)",
            })
            consola.debug(`Collected tool result for tool_call_id=${msg.tool_call_id}`)
        } else {
            // If there are pending tool results, create user message with them
            if (pendingToolResults.length > 0) {
                processed.push({
                    role: "user",
                    content: [...pendingToolResults],
                })
                consola.debug(`Created user message with ${pendingToolResults.length} tool results`)
                pendingToolResults = []
            }
            processed.push(msg)
        }
    }

    // Handle remaining tool results
    if (pendingToolResults.length > 0) {
        processed.push({
            role: "user",
            content: [...pendingToolResults],
        })
        consola.debug(`Created final user message with ${pendingToolResults.length} tool results`)
    }

    // Now merge adjacent messages with same role
    const merged: OpenAIChatMessage[] = []

    for (const msg of processed) {
        if (merged.length === 0) {
            merged.push({ ...msg })
            continue
        }

        const last = merged[merged.length - 1]
        if (msg.role === last.role) {
            // Merge content
            if (Array.isArray(last.content) && Array.isArray(msg.content)) {
                last.content = [...last.content, ...msg.content]
            } else if (Array.isArray(last.content)) {
                last.content = [...last.content, { type: "text", text: extractTextContent(msg.content) }]
            } else if (Array.isArray(msg.content)) {
                last.content = [{ type: "text", text: extractTextContent(last.content) }, ...msg.content]
            } else {
                const lastText = extractTextContent(last.content)
                const currentText = extractTextContent(msg.content)
                last.content = `${lastText}\n${currentText}`
            }

            // Merge tool_calls for assistant messages
            if (msg.role === "assistant" && msg.tool_calls) {
                if (!last.tool_calls) {
                    last.tool_calls = []
                }
                last.tool_calls = [...last.tool_calls, ...msg.tool_calls]
                consola.debug(`Merged tool_calls: added ${msg.tool_calls.length} tool calls`)
            }

            consola.debug(`Merged adjacent messages with role ${msg.role}`)
        } else {
            merged.push({ ...msg })
        }
    }

    return merged
}

// ==================================================================================================
// Build Kiro History
// ==================================================================================================

interface KiroHistoryEntry {
    userInputMessage?: {
        content: string
        modelId: string
        origin: string
        images?: KiroImage[]
        userInputMessageContext?: {
            toolResults?: KiroToolResult[]
        }
    }
    assistantResponseMessage?: {
        content: string
        toolUses?: KiroToolUse[]
    }
}

/**
 * Build history array for Kiro API from OpenAI messages
 */
export function buildKiroHistory(messages: OpenAIChatMessage[], modelId: string): KiroHistoryEntry[] {
    const history: KiroHistoryEntry[] = []

    for (const msg of messages) {
        if (msg.role === "user") {
            const content = extractTextContent(msg.content)

            const userInput: KiroHistoryEntry["userInputMessage"] = {
                content,
                modelId,
                origin: "AI_EDITOR",
            }

            // Extract images
            const images = extractImagesFromContent(msg.content)
            if (images.length > 0) {
                userInput.images = images
                consola.debug(`Added ${images.length} image(s) to user message in history`)
            }

            // Handle tool_results
            const toolResults = extractToolResults(msg.content)
            if (toolResults.length > 0) {
                userInput.userInputMessageContext = { toolResults }
            }

            history.push({ userInputMessage: userInput })

        } else if (msg.role === "assistant") {
            const content = extractTextContent(msg.content)

            const assistantResponse: KiroHistoryEntry["assistantResponseMessage"] = {
                content,
            }

            // Handle tool_calls
            const toolUses = extractToolUses(msg)
            if (toolUses.length > 0) {
                assistantResponse.toolUses = toolUses
            }

            history.push({ assistantResponseMessage: assistantResponse })
        }
        // System messages are handled separately
    }

    return history
}

// ==================================================================================================
// Process Tools with Long Descriptions
// ==================================================================================================

/**
 * Process tools with long descriptions
 * Moves long descriptions to system prompt
 */
export function processToolsWithLongDescriptions(
    tools: OpenAITool[] | null | undefined
): { tools: OpenAITool[] | null; documentation: string } {
    if (!tools || tools.length === 0) {
        return { tools: null, documentation: "" }
    }

    // If limit is disabled (0), return tools unchanged
    if (config.toolDescriptionMaxLength <= 0) {
        return { tools, documentation: "" }
    }

    const toolDocParts: string[] = []
    const processedTools: OpenAITool[] = []

    for (const tool of tools) {
        if (tool.type !== "function") {
            processedTools.push(tool)
            continue
        }

        const description = tool.function.description || ""

        if (description.length <= config.toolDescriptionMaxLength) {
            processedTools.push(tool)
        } else {
            const toolName = tool.function.name

            consola.debug(
                `Tool '${toolName}' has long description (${description.length} chars > ${config.toolDescriptionMaxLength}), moving to system prompt`
            )

            // Create documentation for system prompt
            toolDocParts.push(`## Tool: ${toolName}\n\n${description}`)

            // Create tool with reference description
            processedTools.push({
                type: "function",
                function: {
                    name: tool.function.name,
                    description: `[Full documentation in system prompt under '## Tool: ${toolName}']`,
                    parameters: tool.function.parameters,
                },
            })
        }
    }

    // Build final documentation
    let documentation = ""
    if (toolDocParts.length > 0) {
        documentation =
            "\n\n---\n" +
            "# Tool Documentation\n" +
            "The following tools have detailed documentation that couldn't fit in the tool definition.\n\n" +
            toolDocParts.join("\n\n---\n\n")
    }

    return {
        tools: processedTools.length > 0 ? processedTools : null,
        documentation,
    }
}

// ==================================================================================================
// Build User Input Context
// ==================================================================================================

interface KiroUserInputContext {
    tools?: KiroToolSpec[]
    toolResults?: KiroToolResult[]
}

/**
 * Build userInputMessageContext for current message
 * Uses convertToKiroTools to handle any tool format directly
 */
export function buildUserInputContext(
    tools: any[] | null | undefined,
    currentMessage: OpenAIChatMessage
): KiroUserInputContext | null {
    const context: KiroUserInputContext = {}

    // Add tools if present - convertToKiroTools handles all formats
    if (tools && tools.length > 0) {
        const kiroTools = convertToKiroTools(tools)
        if (kiroTools.length > 0) {
            context.tools = kiroTools
        }
    }

    // Handle tool_results in current message
    const toolResults = extractToolResults(currentMessage.content)
    if (toolResults.length > 0) {
        context.toolResults = toolResults
    }

    return Object.keys(context).length > 0 ? context : null
}

// ==================================================================================================
// Build Kiro Payload
// ==================================================================================================

export interface KiroPayload {
    conversationState: {
        chatTriggerType: string
        conversationId: string
        currentMessage: {
            userInputMessage: {
                content: string
                modelId: string
                origin: string
                images?: KiroImage[]
                userInputMessageContext?: KiroUserInputContext
            }
        }
        history?: KiroHistoryEntry[]
    }
    profileArn?: string
}

/**
 * Build complete payload for Kiro API
 */
export function buildKiroPayload(
    requestData: OpenAIChatRequest,
    conversationId: string,
    profileArn: string
): KiroPayload {
    const messages = [...requestData.messages]

    // Process tools with long descriptions
    const { tools: processedTools, documentation: toolDocumentation } = processToolsWithLongDescriptions(
        requestData.tools
    )

    // Extract system prompt
    let systemPrompt = ""
    const nonSystemMessages: OpenAIChatMessage[] = []

    for (const msg of messages) {
        if (msg.role === "system") {
            systemPrompt += extractTextContent(msg.content) + "\n"
        } else {
            nonSystemMessages.push(msg)
        }
    }
    systemPrompt = systemPrompt.trim()

    // Add tool documentation to system prompt
    if (toolDocumentation) {
        systemPrompt = systemPrompt ? systemPrompt + toolDocumentation : toolDocumentation.trim()
    }

    // Merge adjacent messages with same role
    const mergedMessages = mergeAdjacentMessages(nonSystemMessages)

    if (mergedMessages.length === 0) {
        throw new Error("No messages to send")
    }

    // Get internal model ID
    const modelId = getInternalModelId(requestData.model)

    // Build history (all messages except last)
    const historyMessages = mergedMessages.length > 1 ? mergedMessages.slice(0, -1) : []

    // If there's a system prompt, add it to first user message in history
    if (systemPrompt && historyMessages.length > 0) {
        const firstMsg = historyMessages[0]
        if (firstMsg.role === "user") {
            const originalContent = extractTextContent(firstMsg.content)
            firstMsg.content = `${systemPrompt}\n\n${originalContent}`
        }
    }

    const history = buildKiroHistory(historyMessages, modelId)

    // Current message (last one)
    const currentMessage = mergedMessages[mergedMessages.length - 1]
    let currentContent = extractTextContent(currentMessage.content)

    // If system prompt exists but history is empty, add to current message
    if (systemPrompt && history.length === 0) {
        currentContent = `${systemPrompt}\n\n${currentContent}`
    }

    // If current message is assistant, add to history and create "Continue" user message
    if (currentMessage.role === "assistant") {
        history.push({
            assistantResponseMessage: { content: currentContent },
        })
        currentContent = "Continue"
    }

    // If content is empty
    if (!currentContent) {
        currentContent = "Continue"
    }

    // Build userInputMessage
    const userInputMessage: KiroPayload["conversationState"]["currentMessage"]["userInputMessage"] = {
        content: currentContent,
        modelId,
        origin: "AI_EDITOR",
    }

    // Extract images from current message
    if (currentMessage.role !== "assistant") {
        const currentImages = extractImagesFromContent(currentMessage.content)
        if (currentImages.length > 0) {
            userInputMessage.images = currentImages
            consola.debug(`Added ${currentImages.length} image(s) to current message`)
        }
    }

    // Add tools and tool_results
    const userInputContext = buildUserInputContext(processedTools, currentMessage)
    if (userInputContext) {
        userInputMessage.userInputMessageContext = userInputContext
    }

    // Build final payload
    const payload: KiroPayload = {
        conversationState: {
            chatTriggerType: "MANUAL",
            conversationId,
            currentMessage: { userInputMessage },
        },
    }

    // Add history only if not empty
    if (history.length > 0) {
        payload.conversationState.history = history
    }

    // Add profileArn
    if (profileArn) {
        payload.profileArn = profileArn
    }

    return payload
}

// ==================================================================================================
// Anthropic -> OpenAI Conversion
// ==================================================================================================

/**
 * Convert Anthropic tools to OpenAI format
 */
export function convertAnthropicToolsToOpenAI(tools: AnthropicTool[] | null | undefined): OpenAITool[] | null {
    if (!tools || tools.length === 0) {
        return null
    }

    return tools.map(tool => ({
        type: "function" as const,
        function: {
            name: tool.name,
            description: tool.description || undefined,
            parameters: tool.input_schema,
        },
    }))
}

/**
 * Extract Anthropic system prompt
 */
export function extractAnthropicSystemPrompt(system: any): string {
    if (!system) return ""

    if (typeof system === "string") {
        return system
    }

    if (Array.isArray(system)) {
        const textParts: string[] = []
        for (const block of system) {
            if (typeof block === "object" && block !== null && block.type === "text") {
                textParts.push(block.text || "")
            }
        }
        return textParts.join("\n")
    }

    return String(system)
}

/**
 * Convert Anthropic content to OpenAI format
 */
export function convertAnthropicContentToOpenAI(
    content: any,
    role: string
): { textContent: string | any[] | null; toolCalls: any[] | null; toolResults: any[] | null } {
    if (typeof content === "string") {
        return { textContent: content, toolCalls: null, toolResults: null }
    }

    if (!Array.isArray(content)) {
        return { textContent: content ? String(content) : null, toolCalls: null, toolResults: null }
    }

    const contentBlocks: any[] = []
    const toolCalls: any[] = []
    const toolResults: any[] = []

    for (let idx = 0; idx < content.length; idx++) {
        const block = content[idx]
        if (typeof block !== "object" || block === null) continue

        const blockType = block.type

        try {
            if (blockType === "text") {
                contentBlocks.push({ type: "text", text: block.text || "" })
            } else if (blockType === "image") {
                // Convert Anthropic image format to OpenAI image_url format
                if (block.source && block.source.type === "base64") {
                    const mediaType = block.source.media_type || "image/png"
                    const base64Data = block.source.data || ""

                    // Validate base64 data exists
                    if (!base64Data) {
                        consola.warn(`Image block ${idx} has empty base64 data, skipping`)
                        continue
                    }

                    // Extract format for logging: 'image/png' -> 'png'
                    const formatName = mediaType.split("/").pop() || "png"

                    contentBlocks.push({
                        type: "image_url",
                        image_url: {
                            url: `data:${mediaType};base64,${base64Data}`
                        }
                    })

                    consola.debug(
                        `Converted Anthropic image #${idx} to OpenAI format: ${formatName}, ` +
                        `size: ${base64Data.length} chars`
                    )
                } else {
                    consola.warn(`Image block ${idx} has unsupported source type, skipping`)
                }
            } else if (blockType === "tool_use") {
                // Assistant's tool call
                toolCalls.push({
                    id: block.id || "",
                    type: "function",
                    function: {
                        name: block.name || "",
                        arguments: JSON.stringify(block.input || {}),
                    },
                })
            } else if (blockType === "tool_result") {
                // User's tool result
                toolResults.push({
                    type: "tool_result",
                    tool_use_id: block.tool_use_id || "",
                    content: extractToolResultContent(block.content),
                    is_error: block.is_error || false,
                })
            } else if (blockType === "thinking") {
                // Thinking block - add to text with marker
                const thinkingText = block.thinking || ""
                if (thinkingText) {
                    contentBlocks.push({ type: "text", text: `<thinking>${thinkingText}</thinking>` })
                }
            }
        } catch (e) {
            consola.error(`Error processing content block ${idx}: ${e}`)
            continue
        }
    }

    // If we have images, return as array to preserve them for extractImagesFromContent()
    // If only text, return as string for compatibility
    let textContent: string | any[] | null = null
    if (contentBlocks.length > 0) {
        const hasImages = contentBlocks.some(b => b.type === "image")
        if (hasImages) {
            // Return array with both text and image blocks
            textContent = contentBlocks
        } else {
            // Only text blocks - join into string
            textContent = contentBlocks.map(b => b.text || "").join("\n")
        }
    }

    return {
        textContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : null,
        toolResults: toolResults.length > 0 ? toolResults : null,
    }
}

/**
 * Extract text content from tool_result
 */
function extractToolResultContent(content: any): string {
    if (!content) return ""
    if (typeof content === "string") return content

    if (Array.isArray(content)) {
        const textParts: string[] = []
        for (const item of content) {
            if (typeof item === "object" && item !== null && item.type === "text") {
                textParts.push(item.text || "")
            } else if (typeof item === "string") {
                textParts.push(item)
            }
        }
        return textParts.join("\n")
    }

    return String(content)
}

/**
 * Convert Anthropic messages to OpenAI format
 */
export function convertAnthropicMessagesToOpenAI(
    messages: AnthropicMessage[],
    system?: any
): OpenAIChatMessage[] {
    const openaiMessages: OpenAIChatMessage[] = []

    // Add system prompt if present
    const systemPrompt = extractAnthropicSystemPrompt(system)
    if (systemPrompt) {
        openaiMessages.push({ role: "system", content: systemPrompt })
    }

    for (const msg of messages) {
        const { textContent, toolCalls, toolResults } = convertAnthropicContentToOpenAI(msg.content, msg.role)

        // If content is tool_results, create user message with them
        if (toolResults && toolResults.length > 0) {
            openaiMessages.push({
                role: "user",
                content: toolResults,
            })
        } else if (msg.role === "assistant") {
            openaiMessages.push({
                role: "assistant",
                content: textContent || "",
                tool_calls: toolCalls || undefined,
            })
        } else {
            openaiMessages.push({
                role: "user",
                content: textContent || "",
            })
        }
    }

    return openaiMessages
}

/**
 * Convert Anthropic MessagesRequest to OpenAI ChatCompletionRequest
 */
export function convertAnthropicToOpenAIRequest(anthropicRequest: AnthropicMessagesRequest): OpenAIChatRequest {
    // Convert messages
    const openaiMessages = convertAnthropicMessagesToOpenAI(
        anthropicRequest.messages,
        anthropicRequest.system
    )

    // Convert tools
    const openaiTools = convertAnthropicToolsToOpenAI(anthropicRequest.tools)

    // Convert tool_choice
    let openaiToolChoice: any = undefined
    if (anthropicRequest.tool_choice) {
        const tcType = anthropicRequest.tool_choice.type
        if (tcType === "auto") {
            openaiToolChoice = "auto"
        } else if (tcType === "any") {
            openaiToolChoice = "required"
        } else if (tcType === "tool") {
            openaiToolChoice = {
                type: "function",
                function: { name: anthropicRequest.tool_choice.name },
            }
        } else if (tcType === "none") {
            openaiToolChoice = "none"
        }
    }

    return {
        model: anthropicRequest.model,
        messages: openaiMessages,
        max_tokens: anthropicRequest.max_tokens,
        temperature: anthropicRequest.temperature,
        top_p: anthropicRequest.top_p,
        stop: anthropicRequest.stop_sequences,
        tools: openaiTools || undefined,
        tool_choice: openaiToolChoice,
        stream: anthropicRequest.stream,
    }
}

// ==================================================================================================
// Gemini -> OpenAI Conversion
// ==================================================================================================

/**
 * Extract text from Gemini parts
 */
function extractTextFromGeminiParts(parts: GeminiPart[]): string {
    return parts
        .filter(p => p.text)
        .map(p => p.text!)
        .join("")
}

/**
 * Convert Gemini tools to OpenAI format
 */
export function convertGeminiToolsToOpenAI(tools: GeminiTool[] | undefined): OpenAITool[] | null {
    if (!tools || tools.length === 0) {
        return null
    }

    const openaiTools: OpenAITool[] = []

    for (const tool of tools) {
        if (tool.functionDeclarations) {
            for (const func of tool.functionDeclarations) {
                openaiTools.push({
                    type: "function",
                    function: {
                        name: func.name,
                        description: func.description || undefined,
                        parameters: func.parameters || { type: "object", properties: {} },
                    },
                })
            }
        }
    }

    return openaiTools.length > 0 ? openaiTools : null
}

/**
 * Convert Gemini content to OpenAI messages
 */
export function convertGeminiContentToOpenAI(
    contents: GeminiContent[],
    systemInstruction?: { parts: GeminiPart[] }
): OpenAIChatMessage[] {
    const openaiMessages: OpenAIChatMessage[] = []

    // Add system prompt if present
    if (systemInstruction && systemInstruction.parts.length > 0) {
        const systemText = extractTextFromGeminiParts(systemInstruction.parts)
        if (systemText) {
            openaiMessages.push({ role: "system", content: systemText })
        }
    }

    for (const content of contents) {
        const role = content.role === "model" ? "assistant" : "user"
        const textParts: string[] = []
        const toolCalls: any[] = []
        const contentArray: any[] = []

        for (const part of content.parts) {
            // Handle text
            if (part.text) {
                textParts.push(part.text)
            }

            // Handle inline images
            if (part.inlineData) {
                contentArray.push({
                    type: "image_url",
                    image_url: {
                        url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
                    },
                })
            }

            // Handle function calls (from model)
            if (part.functionCall) {
                toolCalls.push({
                    id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                    type: "function",
                    function: {
                        name: part.functionCall.name,
                        arguments: JSON.stringify(part.functionCall.args || {}),
                    },
                })
            }

            // Handle function responses (from user)
            if (part.functionResponse) {
                // This becomes a tool result in the user message
                contentArray.push({
                    type: "tool_result",
                    tool_use_id: part.functionResponse.name, // Use function name as ID
                    content: part.functionResponse.response.content,
                })
            }
        }

        // Build the message
        if (role === "assistant") {
            const msg: OpenAIChatMessage = {
                role: "assistant",
                content: textParts.join("") || null,
            }
            if (toolCalls.length > 0) {
                msg.tool_calls = toolCalls
            }
            openaiMessages.push(msg)
        } else {
            // User message
            if (contentArray.length > 0) {
                // Has images or tool results
                if (textParts.length > 0) {
                    contentArray.unshift({ type: "text", text: textParts.join("") })
                }
                openaiMessages.push({ role: "user", content: contentArray })
            } else {
                openaiMessages.push({ role: "user", content: textParts.join("") })
            }
        }
    }

    return openaiMessages
}

/**
 * Convert Gemini GenerateContentRequest to OpenAI ChatCompletionRequest
 */
export function convertGeminiToOpenAIRequest(
    geminiRequest: GeminiGenerateContentRequest,
    model: string
): OpenAIChatRequest {
    // Convert messages
    const openaiMessages = convertGeminiContentToOpenAI(
        geminiRequest.contents,
        geminiRequest.systemInstruction
    )

    // Convert tools
    const openaiTools = convertGeminiToolsToOpenAI(geminiRequest.tools)

    // Convert tool_choice from toolConfig
    let openaiToolChoice: any = undefined
    if (geminiRequest.toolConfig?.functionCallingConfig) {
        const mode = geminiRequest.toolConfig.functionCallingConfig.mode
        if (mode === "AUTO") {
            openaiToolChoice = "auto"
        } else if (mode === "ANY") {
            openaiToolChoice = "required"
        } else if (mode === "NONE") {
            openaiToolChoice = "none"
        }
    }

    // Extract generation config
    const genConfig = geminiRequest.generationConfig || {}

    return {
        model: model,
        messages: openaiMessages,
        max_tokens: genConfig.maxOutputTokens,
        temperature: genConfig.temperature,
        top_p: genConfig.topP,
        stop: genConfig.stopSequences,
        tools: openaiTools || undefined,
        tool_choice: openaiToolChoice,
        stream: false, // Will be set by handler
    }
}

// ==================================================================================================
// Response Converters (from AIClient-2-API patterns)
// ==================================================================================================

/**
 * Convert OpenAI response to Anthropic response format
 */
export function convertOpenAIResponseToAnthropic(openaiResponse: any, model: string): any {
    const choice = openaiResponse.choices?.[0]
    const message = choice?.message || {}
    const usage = openaiResponse.usage || {}

    // Build content blocks
    const contentBlocks: any[] = []

    // Add text block if present
    if (message.content) {
        contentBlocks.push({
            type: "text",
            text: message.content,
        })
    }

    // Convert tool_calls to tool_use blocks
    if (message.tool_calls && message.tool_calls.length > 0) {
        for (const tc of message.tool_calls) {
            let input = {}
            try {
                input = JSON.parse(tc.function?.arguments || "{}")
            } catch {
                // Keep empty object
            }

            contentBlocks.push({
                type: "tool_use",
                id: tc.id || `toolu_${Date.now()}`,
                name: tc.function?.name || "",
                input,
            })
        }
    }

    // Map finish reason
    let stopReason = "end_turn"
    if (choice?.finish_reason === "tool_calls") {
        stopReason = "tool_use"
    } else if (choice?.finish_reason === "length") {
        stopReason = "max_tokens"
    } else if (choice?.finish_reason === "content_filter") {
        stopReason = "stop_sequence"
    }

    return {
        id: openaiResponse.id ? `msg_${openaiResponse.id.slice(8)}` : `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        content: contentBlocks,
        model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: usage.prompt_tokens || 0,
            output_tokens: usage.completion_tokens || 0,
        },
    }
}

/**
 * Convert OpenAI response to Gemini response format
 */
export function convertOpenAIResponseToGemini(openaiResponse: any, _model: string): any {
    const choice = openaiResponse.choices?.[0]
    const message = choice?.message || {}
    const usage = openaiResponse.usage || {}

    // Build parts array
    const parts: any[] = []

    // Add text part if present
    if (message.content) {
        parts.push({ text: message.content })
    }

    // Convert tool_calls to functionCall parts
    if (message.tool_calls && message.tool_calls.length > 0) {
        for (const tc of message.tool_calls) {
            let args = {}
            try {
                args = JSON.parse(tc.function?.arguments || "{}")
            } catch {
                // Keep empty object
            }

            parts.push({
                functionCall: {
                    name: tc.function?.name || "",
                    args,
                },
            })
        }
    }

    // Map finish reason
    let finishReason = "STOP"
    if (choice?.finish_reason === "length") {
        finishReason = "MAX_TOKENS"
    } else if (choice?.finish_reason === "content_filter") {
        finishReason = "SAFETY"
    }

    return {
        candidates: [{
            content: {
                role: "model",
                parts,
            },
            finishReason,
        }],
        usageMetadata: {
            promptTokenCount: usage.prompt_tokens || 0,
            candidatesTokenCount: usage.completion_tokens || 0,
            totalTokenCount: usage.total_tokens || 0,
        },
    }
}

/**
 * Convert Anthropic response to OpenAI response format
 */
export function convertAnthropicResponseToOpenAI(anthropicResponse: any, model: string): any {
    const content = anthropicResponse.content || []
    const usage = anthropicResponse.usage || {}

    // Extract text and tool calls
    let textContent = ""
    const toolCalls: any[] = []

    for (const block of content) {
        if (block.type === "text") {
            textContent += block.text || ""
        } else if (block.type === "tool_use") {
            toolCalls.push({
                id: block.id || `call_${Date.now()}`,
                type: "function",
                function: {
                    name: block.name || "",
                    arguments: JSON.stringify(block.input || {}),
                },
            })
        }
    }

    // Map finish reason
    let finishReason = "stop"
    if (anthropicResponse.stop_reason === "tool_use") {
        finishReason = "tool_calls"
    } else if (anthropicResponse.stop_reason === "max_tokens") {
        finishReason = "length"
    } else if (anthropicResponse.stop_reason === "stop_sequence") {
        finishReason = "stop"
    }

    const message: any = {
        role: "assistant",
        content: textContent || null,
    }

    if (toolCalls.length > 0) {
        message.tool_calls = toolCalls
    }

    return {
        id: anthropicResponse.id ? `chatcmpl-${anthropicResponse.id.slice(4)}` : `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: finishReason,
        }],
        usage: {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
        },
    }
}

/**
 * Convert Gemini response to OpenAI response format
 */
export function convertGeminiResponseToOpenAI(geminiResponse: any, model: string): any {
    const candidate = geminiResponse.candidates?.[0]
    const content = candidate?.content
    const parts = content?.parts || []
    const usageMetadata = geminiResponse.usageMetadata || {}

    // Extract text and function calls
    let textContent = ""
    const toolCalls: any[] = []

    for (const part of parts) {
        if (part.text) {
            textContent += part.text
        } else if (part.functionCall) {
            toolCalls.push({
                id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                type: "function",
                function: {
                    name: part.functionCall.name || "",
                    arguments: JSON.stringify(part.functionCall.args || {}),
                },
            })
        }
    }

    // Map finish reason
    let finishReason = "stop"
    if (candidate?.finishReason === "MAX_TOKENS") {
        finishReason = "length"
    } else if (candidate?.finishReason === "SAFETY") {
        finishReason = "content_filter"
    }

    if (toolCalls.length > 0) {
        finishReason = "tool_calls"
    }

    const message: any = {
        role: "assistant",
        content: textContent || null,
    }

    if (toolCalls.length > 0) {
        message.tool_calls = toolCalls
    }

    return {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: finishReason,
        }],
        usage: {
            prompt_tokens: usageMetadata.promptTokenCount || 0,
            completion_tokens: usageMetadata.candidatesTokenCount || 0,
            total_tokens: usageMetadata.totalTokenCount || 0,
        },
    }
}

// ==================================================================================================
// Error Response Formatters (from AIClient-2-API)
// ==================================================================================================

type ErrorResponseFormat = "openai" | "anthropic" | "gemini"

/**
 * Get error type from HTTP status code
 */
function getErrorType(statusCode: number): string {
    if (statusCode === 401) return "authentication_error"
    if (statusCode === 403) return "permission_error"
    if (statusCode === 429) return "rate_limit_error"
    if (statusCode >= 500) return "server_error"
    return "invalid_request_error"
}

/**
 * Get Gemini status from HTTP status code
 */
function getGeminiStatus(statusCode: number): string {
    if (statusCode === 400) return "INVALID_ARGUMENT"
    if (statusCode === 401) return "UNAUTHENTICATED"
    if (statusCode === 403) return "PERMISSION_DENIED"
    if (statusCode === 404) return "NOT_FOUND"
    if (statusCode === 429) return "RESOURCE_EXHAUSTED"
    if (statusCode >= 500) return "INTERNAL"
    return "UNKNOWN"
}

/**
 * Create error response in specified format
 */
export function createErrorResponse(
    error: Error | { message: string; status?: number },
    format: ErrorResponseFormat
): any {
    const statusCode = (error as any).status || 500
    const errorMessage = error.message || "An error occurred"

    switch (format) {
        case "openai":
            return {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: getErrorType(statusCode),
                },
            }

        case "anthropic":
            return {
                type: "error",
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage,
                },
            }

        case "gemini":
            return {
                error: {
                    code: statusCode,
                    message: errorMessage,
                    status: getGeminiStatus(statusCode),
                },
            }

        default:
            return {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                },
            }
    }
}

/**
 * Create streaming error response in specified format
 */
export function createStreamErrorResponse(
    error: Error | { message: string; status?: number },
    format: ErrorResponseFormat
): string {
    const statusCode = (error as any).status || 500
    const errorMessage = error.message || "An error occurred during streaming"

    switch (format) {
        case "openai":
            return `data: ${JSON.stringify({
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: null,
                },
            })}\n\n`

        case "anthropic":
            return `event: error\ndata: ${JSON.stringify({
                type: "error",
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage,
                },
            })}\n\n`

        case "gemini":
            return `data: ${JSON.stringify({
                error: {
                    code: statusCode,
                    message: errorMessage,
                    status: getGeminiStatus(statusCode),
                },
            })}\n\n`

        default:
            return `data: ${JSON.stringify({
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                },
            })}\n\n`
    }
}

// ==================================================================================================
// Stream Chunk Converters (from AIClient-2-API)
// Converts streaming chunks between protocols
// ==================================================================================================

/**
 * Stream chunk types for Anthropic SSE
 */
export type AnthropicStreamChunkType =
    | "message_start"
    | "content_block_start"
    | "content_block_delta"
    | "content_block_stop"
    | "message_delta"
    | "message_stop"
    | "ping"
    | "error"

export interface AnthropicStreamChunk {
    type: AnthropicStreamChunkType
    message?: any
    index?: number
    content_block?: any
    delta?: any
    usage?: any
    error?: any
}

/**
 * Convert Anthropic stream chunk to OpenAI stream chunk format
 * Based on AIClient-2-API's ClaudeConverter.toOpenAIStreamChunk
 */
export function convertAnthropicChunkToOpenAI(chunk: AnthropicStreamChunk, model: string): any {
    if (!chunk) return null

    const chunkId = `chatcmpl-${Date.now()}`
    const timestamp = Math.floor(Date.now() / 1000)

    // message_start event
    if (chunk.type === "message_start") {
        return {
            id: chunkId,
            object: "chat.completion.chunk",
            created: timestamp,
            model,
            system_fingerprint: "",
            choices: [{
                index: 0,
                delta: { role: "assistant", content: "" },
                finish_reason: null
            }],
            usage: {
                prompt_tokens: chunk.message?.usage?.input_tokens || 0,
                completion_tokens: 0,
                total_tokens: chunk.message?.usage?.input_tokens || 0,
                cached_tokens: chunk.message?.usage?.cache_read_input_tokens || 0
            }
        }
    }

    // content_block_start event
    if (chunk.type === "content_block_start") {
        const contentBlock = chunk.content_block

        // Handle tool_use type
        if (contentBlock && contentBlock.type === "tool_use") {
            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {
                        tool_calls: [{
                            index: chunk.index || 0,
                            id: contentBlock.id,
                            type: "function",
                            function: {
                                name: contentBlock.name,
                                arguments: ""
                            }
                        }]
                    },
                    finish_reason: null
                }]
            }
        }

        // Handle text type
        return {
            id: chunkId,
            object: "chat.completion.chunk",
            created: timestamp,
            model,
            system_fingerprint: "",
            choices: [{
                index: 0,
                delta: { content: "" },
                finish_reason: null
            }]
        }
    }

    // content_block_delta event
    if (chunk.type === "content_block_delta") {
        const delta = chunk.delta

        // Handle text_delta
        if (delta && delta.type === "text_delta") {
            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: { content: delta.text || "" },
                    finish_reason: null
                }]
            }
        }

        // Handle thinking_delta (reasoning content)
        if (delta && delta.type === "thinking_delta") {
            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: { reasoning_content: delta.thinking || "" },
                    finish_reason: null
                }]
            }
        }

        // Handle input_json_delta (tool arguments)
        if (delta && delta.type === "input_json_delta") {
            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {
                        tool_calls: [{
                            index: chunk.index || 0,
                            function: { arguments: delta.partial_json || "" }
                        }]
                    },
                    finish_reason: null
                }]
            }
        }
    }

    // content_block_stop event
    if (chunk.type === "content_block_stop") {
        return {
            id: chunkId,
            object: "chat.completion.chunk",
            created: timestamp,
            model,
            system_fingerprint: "",
            choices: [{
                index: 0,
                delta: {},
                finish_reason: null
            }]
        }
    }

    // message_delta event
    if (chunk.type === "message_delta") {
        const stopReason = chunk.delta?.stop_reason
        const finishReason = stopReason === "end_turn" ? "stop" :
                            stopReason === "max_tokens" ? "length" :
                            stopReason === "tool_use" ? "tool_calls" :
                            stopReason || "stop"

        return {
            id: chunkId,
            object: "chat.completion.chunk",
            created: timestamp,
            model,
            system_fingerprint: "",
            choices: [{
                index: 0,
                delta: {},
                finish_reason: finishReason
            }],
            usage: chunk.usage ? {
                prompt_tokens: chunk.usage.input_tokens || 0,
                completion_tokens: chunk.usage.output_tokens || 0,
                total_tokens: (chunk.usage.input_tokens || 0) + (chunk.usage.output_tokens || 0),
                cached_tokens: chunk.usage.cache_read_input_tokens || 0,
                prompt_tokens_details: {
                    cached_tokens: chunk.usage.cache_read_input_tokens || 0
                }
            } : undefined
        }
    }

    // message_stop event
    if (chunk.type === "message_stop") {
        return {
            id: chunkId,
            object: "chat.completion.chunk",
            created: timestamp,
            model,
            system_fingerprint: "",
            choices: [{
                index: 0,
                delta: {},
                finish_reason: "stop"
            }]
        }
    }

    return null
}

/**
 * Convert Anthropic stream chunk to Gemini stream chunk format
 * Based on AIClient-2-API's ClaudeConverter.toGeminiStreamChunk
 */
export function convertAnthropicChunkToGemini(chunk: AnthropicStreamChunk, _model: string): any {
    if (!chunk) return null

    // content_block_delta event
    if (chunk.type === "content_block_delta") {
        const delta = chunk.delta

        // Handle text_delta
        if (delta && delta.type === "text_delta") {
            return {
                candidates: [{
                    content: {
                        role: "model",
                        parts: [{ text: delta.text || "" }]
                    }
                }]
            }
        }

        // Handle thinking_delta - map to text
        if (delta && delta.type === "thinking_delta") {
            return {
                candidates: [{
                    content: {
                        role: "model",
                        parts: [{ text: delta.thinking || "" }]
                    }
                }]
            }
        }

        // Handle input_json_delta (tool arguments) - skip for now
        if (delta && delta.type === "input_json_delta") {
            return null
        }
    }

    // content_block_start for tool_use
    if (chunk.type === "content_block_start" && chunk.content_block?.type === "tool_use") {
        return {
            candidates: [{
                content: {
                    role: "model",
                    parts: [{
                        functionCall: {
                            name: chunk.content_block.name,
                            args: {}
                        }
                    }]
                }
            }]
        }
    }

    // message_delta event - stream end
    if (chunk.type === "message_delta") {
        const stopReason = chunk.delta?.stop_reason
        const result: any = {
            candidates: [{
                finishReason: stopReason === "end_turn" ? "STOP" :
                              stopReason === "max_tokens" ? "MAX_TOKENS" :
                              "STOP"
            }]
        }

        // Add usage info
        if (chunk.usage) {
            result.usageMetadata = {
                promptTokenCount: chunk.usage.input_tokens || 0,
                candidatesTokenCount: chunk.usage.output_tokens || 0,
                totalTokenCount: (chunk.usage.input_tokens || 0) + (chunk.usage.output_tokens || 0),
                cachedContentTokenCount: chunk.usage.cache_read_input_tokens || 0
            }
        }

        return result
    }

    return null
}

/**
 * OpenAI stream chunk interface
 */
export interface OpenAIStreamChunk {
    id: string
    object: string
    created: number
    model: string
    choices: Array<{
        index: number
        delta: {
            role?: string
            content?: string
            tool_calls?: any[]
            reasoning_content?: string
        }
        finish_reason: string | null
    }>
    usage?: any
}

/**
 * Convert OpenAI stream chunk to Anthropic stream chunk format
 * Based on AIClient-2-API's OpenAIConverter.toClaudeStreamChunk
 */
export function convertOpenAIChunkToAnthropic(chunk: OpenAIStreamChunk, model: string): AnthropicStreamChunk[] {
    if (!chunk || !chunk.choices || chunk.choices.length === 0) return []

    const events: AnthropicStreamChunk[] = []
    const choice = chunk.choices[0]
    const delta = choice.delta

    // Handle role (message start)
    if (delta.role === "assistant") {
        events.push({
            type: "message_start",
            message: {
                id: `msg_${chunk.id.slice(8)}`,
                type: "message",
                role: "assistant",
                content: [],
                model,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        })
        events.push({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" }
        })
    }

    // Handle content delta
    if (delta.content) {
        events.push({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: delta.content }
        })
    }

    // Handle reasoning content (thinking)
    if (delta.reasoning_content) {
        events.push({
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: delta.reasoning_content }
        })
    }

    // Handle tool_calls
    if (delta.tool_calls && delta.tool_calls.length > 0) {
        for (const tc of delta.tool_calls) {
            const tcIndex = tc.index || 0

            // Tool call start (has id and name)
            if (tc.id && tc.function?.name) {
                events.push({
                    type: "content_block_start",
                    index: tcIndex,
                    content_block: {
                        type: "tool_use",
                        id: tc.id,
                        name: tc.function.name,
                        input: {}
                    }
                })
            }

            // Tool call arguments delta
            if (tc.function?.arguments) {
                events.push({
                    type: "content_block_delta",
                    index: tcIndex,
                    delta: {
                        type: "input_json_delta",
                        partial_json: tc.function.arguments
                    }
                })
            }
        }
    }

    // Handle finish_reason
    if (choice.finish_reason) {
        // Close content block
        events.push({
            type: "content_block_stop",
            index: 0
        })

        // Map finish reason
        let stopReason = "end_turn"
        if (choice.finish_reason === "tool_calls") {
            stopReason = "tool_use"
        } else if (choice.finish_reason === "length") {
            stopReason = "max_tokens"
        } else if (choice.finish_reason === "content_filter") {
            stopReason = "stop_sequence"
        }

        events.push({
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: chunk.usage ? {
                output_tokens: chunk.usage.completion_tokens || 0
            } : undefined
        })

        events.push({ type: "message_stop" })
    }

    return events
}

/**
 * Convert OpenAI stream chunk to Gemini stream chunk format
 * Based on AIClient-2-API's OpenAIConverter.toGeminiStreamChunk
 */
export function convertOpenAIChunkToGemini(chunk: OpenAIStreamChunk, _model: string): any {
    if (!chunk || !chunk.choices || chunk.choices.length === 0) return null

    const choice = chunk.choices[0]
    const delta = choice.delta

    // Handle content delta
    if (delta.content) {
        return {
            candidates: [{
                content: {
                    role: "model",
                    parts: [{ text: delta.content }]
                }
            }]
        }
    }

    // Handle reasoning content
    if (delta.reasoning_content) {
        return {
            candidates: [{
                content: {
                    role: "model",
                    parts: [{ text: delta.reasoning_content }]
                }
            }]
        }
    }

    // Handle tool_calls
    if (delta.tool_calls && delta.tool_calls.length > 0) {
        const parts: any[] = []
        for (const tc of delta.tool_calls) {
            if (tc.function?.name) {
                let args = {}
                if (tc.function.arguments) {
                    try {
                        args = JSON.parse(tc.function.arguments)
                    } catch {
                        // Keep empty object
                    }
                }
                parts.push({
                    functionCall: {
                        name: tc.function.name,
                        args
                    }
                })
            }
        }
        if (parts.length > 0) {
            return {
                candidates: [{
                    content: {
                        role: "model",
                        parts
                    }
                }]
            }
        }
    }

    // Handle finish_reason
    if (choice.finish_reason) {
        let finishReason = "STOP"
        if (choice.finish_reason === "length") {
            finishReason = "MAX_TOKENS"
        } else if (choice.finish_reason === "content_filter") {
            finishReason = "SAFETY"
        }

        return {
            candidates: [{
                content: { role: "model", parts: [] },
                finishReason
            }],
            usageMetadata: chunk.usage ? {
                promptTokenCount: chunk.usage.prompt_tokens || 0,
                candidatesTokenCount: chunk.usage.completion_tokens || 0,
                totalTokenCount: chunk.usage.total_tokens || 0
            } : undefined
        }
    }

    return null
}

/**
 * Gemini stream chunk interface
 */
export interface GeminiStreamChunk {
    candidates?: Array<{
        content?: {
            role: string
            parts: Array<{
                text?: string
                functionCall?: { name: string; args: any }
            }>
        }
        finishReason?: string
    }>
    usageMetadata?: {
        promptTokenCount?: number
        candidatesTokenCount?: number
        totalTokenCount?: number
    }
}

/**
 * Convert Gemini stream chunk to OpenAI stream chunk format
 * Based on AIClient-2-API's GeminiConverter.toOpenAIStreamChunk
 */
export function convertGeminiChunkToOpenAI(chunk: GeminiStreamChunk, model: string): any {
    if (!chunk || !chunk.candidates || chunk.candidates.length === 0) return null

    const candidate = chunk.candidates[0]
    const content = candidate.content
    const parts = content?.parts || []

    const chunkId = `chatcmpl-${Date.now()}`
    const timestamp = Math.floor(Date.now() / 1000)

    // Handle text content
    const textParts = parts.filter(p => p.text).map(p => p.text).join("")
    if (textParts) {
        return {
            id: chunkId,
            object: "chat.completion.chunk",
            created: timestamp,
            model,
            choices: [{
                index: 0,
                delta: { content: textParts },
                finish_reason: null
            }]
        }
    }

    // Handle function calls
    const functionCalls = parts.filter(p => p.functionCall)
    if (functionCalls.length > 0) {
        const toolCalls = functionCalls.map((p, idx) => ({
            index: idx,
            id: `call_${Date.now()}_${idx}`,
            type: "function",
            function: {
                name: p.functionCall!.name,
                arguments: JSON.stringify(p.functionCall!.args || {})
            }
        }))

        return {
            id: chunkId,
            object: "chat.completion.chunk",
            created: timestamp,
            model,
            choices: [{
                index: 0,
                delta: { tool_calls: toolCalls },
                finish_reason: null
            }]
        }
    }

    // Handle finish reason
    if (candidate.finishReason) {
        let finishReason = "stop"
        if (candidate.finishReason === "MAX_TOKENS") {
            finishReason = "length"
        } else if (candidate.finishReason === "SAFETY") {
            finishReason = "content_filter"
        }

        return {
            id: chunkId,
            object: "chat.completion.chunk",
            created: timestamp,
            model,
            choices: [{
                index: 0,
                delta: {},
                finish_reason: finishReason
            }],
            usage: chunk.usageMetadata ? {
                prompt_tokens: chunk.usageMetadata.promptTokenCount || 0,
                completion_tokens: chunk.usageMetadata.candidatesTokenCount || 0,
                total_tokens: chunk.usageMetadata.totalTokenCount || 0
            } : undefined
        }
    }

    return null
}

/**
 * Convert Gemini stream chunk to Anthropic stream chunk format
 * Based on AIClient-2-API's GeminiConverter.toClaudeStreamChunk
 */
export function convertGeminiChunkToAnthropic(chunk: GeminiStreamChunk, _model: string): AnthropicStreamChunk[] {
    if (!chunk || !chunk.candidates || chunk.candidates.length === 0) return []

    const events: AnthropicStreamChunk[] = []
    const candidate = chunk.candidates[0]
    const content = candidate.content
    const parts = content?.parts || []

    // Handle text content
    const textParts = parts.filter(p => p.text)
    for (const part of textParts) {
        events.push({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: part.text }
        })
    }

    // Handle function calls
    const functionCalls = parts.filter(p => p.functionCall)
    for (let idx = 0; idx < functionCalls.length; idx++) {
        const fc = functionCalls[idx]
        events.push({
            type: "content_block_start",
            index: idx + 1,
            content_block: {
                type: "tool_use",
                id: `toolu_${Date.now()}_${idx}`,
                name: fc.functionCall!.name,
                input: {}
            }
        })
        events.push({
            type: "content_block_delta",
            index: idx + 1,
            delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify(fc.functionCall!.args || {})
            }
        })
        events.push({
            type: "content_block_stop",
            index: idx + 1
        })
    }

    // Handle finish reason
    if (candidate.finishReason) {
        let stopReason = "end_turn"
        if (candidate.finishReason === "MAX_TOKENS") {
            stopReason = "max_tokens"
        }
        if (functionCalls.length > 0) {
            stopReason = "tool_use"
        }

        events.push({
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: chunk.usageMetadata ? {
                output_tokens: chunk.usageMetadata.candidatesTokenCount || 0
            } : undefined
        })
        events.push({ type: "message_stop" })
    }

    return events
}

// ==================================================================================================
// Stream Chunk Formatter Helpers
// ==================================================================================================

/**
 * Format Anthropic stream chunk as SSE string
 */
export function formatAnthropicChunkAsSSE(chunk: AnthropicStreamChunk): string {
    return `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`
}

/**
 * Format OpenAI stream chunk as SSE string
 */
export function formatOpenAIChunkAsSSE(chunk: any): string {
    return `data: ${JSON.stringify(chunk)}\n\n`
}

/**
 * Format Gemini stream chunk as SSE string
 */
export function formatGeminiChunkAsSSE(chunk: any): string {
    return `data: ${JSON.stringify(chunk)}\n\n`
}

