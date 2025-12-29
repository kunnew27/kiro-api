/**
 * Kiro API Configuration
 * Environment variables, model mapping, and API settings
 */

// ==================================================================================================
// Environment Variables
// ==================================================================================================

export const config = {
    // Proxy API key (clients must provide this in Authorization header)
    proxyApiKey: process.env.PROXY_API_KEY || "changeme_proxy_secret",

    // Server port
    port: parseInt(process.env.PORT || "8000", 10),

    // Kiro API credentials
    refreshToken: process.env.REFRESH_TOKEN || "",
    profileArn: process.env.PROFILE_ARN || "",
    region: process.env.KIRO_REGION || "us-east-1",
    credsFile: process.env.KIRO_CREDS_FILE || "",

    // Token settings
    tokenRefreshThreshold: parseInt(process.env.TOKEN_REFRESH_THRESHOLD || "600", 10),

    // Retry settings
    maxRetries: parseInt(process.env.MAX_RETRIES || "3", 10),
    baseRetryDelay: parseFloat(process.env.BASE_RETRY_DELAY || "1.0"),

    // Timeout settings (seconds)
    firstTokenTimeout: parseFloat(process.env.FIRST_TOKEN_TIMEOUT || "120.0"),
    firstTokenMaxRetries: parseInt(process.env.FIRST_TOKEN_MAX_RETRIES || "3", 10),
    streamReadTimeout: parseFloat(process.env.STREAM_READ_TIMEOUT || "300.0"),
    nonStreamTimeout: parseFloat(process.env.NON_STREAM_TIMEOUT || "900.0"),

    // Slow model timeout multiplier
    slowModelTimeoutMultiplier: parseFloat(process.env.SLOW_MODEL_TIMEOUT_MULTIPLIER || "3.0"),

    // Tool description max length
    toolDescriptionMaxLength: parseInt(process.env.TOOL_DESCRIPTION_MAX_LENGTH || "10000", 10),

    // Model cache TTL (seconds)
    modelCacheTtl: parseInt(process.env.MODEL_CACHE_TTL || "3600", 10),

    // Default max input tokens
    defaultMaxInputTokens: parseInt(process.env.DEFAULT_MAX_INPUT_TOKENS || "200000", 10),

    // Rate limit (0 = disabled)
    rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE || "0", 10),

    // Debug mode: off, errors, all
    debugMode: process.env.DEBUG_MODE || "off",

    // Log level
    logLevel: process.env.LOG_LEVEL || "INFO",
}

// ==================================================================================================
// Slow Models (need longer timeouts)
// ==================================================================================================

export const SLOW_MODELS = new Set([
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "claude-3-opus",
    "claude-3-opus-20240229",
])

// ==================================================================================================
// Kiro API URL Templates
// ==================================================================================================

export const KIRO_REFRESH_URL_TEMPLATE = "https://prod.{region}.auth.desktop.kiro.dev/refreshToken"
export const KIRO_API_HOST_TEMPLATE = "https://codewhisperer.{region}.amazonaws.com"
export const KIRO_Q_HOST_TEMPLATE = "https://q.{region}.amazonaws.com"

export function getKiroRefreshUrl(region: string): string {
    return KIRO_REFRESH_URL_TEMPLATE.replace("{region}", region)
}

export function getKiroApiHost(region: string): string {
    return KIRO_API_HOST_TEMPLATE.replace("{region}", region)
}

export function getKiroQHost(region: string): string {
    return KIRO_Q_HOST_TEMPLATE.replace("{region}", region)
}

// ==================================================================================================
// Model Mapping (External names -> Kiro internal IDs)
// ==================================================================================================

export const MODEL_MAPPING: Record<string, string> = {
    // Claude Opus 4.5 - Top tier model
    "claude-opus-4-5": "claude-opus-4.5",
    "claude-opus-4-5-20251101": "claude-opus-4.5",

    // Claude Haiku 4.5 - Fast model
    "claude-haiku-4-5": "claude-haiku-4.5",
    "claude-haiku-4.5": "claude-haiku-4.5",

    // Claude Sonnet 4.5 - Enhanced model
    "claude-sonnet-4-5": "CLAUDE_SONNET_4_5_20250929_V1_0",
    "claude-sonnet-4-5-20250929": "CLAUDE_SONNET_4_5_20250929_V1_0",

    // Claude Sonnet 4 - Balanced model
    "claude-sonnet-4": "CLAUDE_SONNET_4_20250514_V1_0",
    "claude-sonnet-4-20250514": "CLAUDE_SONNET_4_20250514_V1_0",

    // Claude 3.7 Sonnet - Legacy model
    "claude-3-7-sonnet-20250219": "CLAUDE_3_7_SONNET_20250219_V1_0",

    // Convenience aliases
    "auto": "claude-sonnet-4.5",
}

// Available models list for /v1/models endpoint
export const AVAILABLE_MODELS = [
    { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5 (20251101)" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5 (20250929)" },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4 (20250514)" },
    { id: "claude-3-7-sonnet-20250219", name: "Claude 3.7 Sonnet" },
]

/**
 * Convert external model name to Kiro internal ID
 */
export function getInternalModelId(externalModel: string): string {
    return MODEL_MAPPING[externalModel] || externalModel
}

/**
 * Get adaptive timeout based on model type
 * Slow models (like Opus) get longer timeouts
 */
export function getAdaptiveTimeout(model: string, baseTimeout: number): number {
    if (!model) return baseTimeout

    const modelLower = model.toLowerCase()
    for (const slowModel of SLOW_MODELS) {
        if (modelLower.includes(slowModel.toLowerCase())) {
            return baseTimeout * config.slowModelTimeoutMultiplier
        }
    }

    return baseTimeout
}

// ==================================================================================================
// Version Info
// ==================================================================================================

export const APP_VERSION = "1.0.0"
export const APP_TITLE = "Kiro API Gateway"
export const APP_DESCRIPTION = "OpenAI & Anthropic compatible Kiro API gateway"

// ==================================================================================================
// Protocol Constants (from AIClient-2-API)
// ==================================================================================================

export const PROTOCOL = {
    OPENAI: "openai",
    ANTHROPIC: "anthropic",
    GEMINI: "gemini",
    KIRO: "kiro",
    OLLAMA: "ollama",
} as const

export type Protocol = typeof PROTOCOL[keyof typeof PROTOCOL]

export const ENDPOINT_TYPE = {
    OPENAI_CHAT: "openai_chat",
    OPENAI_COMPLETIONS: "openai_completions",
    ANTHROPIC_MESSAGES: "anthropic_messages",
    GEMINI_GENERATE: "gemini_generate",
    MODEL_LIST: "model_list",
} as const

export type EndpointType = typeof ENDPOINT_TYPE[keyof typeof ENDPOINT_TYPE]

// ==================================================================================================
// Model Context Lengths (from AIClient-2-API)
// ==================================================================================================

export const MODEL_CONTEXT = {
    // Claude models
    CLAUDE_OPUS_45: { context: 200000, maxOutput: 64000 },
    CLAUDE_SONNET_45: { context: 200000, maxOutput: 64000 },
    CLAUDE_HAIKU_45: { context: 200000, maxOutput: 64000 },
    CLAUDE_SONNET_4: { context: 200000, maxOutput: 64000 },
    CLAUDE_SONNET_37: { context: 200000, maxOutput: 64000 },
    CLAUDE_DEFAULT: { context: 200000, maxOutput: 8192 },

    // Gemini models
    GEMINI_25_PRO: { context: 1048576, maxOutput: 65534 },
    GEMINI_25_FLASH: { context: 1048576, maxOutput: 65534 },
    GEMINI_20_FLASH: { context: 1048576, maxOutput: 65534 },
    GEMINI_15_PRO: { context: 2097152, maxOutput: 65534 },
    GEMINI_DEFAULT: { context: 1048576, maxOutput: 65534 },

    // OpenAI models
    GPT4_TURBO: { context: 128000, maxOutput: 8192 },
    GPT4_BASE: { context: 8192, maxOutput: 8192 },
    GPT35_16K: { context: 16385, maxOutput: 8192 },
    GPT35_BASE: { context: 4096, maxOutput: 4096 },

    // Default
    DEFAULT: { context: 128000, maxOutput: 8192 },
} as const

/**
 * Get model context info by model name
 */
export function getModelContext(modelName: string): { context: number; maxOutput: number } {
    const name = modelName.toLowerCase()

    // Claude models
    if (name.includes("claude")) {
        if (name.includes("opus-4-5") || name.includes("opus-4.5")) {
            return MODEL_CONTEXT.CLAUDE_OPUS_45
        }
        if (name.includes("sonnet-4-5") || name.includes("sonnet-4.5")) {
            return MODEL_CONTEXT.CLAUDE_SONNET_45
        }
        if (name.includes("haiku-4-5") || name.includes("haiku-4.5")) {
            return MODEL_CONTEXT.CLAUDE_HAIKU_45
        }
        if (name.includes("sonnet-4") || name.includes("sonnet-3-7") || name.includes("sonnet-3.7")) {
            return MODEL_CONTEXT.CLAUDE_SONNET_4
        }
        return MODEL_CONTEXT.CLAUDE_DEFAULT
    }

    // Gemini models
    if (name.includes("gemini")) {
        if (name.includes("2.5") && name.includes("pro")) {
            return MODEL_CONTEXT.GEMINI_25_PRO
        }
        if (name.includes("2.5") && name.includes("flash")) {
            return MODEL_CONTEXT.GEMINI_25_FLASH
        }
        if (name.includes("2.0") && name.includes("flash")) {
            return MODEL_CONTEXT.GEMINI_20_FLASH
        }
        if (name.includes("1.5") && name.includes("pro")) {
            return MODEL_CONTEXT.GEMINI_15_PRO
        }
        return MODEL_CONTEXT.GEMINI_DEFAULT
    }

    // GPT models
    if (name.includes("gpt-4")) {
        if (name.includes("turbo") || name.includes("preview")) {
            return MODEL_CONTEXT.GPT4_TURBO
        }
        return MODEL_CONTEXT.GPT4_BASE
    }
    if (name.includes("gpt-3.5")) {
        if (name.includes("16k")) {
            return MODEL_CONTEXT.GPT35_16K
        }
        return MODEL_CONTEXT.GPT35_BASE
    }

    return MODEL_CONTEXT.DEFAULT
}

// ==================================================================================================
// Default Values for Conversions
// ==================================================================================================

export const DEFAULTS = {
    MAX_TOKENS: 8192,
    TEMPERATURE: 1.0,
    TOP_P: 0.95,
    TOP_K: 40,
} as const

