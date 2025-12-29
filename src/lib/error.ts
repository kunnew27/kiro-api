/**
 * Error Types for Kiro API
 */

export class KiroError extends Error {
    code: string
    statusCode: number

    constructor(message: string, code: string, statusCode: number = 500) {
        super(message)
        this.name = "KiroError"
        this.code = code
        this.statusCode = statusCode
    }
}

export class AuthenticationError extends KiroError {
    constructor(message: string = "Authentication failed") {
        super(message, "authentication_error", 401)
        this.name = "AuthenticationError"
    }
}

export class TokenRefreshError extends KiroError {
    constructor(message: string = "Failed to refresh token") {
        super(message, "token_refresh_error", 401)
        this.name = "TokenRefreshError"
    }
}

export class RateLimitError extends KiroError {
    constructor(message: string = "Rate limit exceeded") {
        super(message, "rate_limit_exceeded", 429)
        this.name = "RateLimitError"
    }
}

export class TimeoutError extends KiroError {
    constructor(message: string = "Request timeout") {
        super(message, "timeout_error", 504)
        this.name = "TimeoutError"
    }
}

export class ValidationError extends KiroError {
    constructor(message: string = "Validation error") {
        super(message, "validation_error", 400)
        this.name = "ValidationError"
    }
}

export class UpstreamError extends KiroError {
    constructor(message: string = "Upstream API error", statusCode: number = 502) {
        super(message, "upstream_error", statusCode)
        this.name = "UpstreamError"
    }
}

/**
 * Format error for OpenAI-compatible response
 */
export function formatOpenAIError(error: Error | KiroError, statusCode?: number): object {
    const code = error instanceof KiroError ? error.statusCode : (statusCode || 500)
    const errorType = error instanceof KiroError ? error.code : "internal_error"

    return {
        error: {
            message: error.message,
            type: errorType,
            code: code,
        }
    }
}

/**
 * Format error for Anthropic-compatible response
 */
export function formatAnthropicError(error: Error | KiroError): object {
    const errorType = error instanceof KiroError ? error.code : "api_error"

    return {
        type: "error",
        error: {
            type: errorType,
            message: error.message,
        }
    }
}

/**
 * Format error for Gemini-compatible response
 */
export function formatGeminiError(error: Error | KiroError): object {
    const statusCode = error instanceof KiroError ? error.statusCode : 500

    const getGeminiStatus = (code: number): string => {
        if (code === 400) return "INVALID_ARGUMENT"
        if (code === 401) return "UNAUTHENTICATED"
        if (code === 403) return "PERMISSION_DENIED"
        if (code === 404) return "NOT_FOUND"
        if (code === 429) return "RESOURCE_EXHAUSTED"
        if (code >= 500) return "INTERNAL"
        return "UNKNOWN"
    }

    return {
        error: {
            code: statusCode,
            message: error.message,
            status: getGeminiStatus(statusCode),
        }
    }
}

// ==================================================================================================
// Protocol type for error formatting
// ==================================================================================================

export type ErrorProtocol = "openai" | "anthropic" | "gemini"

/**
 * Get error type from HTTP status code
 */
function getErrorTypeFromStatus(statusCode: number): string {
    if (statusCode === 401) return "authentication_error"
    if (statusCode === 403) return "permission_error"
    if (statusCode === 429) return "rate_limit_error"
    if (statusCode >= 500) return "server_error"
    return "invalid_request_error"
}

/**
 * Create protocol-specific error response (non-streaming)
 */
export function createErrorResponse(error: Error | KiroError, protocol: ErrorProtocol): object {
    switch (protocol) {
        case "openai":
            return formatOpenAIError(error)
        case "anthropic":
            return formatAnthropicError(error)
        case "gemini":
            return formatGeminiError(error)
        default:
            return formatOpenAIError(error)
    }
}

/**
 * Create protocol-specific streaming error response
 * Returns formatted SSE string ready to be written to stream
 */
export function createStreamErrorResponse(error: Error | KiroError, protocol: ErrorProtocol): string {
    const statusCode = error instanceof KiroError ? error.statusCode : 500
    const errorMessage = error.message || "An error occurred during streaming."
    const errorType = getErrorTypeFromStatus(statusCode)

    switch (protocol) {
        case "openai": {
            // OpenAI streaming error format (SSE data block)
            const openaiError = {
                error: {
                    message: errorMessage,
                    type: errorType,
                    code: null,
                }
            }
            return `data: ${JSON.stringify(openaiError)}\n\n`
        }

        case "anthropic": {
            // Claude streaming error format (SSE event + data)
            const claudeError = {
                type: "error",
                error: {
                    type: errorType,
                    message: errorMessage,
                }
            }
            return `event: error\ndata: ${JSON.stringify(claudeError)}\n\n`
        }

        case "gemini": {
            // Gemini streaming error format
            const getGeminiStatus = (code: number): string => {
                if (code === 400) return "INVALID_ARGUMENT"
                if (code === 401) return "UNAUTHENTICATED"
                if (code === 403) return "PERMISSION_DENIED"
                if (code === 404) return "NOT_FOUND"
                if (code === 429) return "RESOURCE_EXHAUSTED"
                if (code >= 500) return "INTERNAL"
                return "UNKNOWN"
            }

            const geminiError = {
                error: {
                    code: statusCode,
                    message: errorMessage,
                    status: getGeminiStatus(statusCode),
                }
            }
            return `data: ${JSON.stringify(geminiError)}\n\n`
        }

        default: {
            // Default to OpenAI format
            const defaultError = {
                error: {
                    message: errorMessage,
                    type: errorType,
                    code: null,
                }
            }
            return `data: ${JSON.stringify(defaultError)}\n\n`
        }
    }
}

/**
 * Check if error is a client error (should not be retried)
 */
export function isClientError(error: Error | KiroError): boolean {
    if (error instanceof KiroError) {
        const status = error.statusCode
        // Client errors (4xx) except 429 (rate limit) should not be retried
        return status >= 400 && status < 500 && status !== 429
    }

    // Check message for common client error patterns
    const message = error.message?.toLowerCase() || ""
    return (
        message.includes("invalid") ||
        message.includes("bad request") ||
        message.includes("missing required") ||
        message.includes("validation")
    )
}

/**
 * Check if error is retriable
 */
export function isRetriableError(error: Error | KiroError): boolean {
    if (error instanceof KiroError) {
        const status = error.statusCode
        // Rate limit (429) and server errors (5xx) are retriable
        return status === 429 || status >= 500
    }

    // Check message for retriable patterns
    const message = error.message?.toLowerCase() || ""
    return (
        message.includes("timeout") ||
        message.includes("rate limit") ||
        message.includes("too many requests") ||
        message.includes("server error") ||
        message.includes("temporarily unavailable")
    )
}

