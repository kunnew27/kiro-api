/**
 * OpenAI Chat Completions Handler
 */

import type { Context } from "hono"
import { stream } from "hono/streaming"
import consola from "consola"

import { KiroAuthManager } from "~/lib/auth"
import { generateConversationId } from "~/lib/utils"
import { formatOpenAIError, ValidationError, UpstreamError } from "~/lib/error"
import { KiroHttpClient } from "~/services/kiro/client"
import { buildKiroPayload } from "~/services/kiro/converters"
import { streamKiroToOpenAI, collectOpenAIResponse } from "~/services/kiro/streaming"
import type { OpenAIChatRequest } from "./types"

/**
 * Handle OpenAI chat completions request
 */
export async function handleChatCompletions(
    c: Context,
    authManager: KiroAuthManager
): Promise<Response> {
    let requestData: OpenAIChatRequest

    try {
        requestData = await c.req.json<OpenAIChatRequest>()
    } catch (e) {
        return c.json(formatOpenAIError(new ValidationError("Invalid JSON body")), 400)
    }

    // Validate required fields
    if (!requestData.model) {
        return c.json(formatOpenAIError(new ValidationError("model is required")), 400)
    }
    if (!requestData.messages || requestData.messages.length === 0) {
        return c.json(formatOpenAIError(new ValidationError("messages is required and must not be empty")), 400)
    }

    // Tools are converted directly to Kiro format in buildUserInputContext using convertToKiroTools
    // which handles all formats: OpenAI, Anthropic, flat, ID+params, etc.

    consola.info(`Request to /v1/chat/completions (model=${requestData.model}, stream=${requestData.stream}, tools=${requestData.tools?.length || 0})`)

    // Generate conversation ID
    const conversationId = generateConversationId()

    // Build Kiro payload
    let kiroPayload: any
    try {
        kiroPayload = buildKiroPayload(requestData, conversationId, authManager.profileArn || "")
    } catch (e: any) {
        return c.json(formatOpenAIError(new ValidationError(e.message)), 400)
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
                formatOpenAIError(new UpstreamError(errorMessage, response.status)),
                response.status as any
            )
        }

        // Prepare tokenizer data for usage calculation
        const messagesForTokenizer = requestData.messages
        const toolsForTokenizer = requestData.tools

        // Handle streaming vs non-streaming
        if (requestData.stream) {
            // Streaming response
            return stream(c, async (streamWriter) => {
                try {
                    for await (const chunk of streamKiroToOpenAI(response, requestData.model, {
                        requestMessages: messagesForTokenizer,
                        requestTools: toolsForTokenizer,
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
            const result = await collectOpenAIResponse(response, requestData.model, {
                requestMessages: messagesForTokenizer,
                requestTools: toolsForTokenizer,
            })

            consola.info(`HTTP 200 - POST /v1/chat/completions (non-streaming) - completed`)
            return c.json(result)
        }

    } catch (e: any) {
        consola.error(`Internal error: ${e.message}`)
        return c.json(formatOpenAIError(e), e.statusCode || 500)
    }
}

