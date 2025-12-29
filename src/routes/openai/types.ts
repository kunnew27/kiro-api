/**
 * OpenAI API Types
 */

// ==================================================================================================
// Request Types
// ==================================================================================================

export interface OpenAIChatMessage {
    role: "system" | "user" | "assistant" | "tool"
    content: string | any[] | null
    name?: string
    tool_calls?: OpenAIToolCall[]
    tool_call_id?: string
}

export interface OpenAIToolCall {
    id: string
    type: "function"
    function: {
        name: string
        arguments: string
    }
}

export interface OpenAIToolFunction {
    name: string
    description?: string
    parameters?: Record<string, any>
}

export interface OpenAITool {
    type: "function"
    function: OpenAIToolFunction
}

export interface OpenAIChatRequest {
    model: string
    messages: OpenAIChatMessage[]
    stream?: boolean
    temperature?: number
    top_p?: number
    n?: number
    max_tokens?: number
    max_completion_tokens?: number
    stop?: string | string[]
    presence_penalty?: number
    frequency_penalty?: number
    tools?: OpenAITool[]
    tool_choice?: string | { type: string; function: { name: string } }
    stream_options?: Record<string, any>
    logit_bias?: Record<string, number>
    logprobs?: boolean
    top_logprobs?: number
    user?: string
    seed?: number
    parallel_tool_calls?: boolean
}

// ==================================================================================================
// Response Types
// ==================================================================================================

export interface OpenAIModel {
    id: string
    object: "model"
    created: number
    owned_by: string
    description?: string
}

export interface OpenAIModelList {
    object: "list"
    data: OpenAIModel[]
}

export interface OpenAIChatCompletionChoice {
    index: number
    message: {
        role: string
        content: string | null
        tool_calls?: OpenAIToolCall[]
    }
    finish_reason: string | null
}

export interface OpenAIChatCompletionUsage {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    credits_used?: number
}

export interface OpenAIChatCompletionResponse {
    id: string
    object: "chat.completion"
    created: number
    model: string
    choices: OpenAIChatCompletionChoice[]
    usage: OpenAIChatCompletionUsage
}

export interface OpenAIChatCompletionChunkDelta {
    role?: string
    content?: string
    tool_calls?: any[]
}

export interface OpenAIChatCompletionChunkChoice {
    index: number
    delta: OpenAIChatCompletionChunkDelta
    finish_reason: string | null
}

export interface OpenAIChatCompletionChunk {
    id: string
    object: "chat.completion.chunk"
    created: number
    model: string
    choices: OpenAIChatCompletionChunkChoice[]
    usage?: OpenAIChatCompletionUsage
}

// ==================================================================================================
// Error Types
// ==================================================================================================

export interface OpenAIErrorResponse {
    error: {
        message: string
        type: string
        code: number | string
    }
}

