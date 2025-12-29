/**
 * Anthropic API Types
 */

// ==================================================================================================
// Request Types
// ==================================================================================================

export interface AnthropicContentBlock {
    type: "text" | "image" | "tool_use" | "tool_result" | "thinking"
    text?: string
    // image fields
    source?: {
        type: "base64" | "url"
        media_type?: string
        data?: string
        url?: string
    }
    // tool_use fields
    id?: string
    name?: string
    input?: Record<string, any>
    // tool_result fields
    tool_use_id?: string
    content?: string | any[]
    is_error?: boolean
    // thinking fields
    thinking?: string
}

export interface AnthropicMessage {
    role: "user" | "assistant"
    content: string | AnthropicContentBlock[]
}

export interface AnthropicTool {
    name: string
    description?: string
    input_schema: Record<string, any>
}

export interface AnthropicMessagesRequest {
    model: string
    messages: AnthropicMessage[]
    max_tokens: number
    system?: string | Array<{ type: string; text: string }>
    tools?: AnthropicTool[]
    tool_choice?: {
        type: "auto" | "any" | "tool" | "none"
        name?: string
    }
    temperature?: number
    top_p?: number
    top_k?: number
    stop_sequences?: string[]
    stream?: boolean
    metadata?: Record<string, any>
    thinking?: {
        type: "enabled"
        budget_tokens?: number
    }
}

// ==================================================================================================
// Response Types
// ==================================================================================================

export interface AnthropicUsage {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
}

export interface AnthropicResponseContentBlock {
    type: "text" | "tool_use" | "thinking"
    text?: string
    id?: string
    name?: string
    input?: Record<string, any>
    thinking?: string
}

export interface AnthropicMessagesResponse {
    id: string
    type: "message"
    role: "assistant"
    content: AnthropicResponseContentBlock[]
    model: string
    stop_reason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | null
    stop_sequence: string | null
    usage: AnthropicUsage
}

// ==================================================================================================
// Streaming Event Types
// ==================================================================================================

export interface AnthropicMessageStartEvent {
    type: "message_start"
    message: {
        id: string
        type: "message"
        role: "assistant"
        content: any[]
        model: string
        stop_reason: null
        stop_sequence: null
        usage: AnthropicUsage
    }
}

export interface AnthropicContentBlockStartEvent {
    type: "content_block_start"
    index: number
    content_block: {
        type: "text" | "tool_use"
        text?: string
        id?: string
        name?: string
        input?: Record<string, any>
    }
}

export interface AnthropicContentBlockDeltaEvent {
    type: "content_block_delta"
    index: number
    delta: {
        type: "text_delta" | "input_json_delta"
        text?: string
        partial_json?: string
    }
}

export interface AnthropicContentBlockStopEvent {
    type: "content_block_stop"
    index: number
}

export interface AnthropicMessageDeltaEvent {
    type: "message_delta"
    delta: {
        stop_reason: string
        stop_sequence: string | null
    }
    usage: {
        output_tokens: number
    }
}

export interface AnthropicMessageStopEvent {
    type: "message_stop"
}

export interface AnthropicErrorEvent {
    type: "error"
    error: {
        type: string
        message: string
    }
}

// ==================================================================================================
// Error Types
// ==================================================================================================

export interface AnthropicErrorResponse {
    type: "error"
    error: {
        type: string
        message: string
    }
}

