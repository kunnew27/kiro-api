/**
 * Anthropic Compatible Routes
 * /v1/messages endpoint
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi"
import consola from "consola"

import { config } from "~/lib/config"
import { state } from "~/lib/state"
import { KiroAuthManager } from "~/lib/auth"
import { authCache } from "~/lib/auth-cache"
import { maskToken } from "~/lib/utils"
import { formatAnthropicError, AuthenticationError } from "~/lib/error"
import { handleMessages } from "./handler"
import {
    AnthropicMessagesRequestSchema,
    AnthropicMessagesResponseSchema,
    AnthropicErrorResponseSchema,
} from "~/lib/schemas"

export const anthropicRoutes = new OpenAPIHono()

/**
 * Parse API key from headers
 * Supports both x-api-key (Anthropic) and Authorization (OpenAI) formats
 * 
 * Formats:
 * 1. Traditional: "{PROXY_API_KEY}" - uses global AuthManager
 * 2. Multi-tenant: "{PROXY_API_KEY}:{REFRESH_TOKEN}" - creates per-user AuthManager
 */
async function parseApiKey(
    xApiKey: string | undefined,
    authHeader: string | undefined
): Promise<KiroAuthManager> {
    // Try x-api-key first (Anthropic format)
    if (xApiKey) {
        return await parseToken(xApiKey)
    }

    // Try Authorization header (OpenAI format)
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.slice(7)
        return await parseToken(token)
    }

    throw new AuthenticationError("Invalid or missing API Key")
}

/**
 * Parse token and return AuthManager
 */
async function parseToken(token: string): Promise<KiroAuthManager> {
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
 * OpenAPI route definition for Anthropic messages
 */
const messagesRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Anthropic"],
    summary: "Create Message",
    description: "Send a structured list of input messages and receive a model-generated message in response. Compatible with Anthropic's messages API.",
    security: [{ apiKeyAuth: [] }, { bearerAuth: [] }],
    request: {
        body: {
            content: {
                "application/json": {
                    schema: AnthropicMessagesRequestSchema,
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
                    schema: AnthropicMessagesResponseSchema,
                },
            },
        },
        400: {
            description: "Bad request - validation error",
            content: {
                "application/json": {
                    schema: AnthropicErrorResponseSchema,
                },
            },
        },
        401: {
            description: "Unauthorized - invalid or missing API key",
            content: {
                "application/json": {
                    schema: AnthropicErrorResponseSchema,
                },
            },
        },
        500: {
            description: "Internal server error",
            content: {
                "application/json": {
                    schema: AnthropicErrorResponseSchema,
                },
            },
        },
    },
})

/**
 * POST /v1/messages
 * Anthropic-compatible messages endpoint
 */
anthropicRoutes.openapi(messagesRoute, async (c) => {
    try {
        const xApiKey = c.req.header("x-api-key")
        const authHeader = c.req.header("Authorization")
        const authManager = await parseApiKey(xApiKey, authHeader)

        return await handleMessages(c, authManager)
    } catch (e: any) {
        if (e instanceof AuthenticationError) {
            return c.json(formatAnthropicError(e), 401)
        }
        consola.error(`Unexpected error: ${e.message}`)
        return c.json(formatAnthropicError(e), e.statusCode || 500)
    }
})
