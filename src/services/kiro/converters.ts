/**
 * Request Converters
 * Convert OpenAI/Anthropic formats to Kiro API format
 */

import consola from "consola"
import { getInternalModelId, config } from "~/lib/config"
import { generateToolCallId } from "~/lib/utils"
import type { OpenAIChatMessage, OpenAIChatRequest, OpenAITool } from "~/routes/openai/types"
import type { AnthropicMessage, AnthropicMessagesRequest, AnthropicTool } from "~/routes/anthropic/types"

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
): { textContent: string | null; toolCalls: any[] | null; toolResults: any[] | null } {
    if (typeof content === "string") {
        return { textContent: content, toolCalls: null, toolResults: null }
    }

    if (!Array.isArray(content)) {
        return { textContent: content ? String(content) : null, toolCalls: null, toolResults: null }
    }

    const textParts: string[] = []
    const toolCalls: any[] = []
    const toolResults: any[] = []

    for (const block of content) {
        if (typeof block !== "object" || block === null) continue

        const blockType = block.type

        if (blockType === "text") {
            textParts.push(block.text || "")
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
                textParts.push(`<thinking>${thinkingText}</thinking>`)
            }
        }
    }

    const textContent = textParts.length > 0 ? textParts.join("\n") : null

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

