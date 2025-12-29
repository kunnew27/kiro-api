/**
 * Kiro API HTTP Server
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { apiReference } from "@scalar/hono-api-reference"

import { openaiRoutes } from "./routes/openai/route"
import { anthropicRoutes } from "./routes/anthropic/route"
import { AVAILABLE_MODELS, APP_VERSION, APP_TITLE, APP_DESCRIPTION } from "./lib/config"
import { nowSeconds, nowISO } from "./lib/utils"
import { state } from "./lib/state"
import {
    InfoResponseSchema,
    HealthResponseSchema,
    MetricsResponseSchema,
    ModelsListResponseSchema,
} from "./lib/schemas"

export const server = new OpenAPIHono()

// Middleware
server.use(logger())
server.use(cors())

// ==================================================================================================
// OpenAPI Documentation
// ==================================================================================================

// Serve OpenAPI JSON spec
server.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
        title: APP_TITLE,
        version: APP_VERSION,
        description: APP_DESCRIPTION,
    },
    servers: [
        { url: "http://localhost:8000", description: "Local development" },
    ],
})

// Serve Scalar API Reference UI
server.get(
    "/docs",
    apiReference({
        url: "/openapi.json",
        pageTitle: `${APP_TITLE} - API Reference`,
        theme: "purple",
    })
)

// ==================================================================================================
// Root and Health Endpoints
// ==================================================================================================

// Root path - API info
const rootRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Info"],
    summary: "API Information",
    description: "Returns basic information about the API",
    responses: {
        200: {
            description: "API information",
            content: {
                "application/json": {
                    schema: InfoResponseSchema,
                },
            },
        },
    },
})

server.openapi(rootRoute, (c) => {
    return c.json({
        status: "ok" as const,
        message: `${APP_TITLE} is running`,
        version: APP_VERSION,
        description: APP_DESCRIPTION,
    })
})

// API root
const apiRoute = createRoute({
    method: "get",
    path: "/api",
    tags: ["Info"],
    summary: "API Root",
    description: "Returns API status",
    responses: {
        200: {
            description: "API status",
            content: {
                "application/json": {
                    schema: InfoResponseSchema,
                },
            },
        },
    },
})

server.openapi(apiRoute, (c) => {
    return c.json({
        status: "ok" as const,
        message: `${APP_TITLE} is running`,
        version: APP_VERSION,
    })
})

// Health check endpoint
const healthRoute = createRoute({
    method: "get",
    path: "/health",
    tags: ["Info"],
    summary: "Health Check",
    description: "Returns health status of the API",
    responses: {
        200: {
            description: "Health status",
            content: {
                "application/json": {
                    schema: HealthResponseSchema,
                },
            },
        },
    },
})

server.openapi(healthRoute, (c) => {
    const tokenValid = state.authManager?.hasCredentials ?? false

    return c.json({
        status: "healthy" as const,
        timestamp: nowISO(),
        version: APP_VERSION,
        token_valid: tokenValid,
        cache_size: state.modelCache.size,
        cache_last_update: state.modelCacheLastUpdate,
    })
})

// ==================================================================================================
// Models Endpoints
// ==================================================================================================

// Models list route definition
const modelsRoute = createRoute({
    method: "get",
    path: "/v1/models",
    tags: ["Models"],
    summary: "List Models",
    description: "Returns a list of available models (OpenAI & Anthropic compatible)",
    responses: {
        200: {
            description: "List of available models",
            content: {
                "application/json": {
                    schema: ModelsListResponseSchema,
                },
            },
        },
    },
})

// Models list handler - compatible with OpenAI and Anthropic formats
const modelsHandler = (c: any) => {
    const now = nowISO()
    const created = nowSeconds()

    return c.json({
        object: "list" as const,
        data: AVAILABLE_MODELS.map(m => ({
            id: m.id,
            type: "model" as const,
            object: "model" as const,
            created_at: now,
            created: created,
            owned_by: "anthropic",
            display_name: m.name,
        })),
        has_more: false,
        first_id: AVAILABLE_MODELS[0]?.id,
        last_id: AVAILABLE_MODELS[AVAILABLE_MODELS.length - 1]?.id,
    })
}

// Register models endpoints
server.openapi(modelsRoute, modelsHandler)
server.get("/v1beta/models", modelsHandler)
server.get("/models", modelsHandler)

// ==================================================================================================
// OpenAI Compatible Endpoints
// ==================================================================================================

// /v1/chat/completions
server.route("/v1/chat/completions", openaiRoutes)
server.route("/chat/completions", openaiRoutes)

// ==================================================================================================
// Anthropic Compatible Endpoints
// ==================================================================================================

// /v1/messages
server.route("/v1/messages", anthropicRoutes)
server.route("/v1beta/messages", anthropicRoutes)
server.route("/messages", anthropicRoutes)

// ==================================================================================================
// Metrics Endpoint (Basic)
// ==================================================================================================

const metricsRoute = createRoute({
    method: "get",
    path: "/metrics",
    tags: ["Info"],
    summary: "Metrics",
    description: "Returns basic metrics about the API",
    responses: {
        200: {
            description: "Metrics data",
            content: {
                "application/json": {
                    schema: MetricsResponseSchema,
                },
            },
        },
    },
})

server.openapi(metricsRoute, (c) => {
    return c.json({
        uptime: process.uptime(),
        timestamp: nowISO(),
        version: APP_VERSION,
        auth_cache_size: state.modelCache.size,
    })
})
