/**
 * Gemini API Types
 * Based on Google's Gemini API format
 */

// ==================================================================================================
// Request Types
// ==================================================================================================

export interface GeminiPart {
    text?: string
    inlineData?: {
        mimeType: string
        data: string
    }
    fileData?: {
        mimeType: string
        fileUri: string
    }
    functionCall?: {
        name: string
        args: Record<string, any>
    }
    functionResponse?: {
        name: string
        response: {
            name: string
            content: string
        }
    }
}

export interface GeminiContent {
    role: "user" | "model"
    parts: GeminiPart[]
}

export interface GeminiFunctionDeclaration {
    name: string
    description?: string
    parameters?: {
        type: string
        properties?: Record<string, any>
        required?: string[]
    }
}

export interface GeminiTool {
    functionDeclarations?: GeminiFunctionDeclaration[]
}

export interface GeminiToolConfig {
    functionCallingConfig?: {
        mode: "AUTO" | "ANY" | "NONE"
        allowedFunctionNames?: string[]
    }
}

export interface GeminiGenerationConfig {
    temperature?: number
    topP?: number
    topK?: number
    maxOutputTokens?: number
    stopSequences?: string[]
    responseMimeType?: string
    responseSchema?: any
    responseModalities?: string[]
}

export interface GeminiSystemInstruction {
    parts: GeminiPart[]
}

export interface GeminiGenerateContentRequest {
    contents: GeminiContent[]
    systemInstruction?: GeminiSystemInstruction
    tools?: GeminiTool[]
    toolConfig?: GeminiToolConfig
    generationConfig?: GeminiGenerationConfig
}

// ==================================================================================================
// Response Types
// ==================================================================================================

export interface GeminiCandidate {
    content: GeminiContent
    finishReason?: "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "OTHER"
    safetyRatings?: any[]
    citationMetadata?: any
}

export interface GeminiUsageMetadata {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
    cachedContentTokenCount?: number
    promptTokensDetails?: Array<{
        modality: string
        tokenCount: number
    }>
    candidatesTokensDetails?: Array<{
        modality: string
        tokenCount: number
    }>
    thoughtsTokenCount?: number
}

export interface GeminiGenerateContentResponse {
    candidates: GeminiCandidate[]
    usageMetadata?: GeminiUsageMetadata
    modelVersion?: string
}

// ==================================================================================================
// Streaming Types
// ==================================================================================================

export interface GeminiStreamChunk {
    candidates?: GeminiCandidate[]
    usageMetadata?: GeminiUsageMetadata
}
