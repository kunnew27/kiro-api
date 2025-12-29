/**
 * Kiro HTTP Client with Retry Logic
 * Handles authentication, retries, and streaming
 */

import consola from "consola"
import { KiroAuthManager } from "~/lib/auth"
import { config, getAdaptiveTimeout } from "~/lib/config"
import { getKiroHeaders, sleep } from "~/lib/utils"
import { TimeoutError, UpstreamError } from "~/lib/error"

export class KiroHttpClient {
    private authManager: KiroAuthManager

    constructor(authManager: KiroAuthManager) {
        this.authManager = authManager
    }

    /**
     * Execute HTTP request with retry logic
     * Handles 403 (token refresh), 429 (rate limit), 5xx (server errors)
     */
    async requestWithRetry(
        method: string,
        url: string,
        jsonData: any,
        options: {
            stream?: boolean
            model?: string
        } = {}
    ): Promise<Response> {
        const { stream = false, model } = options

        // Get model from payload if not provided
        const modelName = model || jsonData?.modelId || ""

        // Calculate timeout based on stream mode and model
        let timeout: number
        let maxRetries: number

        if (stream) {
            // Streaming: use first token timeout
            const baseTimeout = config.firstTokenTimeout
            timeout = getAdaptiveTimeout(modelName, baseTimeout) * 1000 // Convert to ms
            maxRetries = config.firstTokenMaxRetries
        } else {
            // Non-streaming: use longer timeout
            const baseTimeout = config.nonStreamTimeout
            timeout = getAdaptiveTimeout(modelName, baseTimeout) * 1000
            maxRetries = config.maxRetries
        }

        let lastError: Error | null = null

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const token = await this.authManager.getAccessToken()
                const headers = getKiroHeaders(this.authManager, token)

                // Create abort controller for timeout
                const controller = new AbortController()
                const timeoutId = setTimeout(() => controller.abort(), timeout)

                try {
                    const response = await fetch(url, {
                        method,
                        headers,
                        body: JSON.stringify(jsonData),
                        signal: controller.signal,
                    })

                    clearTimeout(timeoutId)

                    if (response.ok) {
                        return response
                    }

                    // Handle specific error codes
                    const status = response.status

                    // 403 - Token expired, refresh and retry
                    if (status === 403) {
                        consola.warn(`Received 403, refreshing token (attempt ${attempt + 1}/${maxRetries})`)
                        await this.authManager.forceRefresh()
                        continue
                    }

                    // 429 - Rate limited, wait and retry
                    if (status === 429) {
                        const delay = config.baseRetryDelay * Math.pow(2, attempt) * 1000
                        consola.warn(`Received 429, waiting ${delay}ms (attempt ${attempt + 1}/${maxRetries})`)
                        await sleep(delay)
                        continue
                    }

                    // 5xx - Server error, wait and retry
                    if (status >= 500 && status < 600) {
                        const delay = config.baseRetryDelay * Math.pow(2, attempt) * 1000
                        consola.warn(`Received ${status}, waiting ${delay}ms (attempt ${attempt + 1}/${maxRetries})`)
                        await sleep(delay)
                        continue
                    }

                    // Other errors, return directly (let caller handle)
                    return response

                } catch (e) {
                    clearTimeout(timeoutId)
                    throw e
                }

            } catch (e: any) {
                lastError = e

                // Handle abort (timeout)
                if (e.name === "AbortError") {
                    if (stream) {
                        consola.warn(`First token timeout after ${timeout}ms for model ${modelName} (attempt ${attempt + 1}/${maxRetries})`)
                    } else {
                        const delay = config.baseRetryDelay * Math.pow(2, attempt) * 1000
                        consola.warn(`Timeout after ${timeout}ms for model ${modelName}, waiting ${delay}ms (attempt ${attempt + 1}/${maxRetries})`)
                        await sleep(delay)
                    }
                    continue
                }

                // Other request errors
                const delay = config.baseRetryDelay * Math.pow(2, attempt) * 1000
                consola.warn(`Request error: ${e.message}, waiting ${delay}ms (attempt ${attempt + 1}/${maxRetries})`)
                await sleep(delay)
            }
        }

        // All retries failed
        if (stream) {
            throw new TimeoutError(
                `Model did not respond within ${timeout / 1000}s after ${maxRetries} attempts. Please try again.`
            )
        } else {
            throw new UpstreamError(
                `Failed to complete request after ${maxRetries} attempts: ${lastError?.message}`
            )
        }
    }

    /**
     * Make streaming request to Kiro API
     */
    async streamRequest(
        url: string,
        payload: any,
        model?: string
    ): Promise<Response> {
        return this.requestWithRetry("POST", url, payload, {
            stream: true,
            model,
        })
    }

    /**
     * Make non-streaming request to Kiro API
     */
    async request(
        url: string,
        payload: any,
        model?: string
    ): Promise<Response> {
        return this.requestWithRetry("POST", url, payload, {
            stream: false,
            model,
        })
    }
}

