/**
 * Gemini Compatible Routes
 * /v1beta/models/{model}:generateContent endpoint
 * /v1beta/models/{model}:streamGenerateContent endpoint
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi"
import consola from "consola"

import { config } from "~/lib/config"
import { state } from "~/lib/state"
import { KiroAuthManager } from "~/lib/auth"
import { authCache } from "~/lib/auth-cache"
import { maskToken } from "~/lib/utils"
import { formatGeminiError, AuthenticationError } from "~/lib/error"
import { handleGenerateContent } from "./handler"
import {
    GeminiGenerateContentRequestSchema,
    GeminiGenerateContentResponseSchema,
    GeminiErrorResponseSchema,
} from "~/lib/schemas"

export const geminiRoutes = new OpenAPIHono()

/**
 * Parse API key from headers or query params
 * Gemini API uses key= query parameter
 *
 * Formats:
 * 1. Traditional: "{PROXY_API_KEY}" - uses global AuthManager
 * 2. Multi-tenant: "{PROXY_API_KEY}:{REFRESH_TOKEN}" - creates per-user AuthManager
 */
async function parseApiKey(
    keyParam: string | undefined,
    authHeader: string | undefined
): Promise<KiroAuthManager> {
    // Try query parameter (Gemini format)
    if (keyParam) {
        return await parseToken(keyParam)
    }

    // Try Authorization header as fallback
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
 * OpenAPI route definition for Gemini generateContent
 */
const generateContentRoute = createRoute({
    method: "post",
    path: "/:model/generateContent",
    tags: ["Gemini"],
    summary: "Generate Content",
    description: "Generates a model response given an input GenerateContentRequest. Compatible with Google's Gemini API.",
    security: [{ apiKeyAuth: [] }],
    request: {
        body: {
            content: {
                "application/json": {
                    schema: GeminiGenerateContentRequestSchema,
                },
            },
            required: true,
        },
    },
    responses: {
        200: {
            description: "Successful response",
            content: {
                "application/json": {
                    schema: GeminiGenerateContentResponseSchema,
                },
            },
        },
        400: {
            description: "Bad request - validation error",
            content: {
                "application/json": {
                    schema: GeminiErrorResponseSchema,
                },
            },
        },
        401: {
            description: "Unauthorized - invalid or missing API key",
            content: {
                "application/json": {
                    schema: GeminiErrorResponseSchema,
                },
            },
        },
        500: {
            description: "Internal server error",
            content: {
                "application/json": {
                    schema: GeminiErrorResponseSchema,
                },
            },
        },
    },
})

/**
 * OpenAPI route definition for Gemini streamGenerateContent
 */
const streamGenerateContentRoute = createRoute({
    method: "post",
    path: "/:model/streamGenerateContent",
    tags: ["Gemini"],
    summary: "Stream Generate Content",
    description: "Generates a streamed model response given an input GenerateContentRequest. Compatible with Google's Gemini API.",
    security: [{ apiKeyAuth: [] }],
    request: {
        body: {
            content: {
                "application/json": {
                    schema: GeminiGenerateContentRequestSchema,
                },
            },
            required: true,
        },
    },
    responses: {
        200: {
            description: "Successful streaming response (SSE)",
            content: {
                "text/event-stream": {
                    schema: GeminiGenerateContentResponseSchema,
                },
            },
        },
        400: {
            description: "Bad request - validation error",
            content: {
                "application/json": {
                    schema: GeminiErrorResponseSchema,
                },
            },
        },
        401: {
            description: "Unauthorized - invalid or missing API key",
            content: {
                "application/json": {
                    schema: GeminiErrorResponseSchema,
                },
            },
        },
        500: {
            description: "Internal server error",
            content: {
                "application/json": {
                    schema: GeminiErrorResponseSchema,
                },
            },
        },
    },
})

/**
 * POST /v1beta/models/:model:generateContent
 * Gemini-compatible generateContent endpoint (non-streaming)
 */
geminiRoutes.openapi(generateContentRoute, async (c) => {
    try {
        const keyParam = c.req.query("key")
        const authHeader = c.req.header("Authorization")
        const authManager = await parseApiKey(keyParam, authHeader)

        return await handleGenerateContent(c, authManager, false) as any
    } catch (e: any) {
        if (e instanceof AuthenticationError) {
            return c.json(formatGeminiError(e), 401)
        }
        consola.error(`Unexpected error: ${e.message}`)
        return c.json(formatGeminiError(e), e.statusCode || 500)
    }
})

/**
 * POST /v1beta/models/:model:streamGenerateContent
 * Gemini-compatible streamGenerateContent endpoint (streaming)
 */
geminiRoutes.openapi(streamGenerateContentRoute, async (c) => {
    try {
        const keyParam = c.req.query("key")
        const authHeader = c.req.header("Authorization")
        const authManager = await parseApiKey(keyParam, authHeader)

        return await handleGenerateContent(c, authManager, true) as any
    } catch (e: any) {
        if (e instanceof AuthenticationError) {
            return c.json(formatGeminiError(e), 401)
        }
        consola.error(`Unexpected error: ${e.message}`)
        return c.json(formatGeminiError(e), e.statusCode || 500)
    }
})
