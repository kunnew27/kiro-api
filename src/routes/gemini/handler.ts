/**
 * Gemini GenerateContent Handler
 */

import type { Context } from "hono"
import { stream } from "hono/streaming"
import consola from "consola"

import { KiroAuthManager } from "~/lib/auth"
import { generateConversationId } from "~/lib/utils"
import { formatGeminiError, ValidationError, UpstreamError } from "~/lib/error"
import { KiroHttpClient } from "~/services/kiro/client"
import { buildKiroPayload, convertGeminiToOpenAIRequest } from "~/services/kiro/converters"
import { streamKiroToGemini, collectGeminiResponse } from "~/services/kiro/streaming"
import type { GeminiGenerateContentRequest } from "./types"

/**
 * Handle Gemini generateContent request
 */
export async function handleGenerateContent(
    c: Context,
    authManager: KiroAuthManager,
    isStreaming: boolean = false
): Promise<Response> {
    let requestData: GeminiGenerateContentRequest

    try {
        requestData = await c.req.json<GeminiGenerateContentRequest>()
    } catch (e) {
        return c.json(formatGeminiError(new ValidationError("Invalid JSON body")), 400)
    }

    // Validate required fields
    if (!requestData.contents || requestData.contents.length === 0) {
        return c.json(formatGeminiError(new ValidationError("contents is required and must not be empty")), 400)
    }

    // Get model from URL path parameter
    const model = c.req.param("model") || "gemini-pro"

    consola.info(`Request to Gemini generateContent (model=${model}, stream=${isStreaming})`)

    // Convert Gemini request to OpenAI format for internal processing
    let openaiRequest
    try {
        openaiRequest = convertGeminiToOpenAIRequest(requestData, model)
    } catch (e: any) {
        consola.error(`Failed to convert Gemini request: ${e.message}`)
        return c.json(formatGeminiError(new ValidationError(`Invalid request format: ${e.message}`)), 400)
    }

    // Generate conversation ID
    const conversationId = generateConversationId()

    // Build Kiro payload
    let kiroPayload: any
    try {
        kiroPayload = buildKiroPayload(openaiRequest, conversationId, authManager.profileArn || "")
    } catch (e: any) {
        return c.json(formatGeminiError(new ValidationError(e.message)), 400)
    }

    // Create HTTP client
    const httpClient = new KiroHttpClient(authManager)
    const url = `${authManager.apiHost}/generateAssistantResponse`

    try {
        // Send request to Kiro API
        const response = await httpClient.streamRequest(url, kiroPayload, model)

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
                formatGeminiError(new UpstreamError(errorMessage, response.status)),
                response.status as any
            )
        }

        // Prepare tokenizer data for usage calculation
        const messagesForTokenizer = openaiRequest.messages
        const toolsForTokenizer = openaiRequest.tools

        // Handle streaming vs non-streaming
        if (isStreaming) {
            // Streaming response
            return stream(c, async (streamWriter) => {
                try {
                    for await (const chunk of streamKiroToGemini(response, model, {
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
            const result = await collectGeminiResponse(response, model, {
                requestMessages: messagesForTokenizer,
                requestTools: toolsForTokenizer,
            })

            consola.info(`HTTP 200 - POST Gemini generateContent (non-streaming) - completed`)
            return c.json(result)
        }

    } catch (e: any) {
        consola.error(`Internal error: ${e.message}`)
        return c.json(formatGeminiError(e), e.statusCode || 500)
    }
}
