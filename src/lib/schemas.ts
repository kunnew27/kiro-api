/**
 * Zod Schemas for OpenAPI Documentation
 * Converted from TypeScript interfaces in routes/openai/types.ts and routes/anthropic/types.ts
 */

import { z } from "@hono/zod-openapi"

// ==================================================================================================
// OpenAI Schemas
// ==================================================================================================

export const OpenAIToolCallSchema = z.object({
    id: z.string(),
    type: z.literal("function"),
    function: z.object({
        name: z.string(),
        arguments: z.string(),
    }),
}).openapi("OpenAIToolCall")

export const OpenAIChatMessageSchema = z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(z.any()), z.null()]),
    name: z.string().optional(),
    tool_calls: z.array(OpenAIToolCallSchema).optional(),
    tool_call_id: z.string().optional(),
}).openapi("OpenAIChatMessage")

export const OpenAIToolFunctionSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.any()).optional(),
}).openapi("OpenAIToolFunction")

// Strict OpenAI format tool
const StrictOpenAIToolSchema = z.object({
    type: z.literal("function"),
    function: OpenAIToolFunctionSchema,
})

// Anthropic format tool (flat structure with input_schema)
const AnthropicStyleToolSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.any()),
})

// Flat tool format (name + parameters without function wrapper)
const FlatToolSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.any()).optional(),
})

// Accept multiple tool formats - will be normalized in handler
export const OpenAIToolSchema = z.union([
    StrictOpenAIToolSchema,
    AnthropicStyleToolSchema,
    FlatToolSchema,
]).openapi("OpenAITool")

export const OpenAIChatRequestSchema = z.object({
    model: z.string().openapi({ example: "claude-sonnet-4-5" }),
    messages: z.array(OpenAIChatMessageSchema),
    stream: z.boolean().optional().default(false),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    n: z.number().optional(),
    max_tokens: z.number().optional(),
    max_completion_tokens: z.number().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    tools: z.array(OpenAIToolSchema).optional(),
    tool_choice: z.union([
        z.string(),
        z.object({
            type: z.string(),
            function: z.object({ name: z.string() }).optional(),
            name: z.string().optional(),  // Anthropic style
        }),
    ]).optional(),
    stream_options: z.record(z.string(), z.any()).optional(),
    logit_bias: z.record(z.string(), z.number()).optional(),
    logprobs: z.boolean().optional(),
    top_logprobs: z.number().optional(),
    user: z.string().optional(),
    seed: z.number().optional(),
    parallel_tool_calls: z.boolean().optional(),
}).openapi("OpenAIChatRequest")

export const OpenAIChatCompletionUsageSchema = z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
    credits_used: z.number().optional(),
}).openapi("OpenAIChatCompletionUsage")

export const OpenAIChatCompletionChoiceSchema = z.object({
    index: z.number(),
    message: z.object({
        role: z.string(),
        content: z.string().nullable(),
        tool_calls: z.array(OpenAIToolCallSchema).optional(),
    }),
    finish_reason: z.string().nullable(),
}).openapi("OpenAIChatCompletionChoice")

export const OpenAIChatCompletionResponseSchema = z.object({
    id: z.string(),
    object: z.literal("chat.completion"),
    created: z.number(),
    model: z.string(),
    choices: z.array(OpenAIChatCompletionChoiceSchema),
    usage: OpenAIChatCompletionUsageSchema,
}).openapi("OpenAIChatCompletionResponse")

export const OpenAIErrorResponseSchema = z.object({
    error: z.object({
        message: z.string(),
        type: z.string(),
        code: z.union([z.number(), z.string()]),
    }),
}).openapi("OpenAIErrorResponse")

// ==================================================================================================
// Anthropic Schemas
// ==================================================================================================

export const AnthropicContentBlockSchema = z.object({
    type: z.enum(["text", "image", "tool_use", "tool_result", "thinking"]),
    text: z.string().optional(),
    source: z.object({
        type: z.enum(["base64", "url"]),
        media_type: z.string().optional(),
        data: z.string().optional(),
        url: z.string().optional(),
    }).optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.record(z.string(), z.any()).optional(),
    tool_use_id: z.string().optional(),
    content: z.union([z.string(), z.array(z.any())]).optional(),
    is_error: z.boolean().optional(),
    thinking: z.string().optional(),
}).openapi("AnthropicContentBlock")

export const AnthropicMessageSchema = z.object({
    role: z.enum(["user", "assistant"]),
    content: z.union([z.string(), z.array(AnthropicContentBlockSchema)]),
}).openapi("AnthropicMessage")

export const AnthropicToolSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.any()),
}).openapi("AnthropicTool")

export const AnthropicMessagesRequestSchema = z.object({
    model: z.string().openapi({ example: "claude-sonnet-4-5" }),
    messages: z.array(AnthropicMessageSchema),
    max_tokens: z.number(),
    system: z.union([
        z.string(),
        z.array(z.object({ type: z.string(), text: z.string() })),
    ]).optional(),
    tools: z.array(AnthropicToolSchema).optional(),
    tool_choice: z.object({
        type: z.enum(["auto", "any", "tool", "none"]),
        name: z.string().optional(),
    }).optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().optional(),
    stop_sequences: z.array(z.string()).optional(),
    stream: z.boolean().optional().default(false),
    metadata: z.record(z.string(), z.any()).optional(),
    thinking: z.object({
        type: z.literal("enabled"),
        budget_tokens: z.number().optional(),
    }).optional(),
}).openapi("AnthropicMessagesRequest")

export const AnthropicUsageSchema = z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
}).openapi("AnthropicUsage")

export const AnthropicResponseContentBlockSchema = z.object({
    type: z.enum(["text", "tool_use", "thinking"]),
    text: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.record(z.string(), z.any()).optional(),
    thinking: z.string().optional(),
}).openapi("AnthropicResponseContentBlock")

export const AnthropicMessagesResponseSchema = z.object({
    id: z.string(),
    type: z.literal("message"),
    role: z.literal("assistant"),
    content: z.array(AnthropicResponseContentBlockSchema),
    model: z.string(),
    stop_reason: z.enum(["end_turn", "max_tokens", "tool_use", "stop_sequence"]).nullable(),
    stop_sequence: z.string().nullable(),
    usage: AnthropicUsageSchema,
}).openapi("AnthropicMessagesResponse")

export const AnthropicErrorResponseSchema = z.object({
    type: z.literal("error"),
    error: z.object({
        type: z.string(),
        message: z.string(),
    }),
}).openapi("AnthropicErrorResponse")

// ==================================================================================================
// Models Schemas
// ==================================================================================================

export const ModelSchema = z.object({
    id: z.string(),
    type: z.literal("model"),
    object: z.literal("model"),
    created_at: z.string(),
    created: z.number(),
    owned_by: z.string(),
    display_name: z.string(),
}).openapi("Model")

export const ModelsListResponseSchema = z.object({
    object: z.literal("list"),
    data: z.array(ModelSchema),
    has_more: z.boolean(),
    first_id: z.string().optional(),
    last_id: z.string().optional(),
}).openapi("ModelsListResponse")

// ==================================================================================================
// Health & Info Schemas
// ==================================================================================================

export const HealthResponseSchema = z.object({
    status: z.literal("healthy"),
    timestamp: z.string(),
    version: z.string(),
    token_valid: z.boolean(),
    cache_size: z.number(),
    cache_last_update: z.number().nullable(),
}).openapi("HealthResponse")

export const InfoResponseSchema = z.object({
    status: z.literal("ok"),
    message: z.string(),
    version: z.string(),
    description: z.string().optional(),
}).openapi("InfoResponse")

export const MetricsResponseSchema = z.object({
    uptime: z.number(),
    timestamp: z.string(),
    version: z.string(),
    auth_cache_size: z.number(),
}).openapi("MetricsResponse")

