#!/usr/bin/env bun
/**
 * Kiro API Entry Point
 * OpenAI & Anthropic compatible Kiro API gateway
 */

import { defineCommand, runMain } from "citty"
import consola from "consola"

import { server } from "./server"
import { config, APP_VERSION, APP_TITLE } from "./lib/config"
import { state } from "./lib/state"
import { KiroAuthManager } from "./lib/auth"

const start = defineCommand({
    meta: {
        name: "start",
        description: "Start the Kiro API server",
    },
    args: {
        port: {
            type: "string",
            default: String(config.port),
            description: "Listen port",
            alias: "p",
        },
        verbose: {
            type: "boolean",
            default: false,
            description: "Verbose logging",
            alias: "v",
        },
    },
    async run({ args }) {
        state.port = parseInt(args.port, 10)
        state.verbose = args.verbose

        if (args.verbose) {
            consola.level = 4 // debug
        } else {
            consola.level = 3 // info
        }

        // Validate configuration
        if (!config.proxyApiKey || config.proxyApiKey === "changeme_proxy_secret") {
            consola.warn("=" .repeat(60))
            consola.warn("  WARNING: Using default PROXY_API_KEY")
            consola.warn("  Set PROXY_API_KEY environment variable for production!")
            consola.warn("=" .repeat(60))
        }

        // Check credentials
        const hasRefreshToken = !!config.refreshToken
        const hasCredsFile = !!config.credsFile

        if (hasRefreshToken || hasCredsFile) {
            // Create global AuthManager
            consola.info("Initializing global AuthManager...")
            state.authManager = new KiroAuthManager({
                refreshToken: config.refreshToken,
                profileArn: config.profileArn,
                region: config.region,
                credsFile: config.credsFile || undefined,
            })

            if (config.credsFile) {
                consola.info(`Using credentials file: ${config.credsFile}`)
            } else {
                consola.info("Using refresh token from environment")
            }
            consola.info("Auth mode: Simple mode + Multi-tenant mode supported")
        } else {
            consola.warn("No REFRESH_TOKEN or KIRO_CREDS_FILE configured")
            consola.warn("Running in multi-tenant only mode")
            consola.warn("Users must provide PROXY_API_KEY:REFRESH_TOKEN in Authorization header")
        }

        // Print startup banner
        console.log("")
        console.log("╔════════════════════════════════════════════════════════════╗")
        console.log(`║  ${APP_TITLE} v${APP_VERSION}`.padEnd(61) + "║")
        console.log("║  OpenAI, Anthropic & Gemini compatible Kiro API gateway    ║")
        console.log("╠════════════════════════════════════════════════════════════╣")
        console.log(`║  Server: http://0.0.0.0:${state.port}`.padEnd(61) + "║")
        console.log("║                                                            ║")
        console.log("║  Endpoints:                                                ║")
        console.log("║    POST /v1/chat/completions  (OpenAI compatible)          ║")
        console.log("║    POST /v1/messages          (Anthropic compatible)       ║")
        console.log("║    POST /v1beta/models/:model:generateContent  (Gemini)    ║")
        console.log("║    POST /v1beta/models/:model:streamGenerateContent        ║")
        console.log("║    GET  /v1/models            (Model list)                 ║")
        console.log("║    GET  /health               (Health check)               ║")
        console.log("║    GET  /docs                 (API Reference)              ║")
        console.log("╚════════════════════════════════════════════════════════════╝")
        console.log("")

        // Start server
        Bun.serve({
            fetch: server.fetch,
            hostname: "0.0.0.0",
            port: state.port,
            idleTimeout: 255, // Max timeout (255 seconds) for long AI responses
        })

        consola.success(`Server started on http://0.0.0.0:${state.port}`)
    },
})

const main = defineCommand({
    meta: {
        name: "kiro-api",
        description: "Kiro API Gateway - OpenAI & Anthropic compatible Kiro API proxy",
        version: APP_VERSION,
    },
    subCommands: { start },
})

await runMain(main)

