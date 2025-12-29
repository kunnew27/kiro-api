/**
 * OpenAI Compatible Routes
 * /v1/chat/completions endpoint
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi"
import consola from "consola"

import { config } from "~/lib/config"
import { state } from "~/lib/state"
import { KiroAuthManager } from "~/lib/auth"
import { authCache } from "~/lib/auth-cache"
import { maskToken } from "~/lib/utils"
import { formatOpenAIError, AuthenticationError } from "~/lib/error"
import { handleChatCompletions } from "./handler"
import {
    OpenAIChatRequestSchema,
    OpenAIChatCompletionResponseSchema,
    OpenAIErrorResponseSchema,
} from "~/lib/schemas"

export const openaiRoutes = new OpenAPIHono()

/**
 * Parse Authorization header and return AuthManager
 * Supports two formats:
 * 1. Traditional: "Bearer {PROXY_API_KEY}" - uses global AuthManager
 * 2. Multi-tenant: "Bearer {PROXY_API_KEY}:{REFRESH_TOKEN}" - creates per-user AuthManager
 */
async function parseAuthHeader(authHeader: string | undefined): Promise<KiroAuthManager> {
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        throw new AuthenticationError("Invalid or missing API Key")
    }

    const token = authHeader.slice(7) // Remove "Bearer "

    // Check if token contains ':' (multi-tenant format)
    if (token.includes(":")) {
        const [proxyKey, refreshToken] = token.split(":", 2)

        // Verify proxy key
        if (proxyKey !== config.proxyApiKey) {
            consola.warn(`Invalid proxy key in multi-tenant format: ${maskToken(proxyKey)}`)
            throw new AuthenticationError("Invalid or missing API Key")
        }

        // Get or create AuthManager for this refresh token
        consola.debug(`Multi-tenant mode: using custom refresh token ${maskToken(refreshToken)}`)
        return await authCache.getOrCreate(refreshToken, config.region, config.profileArn)
    } else {
        // Traditional mode: verify entire token as PROXY_API_KEY
        if (token !== config.proxyApiKey) {
            consola.warn("Invalid API key in traditional format")
            throw new AuthenticationError("Invalid or missing API Key")
        }

        // Return global AuthManager
        consola.debug("Traditional mode: using global AuthManager")
        if (!state.authManager) {
            throw new AuthenticationError("Server not configured with credentials")
        }
        return state.authManager
    }
}

/**
 * OpenAPI route definition for chat completions (for documentation only)
 */
const chatCompletionsRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["OpenAI"],
    summary: "Create Chat Completion",
    description: "Creates a model response for the given chat conversation. Compatible with OpenAI's chat completions API.",
    security: [{ bearerAuth: [] }],
    request: {
        body: {
            content: {
                "application/json": {
                    schema: OpenAIChatRequestSchema,
                },
            },
            required: true,
        },
    },
    responses: {
        200: {
            description: "Successful response (non-streaming) or SSE stream (streaming)",
            content: {
                "application/json": {
                    schema: OpenAIChatCompletionResponseSchema,
                },
            },
        },
        400: {
            description: "Bad request - validation error",
            content: {
                "application/json": {
                    schema: OpenAIErrorResponseSchema,
                },
            },
        },
        401: {
            description: "Unauthorized - invalid or missing API key",
            content: {
                "application/json": {
                    schema: OpenAIErrorResponseSchema,
                },
            },
        },
        500: {
            description: "Internal server error",
            content: {
                "application/json": {
                    schema: OpenAIErrorResponseSchema,
                },
            },
        },
    },
})

/**
 * POST /v1/chat/completions
 * OpenAI-compatible chat completions endpoint
 */
openaiRoutes.openapi(chatCompletionsRoute, async (c) => {
    try {
        const authHeader = c.req.header("Authorization")
        const authManager = await parseAuthHeader(authHeader)

        return await handleChatCompletions(c, authManager) as any
    } catch (e: any) {
        if (e instanceof AuthenticationError) {
            return c.json(formatOpenAIError(e), 401)
        }
        consola.error(`Unexpected error: ${e.message}`)
        return c.json(formatOpenAIError(e), e.statusCode || 500)
    }
})
