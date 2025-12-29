/**
 * Anthropic Messages Handler
 */

import type { Context } from "hono"
import { stream } from "hono/streaming"
import consola from "consola"

import { KiroAuthManager } from "~/lib/auth"
import { config } from "~/lib/config"
import { generateConversationId } from "~/lib/utils"
import { formatAnthropicError, ValidationError, UpstreamError } from "~/lib/error"
import { KiroHttpClient } from "~/services/kiro/client"
import { buildKiroPayload, convertAnthropicToOpenAIRequest } from "~/services/kiro/converters"
import { streamKiroToAnthropic, collectAnthropicResponse } from "~/services/kiro/streaming"
import type { AnthropicMessagesRequest } from "./types"

/**
 * Handle Anthropic messages request
 */
export async function handleMessages(
    c: Context,
    authManager: KiroAuthManager
): Promise<Response> {
    let requestData: AnthropicMessagesRequest

    try {
        requestData = await c.req.json<AnthropicMessagesRequest>()
    } catch (e) {
        return c.json(formatAnthropicError(new ValidationError("Invalid JSON body")), 400)
    }

    // Validate required fields
    if (!requestData.model) {
        return c.json(formatAnthropicError(new ValidationError("model is required")), 400)
    }
    if (!requestData.messages || requestData.messages.length === 0) {
        return c.json(formatAnthropicError(new ValidationError("messages is required and must not be empty")), 400)
    }
    if (!requestData.max_tokens) {
        return c.json(formatAnthropicError(new ValidationError("max_tokens is required")), 400)
    }

    consola.info(`Request to /v1/messages (model=${requestData.model}, stream=${requestData.stream})`)

    // Convert Anthropic request to OpenAI format for internal processing
    let openaiRequest
    try {
        openaiRequest = convertAnthropicToOpenAIRequest(requestData)
    } catch (e: any) {
        consola.error(`Failed to convert Anthropic request: ${e.message}`)
        return c.json(formatAnthropicError(new ValidationError(`Invalid request format: ${e.message}`)), 400)
    }

    // Generate conversation ID
    const conversationId = generateConversationId()

    // Build Kiro payload
    let kiroPayload: any
    try {
        kiroPayload = buildKiroPayload(openaiRequest, conversationId, authManager.profileArn || "")
    } catch (e: any) {
        return c.json(formatAnthropicError(new ValidationError(e.message)), 400)
    }

    // Create HTTP client
    const httpClient = new KiroHttpClient(authManager)
    const url = `${authManager.apiHost}/generateAssistantResponse`

    try {
        // Send request to Kiro API
        const response = await httpClient.streamRequest(url, kiroPayload, requestData.model)

        if (!response.ok) {
            const errorText = await response.text()
            consola.error(`Error from Kiro API: ${response.status} - ${errorText}`)

            // Try to parse error message
            let errorMessage = errorText
            try {
                const errorJson = JSON.parse(errorText)
                if (errorJson.message) {
                    errorMessage = errorJson.message
                    if (errorJson.reason) {
                        errorMessage = `${errorMessage} (reason: ${errorJson.reason})`
                    }
                }
            } catch {
                // Keep original error text
            }

            return c.json(
                formatAnthropicError(new UpstreamError(errorMessage, response.status)),
                response.status as any
            )
        }

        // Prepare tokenizer data for usage calculation
        const messagesForTokenizer = openaiRequest.messages
        const toolsForTokenizer = openaiRequest.tools

        // Handle streaming vs non-streaming
        if (requestData.stream) {
            // Streaming response
            return stream(c, async (streamWriter) => {
                try {
                    for await (const chunk of streamKiroToAnthropic(response, requestData.model, {
                        requestMessages: messagesForTokenizer,
                        requestTools: toolsForTokenizer,
                        thinkingEnabled: requestData.thinking !== undefined,
                    })) {
                        await streamWriter.write(chunk)
                    }
                } catch (e) {
                    consola.error(`Streaming error: ${e}`)
                }
            }, async (err, streamWriter) => {
                consola.error(`Stream error callback: ${err}`)
            })
        } else {
            // Non-streaming response
            const result = await collectAnthropicResponse(response, requestData.model, {
                requestMessages: messagesForTokenizer,
                requestTools: toolsForTokenizer,
            })

            consola.info(`HTTP 200 - POST /v1/messages (non-streaming) - completed`)
            return c.json(result)
        }

    } catch (e: any) {
        consola.error(`Internal error: ${e.message}`)
        return c.json(formatAnthropicError(e), e.statusCode || 500)
    }
}

