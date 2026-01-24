import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import z from "zod"
import { Provider } from "../provider/provider"
import { Log } from "../util/log"
import { generateText, streamText, type CoreMessage, type LanguageModelV2 } from "ai"

const log = Log.create({ service: "openai-compat" })

// OpenAI-compatible request/response schemas
const ChatCompletionMessage = z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string().nullable(),
    name: z.string().optional(),
    tool_calls: z.array(z.any()).optional(),
    tool_call_id: z.string().optional(),
})

const ChatCompletionRequest = z.object({
    model: z.string(),
    messages: z.array(ChatCompletionMessage),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().optional(),
    stream: z.boolean().optional().default(false),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    user: z.string().optional(),
    // Tool calling support
    tools: z.array(z.any()).optional(),
    tool_choice: z.any().optional(),
    // Streaming options
    stream_options: z.any().optional(),
}).passthrough()

type ChatCompletionRequest = z.infer<typeof ChatCompletionRequest>

// OpenAI Responses API request schema (used by Cursor)
// Made very flexible to accept various input formats
const ResponsesApiRequest = z.object({
    model: z.string(),
    input: z.union([
        z.string(),
        z.array(z.any())  // Accept any array format - Cursor sends various formats
    ]),
    instructions: z.string().optional(),
    temperature: z.number().optional(),
    max_output_tokens: z.number().optional(),
    stream: z.boolean().optional().default(true),
    tools: z.array(z.any()).optional(),
    tool_choice: z.any().optional(),
    previous_response_id: z.string().optional(),
}).passthrough()

type ResponsesApiRequest = z.infer<typeof ResponsesApiRequest>

// Transform Responses API input to CoreMessage format
function transformResponsesInput(input: ResponsesApiRequest["input"]): CoreMessage[] {
    if (typeof input === "string") {
        return [{ role: "user" as const, content: input }]
    }

    return input.map((item: any, index: number) => {
        const role = item.role || "user"
        let content = ""

        // Log the structure for debugging
        if (index < 5) {  // Only log first 5 messages to avoid spam
            log.info("transformResponsesInput item", {
                index,
                role,
                contentType: typeof item.content,
                contentIsArray: Array.isArray(item.content),
                hasToolCalls: !!item.tool_calls,
                hasToolCallId: !!item.tool_call_id,
                itemKeys: Object.keys(item).join(", "),
                contentSample: Array.isArray(item.content)
                    ? JSON.stringify(item.content.slice(0, 2).map((c: any) => ({ type: c.type, keys: Object.keys(c) }))).substring(0, 300)
                    : (typeof item.content === "string" ? item.content.substring(0, 100) : "N/A"),
            })
        }

        if (typeof item.content === "string") {
            content = item.content
        } else if (Array.isArray(item.content)) {
            // Extract text from content parts - handle various types
            const textParts = item.content
                .map((p: any) => {
                    // Handle different content types
                    if (p.type === "input_text" || p.type === "text" || p.type === "output_text") {
                        return p.text || ""
                    }
                    if (p.type === "tool_result" || p.type === "function_call_output") {
                        // Tool results may have nested content
                        if (typeof p.content === "string") return p.content
                        if (typeof p.output === "string") return p.output
                        if (Array.isArray(p.content)) {
                            return p.content.map((c: any) => c.text || c.content || "").join("")
                        }
                        return JSON.stringify(p.output || p.content || p)
                    }
                    // For any other type, try to extract text or stringify
                    if (p.text) return p.text
                    if (p.content) return typeof p.content === "string" ? p.content : JSON.stringify(p.content)
                    return ""
                })
                .filter((t: string) => t.length > 0)

            content = textParts.join("\n")

            // Log extracted content for debugging
            if (index < 5) {
                log.info("extracted content from array", {
                    index,
                    partsCount: item.content.length,
                    extractedLength: content.length,
                    extractedSample: content.substring(0, 200),
                })
            }
        } else if (item.content === undefined && item.tool_calls) {
            // Assistant message with tool calls
            content = JSON.stringify(item.tool_calls)
        }

        // Handle tool role (tool results)
        if (role === "tool" && item.tool_call_id) {
            // For AI SDK, tool results are typically sent as user messages
            return { role: "user" as const, content: `Tool result for ${item.tool_call_id}: ${content}` }
        }

        if (role === "system") {
            return { role: "system" as const, content }
        } else if (role === "assistant") {
            return { role: "assistant" as const, content }
        }
        return { role: "user" as const, content }
    })
}

// Transform OpenAI messages to AI SDK format
function transformMessages(messages: ChatCompletionRequest["messages"]): CoreMessage[] {
    return messages.map((msg) => {
        if (msg.role === "system") {
            return { role: "system" as const, content: msg.content ?? "" }
        }
        if (msg.role === "user") {
            return { role: "user" as const, content: msg.content ?? "" }
        }
        if (msg.role === "assistant") {
            return { role: "assistant" as const, content: msg.content ?? "" }
        }
        // For tool messages, return as user message with tool content
        return { role: "user" as const, content: msg.content ?? "" }
    })
}

// Generate unique ID
function generateId(): string {
    return "chatcmpl-" + Math.random().toString(36).substring(2, 15)
}

// Generate response ID for Responses API
function generateResponseId(): string {
    return "resp_" + Math.random().toString(36).substring(2, 15)
}

// Get the chat HTML file path
const CHAT_HTML_PATH = new URL("./chat.html", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")

export const OpenAICompatRoute = new Hono()
    // Chat UI - serves the HTML chat interface
    .get("/chat", async (c) => {
        try {
            const html = await Bun.file(CHAT_HTML_PATH).text()
            return c.html(html)
        } catch (e) {
            log.error("Failed to load chat.html", { error: e })
            return c.text("Chat interface not found", 404)
        }
    })

    // List models endpoint
    .get("/v1/models", async (c) => {
        log.info("listing models")
        const providers = await Provider.list()

        const models = Object.entries(providers).flatMap(([providerID, provider]) =>
            Object.entries(provider.models).map(([modelID, model]) => ({
                id: `${providerID}/${modelID}`,
                object: "model" as const,
                created: Math.floor(Date.now() / 1000),
                owned_by: providerID,
                permission: [],
                root: modelID,
                parent: null,
            }))
        )

        return c.json({
            object: "list",
            data: models,
        })
    })

    // Get single model
    .get("/v1/models/:modelId", async (c) => {
        const modelId = c.req.param("modelId")
        // Handle URL-encoded model IDs (e.g., openai%2Fgpt-5.1-codex)
        const decodedModelId = decodeURIComponent(modelId)

        const { providerID, modelID } = Provider.parseModel(decodedModelId)

        try {
            const model = await Provider.getModel(providerID, modelID)
            return c.json({
                id: `${providerID}/${modelID}`,
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: providerID,
                permission: [],
                root: modelID,
                parent: null,
            })
        } catch (e) {
            return c.json({ error: { message: `Model not found: ${decodedModelId}`, type: "invalid_request_error" } }, 404)
        }
    })

    // Chat completions endpoint
    // Also handles Responses API format (auto-detect via 'input' field) for Cursor compatibility
    .post("/v1/chat/completions", async (c) => {
        const body = await c.req.json()

        // Log the raw request for debugging
        log.info("chat completions raw request", {
            hasInput: "input" in body,
            hasMessages: "messages" in body,
            model: body.model,
            stream: body.stream,
            keys: Object.keys(body).join(", "),
        })

        // Auto-detect Responses API format (Cursor sends this format)
        // IMPORTANT: Cursor's client expects Chat Completions SSE format, not Responses API format
        // So we transform the input to messages and return Chat Completions format
        if ("input" in body && !("messages" in body)) {
            log.info("detected Responses API format from Cursor, converting to Chat Completions format")

            const responsesApiParsed = ResponsesApiRequest.safeParse(body)
            if (!responsesApiParsed.success) {
                log.error("Responses API parse failed", {
                    error: responsesApiParsed.error.message,
                    issues: JSON.stringify(responsesApiParsed.error.issues)
                })
                return c.json(
                    { error: { message: "Invalid Responses API request", type: "invalid_request_error", details: responsesApiParsed.error } },
                    400
                )
            }

            const request = responsesApiParsed.data
            log.info("cursor request parsed successfully", {
                model: request.model,
                inputType: typeof request.input,
                inputIsArray: Array.isArray(request.input),
                inputSample: JSON.stringify(request.input).substring(0, 500),
                hasInstructions: !!request.instructions,
                stream: request.stream,
            })

            const { providerID, modelID } = Provider.parseModel(request.model)
            log.info("cursor model parsed", { providerID, modelID })

            let modelInfo: Provider.Model
            let language: LanguageModelV2

            try {
                modelInfo = await Provider.getModel(providerID, modelID)
                log.info("cursor model info loaded", { modelId: modelInfo.id })
                language = await Provider.getLanguage(modelInfo)
                log.info("cursor language model created")
            } catch (e) {
                log.error("model not found", { model: request.model, error: e })
                return c.json(
                    { error: { message: `Model not found: ${request.model}`, type: "invalid_request_error" } },
                    404
                )
            }

            // Transform Responses API input to messages
            const allMessages = transformResponsesInput(request.input)

            // Extract system message and filter it out (for OpenAI Responses API)
            const systemMessage = allMessages.find(m => m.role === "system")
            const messages = allMessages.filter(m => m.role !== "system")

            // Use request.instructions if provided, otherwise use system message from input, or default
            const instructions = request.instructions
                ?? (typeof systemMessage?.content === "string" ? systemMessage.content : null)
                ?? "You are a helpful assistant."

            // Log transformed messages
            log.info("transformed messages for LLM", {
                count: messages.length,
                roles: messages.map(m => m.role).join(", "),
                totalContentLength: messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0),
                instructionsLength: instructions.length,
            })

            const completionId = generateId()
            const created = Math.floor(Date.now() / 1000)

            const options: any = {
                model: language,
                messages,
                providerOptions: {
                    openai: {
                        instructions,
                        store: false,
                    },
                },
            }

            if (request.temperature !== undefined) options.temperature = request.temperature
            if (request.max_output_tokens !== undefined) options.maxTokens = request.max_output_tokens

            // Pass tools if provided by Cursor
            // NOTE: Currently disabled due to OpenAI Responses API schema validation issues
            // Cursor sends tools with invalid schemas (type: "None") that OpenAI rejects
            if (request.tools && request.tools.length > 0) {
                log.info("cursor request has tools (not passing to LLM due to schema issues)", {
                    toolCount: request.tools.length,
                })
                // TODO: Implement proper tool schema sanitization for OpenAI Responses API
                // The AI SDK passes tools directly to OpenAI which rejects invalid schemas
            }

            log.info("cursor starting streaming", { model: request.model, messageCount: messages.length, hasTools: !!options.tools })

            // Return Chat Completions SSE format (what Cursor's client expects)
            return streamSSE(c, async (stream) => {
                log.info("cursor SSE callback started")
                try {
                    log.info("cursor calling streamText")
                    const result = streamText(options)
                    let isFirstChunk = true
                    let chunkCount = 0
                    let hasToolCalls = false
                    const toolCalls: any[] = []

                    log.info("cursor starting to iterate fullStream")
                    // Use fullStream to get both text and tool calls
                    for await (const part of result.fullStream) {
                        if (part.type === "text-delta") {
                            // AI SDK uses 'text' for OpenAI Responses API, 'textDelta' for others
                            const textDelta = (part as any).text ?? part.textDelta ?? ""
                            if (!textDelta) continue  // Skip empty deltas

                            chunkCount++
                            if (chunkCount === 1) {
                                log.info("cursor received first text chunk", { chunkLength: textDelta.length })
                            }
                            const data: any = {
                                id: completionId,
                                object: "chat.completion.chunk",
                                created,
                                model: request.model,
                                system_fingerprint: "fp_opencode",
                                choices: [
                                    {
                                        index: 0,
                                        delta: isFirstChunk
                                            ? { role: "assistant", content: textDelta }
                                            : { content: textDelta },
                                        finish_reason: null,
                                    },
                                ],
                            }
                            isFirstChunk = false
                            await stream.writeSSE({ data: JSON.stringify(data) })
                        } else if (part.type === "tool-call") {
                            // Tool call completed
                            hasToolCalls = true
                            log.info("cursor received tool call", { toolName: part.toolName, toolCallId: part.toolCallId })
                            toolCalls.push({
                                id: part.toolCallId,
                                type: "function",
                                function: {
                                    name: part.toolName,
                                    arguments: JSON.stringify(part.args),
                                },
                            })
                        } else if (part.type === "tool-call-streaming-start") {
                            // Tool call starting - send initial chunk with role
                            hasToolCalls = true
                            const toolCallIndex = toolCalls.length
                            toolCalls.push({ id: part.toolCallId, name: part.toolName, arguments: "" })

                            const data: any = {
                                id: completionId,
                                object: "chat.completion.chunk",
                                created,
                                model: request.model,
                                system_fingerprint: "fp_opencode",
                                choices: [
                                    {
                                        index: 0,
                                        delta: isFirstChunk
                                            ? {
                                                role: "assistant",
                                                tool_calls: [{
                                                    index: toolCallIndex,
                                                    id: part.toolCallId,
                                                    type: "function",
                                                    function: { name: part.toolName, arguments: "" }
                                                }]
                                            }
                                            : {
                                                tool_calls: [{
                                                    index: toolCallIndex,
                                                    id: part.toolCallId,
                                                    type: "function",
                                                    function: { name: part.toolName, arguments: "" }
                                                }]
                                            },
                                        finish_reason: null,
                                    },
                                ],
                            }
                            isFirstChunk = false
                            await stream.writeSSE({ data: JSON.stringify(data) })
                        } else if (part.type === "tool-call-delta") {
                            // Tool call argument delta
                            const toolCallIndex = toolCalls.findIndex(tc => tc.id === part.toolCallId)
                            if (toolCallIndex >= 0) {
                                toolCalls[toolCallIndex].arguments = (toolCalls[toolCallIndex].arguments || "") + part.argsTextDelta

                                const data: any = {
                                    id: completionId,
                                    object: "chat.completion.chunk",
                                    created,
                                    model: request.model,
                                    system_fingerprint: "fp_opencode",
                                    choices: [
                                        {
                                            index: 0,
                                            delta: {
                                                tool_calls: [{
                                                    index: toolCallIndex,
                                                    function: { arguments: part.argsTextDelta }
                                                }]
                                            },
                                            finish_reason: null,
                                        },
                                    ],
                                }
                                await stream.writeSSE({ data: JSON.stringify(data) })
                            }
                        }
                    }

                    // Send final chunk with finish_reason
                    const finalData = {
                        id: completionId,
                        object: "chat.completion.chunk",
                        created,
                        model: request.model,
                        system_fingerprint: "fp_opencode",
                        choices: [
                            {
                                index: 0,
                                delta: {},
                                finish_reason: hasToolCalls ? "tool_calls" : "stop",
                            },
                        ],
                    }
                    await stream.writeSSE({ data: JSON.stringify(finalData) })
                    await stream.writeSSE({ data: "[DONE]" })
                    log.info("cursor streaming completed successfully", { model: request.model, chunkCount, hasToolCalls, toolCallCount: toolCalls.length })
                } catch (e: any) {
                    log.error("cursor streaming error", { error: e?.message, cause: e?.cause?.message, stack: e?.stack?.substring(0, 500) })
                    const errorData = {
                        error: { message: e?.message ?? "Unknown error", type: "server_error" },
                    }
                    await stream.writeSSE({ data: JSON.stringify(errorData) })
                }
            })
        }

        // Standard Chat Completions format
        const parsed = ChatCompletionRequest.safeParse(body)

        if (!parsed.success) {
            return c.json(
                { error: { message: "Invalid request body", type: "invalid_request_error", details: parsed.error } },
                400
            )
        }

        const request = parsed.data
        log.info("chat completion request", {
            model: request.model,
            stream: request.stream,
            messageCount: request.messages.length,
            hasTools: !!request.tools?.length,
            toolCount: request.tools?.length ?? 0,
        })

        // Parse model ID (format: provider/model)
        const { providerID, modelID } = Provider.parseModel(request.model)

        let modelInfo: Provider.Model
        let language: LanguageModelV2

        try {
            modelInfo = await Provider.getModel(providerID, modelID)
            language = await Provider.getLanguage(modelInfo)
        } catch (e) {
            log.error("model not found", { model: request.model, error: e })
            return c.json(
                { error: { message: `Model not found: ${request.model}`, type: "invalid_request_error" } },
                404
            )
        }

        const messages = transformMessages(request.messages)
        const completionId = generateId()
        const created = Math.floor(Date.now() / 1000)

        // Extract system message for models that require instructions (Responses API)
        const systemMessage = request.messages.find(m => m.role === "system")?.content
        const nonSystemMessages = messages.filter(m => m.role !== "system")
        const instructions = systemMessage ?? "You are a helpful assistant."

        // Build generation options
        const options: any = {
            model: language,
            messages: nonSystemMessages.length > 0 ? nonSystemMessages : messages,
            // Pass instructions via providerOptions for OpenAI Responses API
            providerOptions: {
                openai: {
                    instructions: instructions,
                    store: false,
                },
            },
        }

        if (request.temperature !== undefined) options.temperature = request.temperature
        if (request.max_tokens !== undefined) options.maxTokens = request.max_tokens
        if (request.top_p !== undefined) options.topP = request.top_p
        if (request.stop !== undefined) options.stopSequences = Array.isArray(request.stop) ? request.stop : [request.stop]
        if (request.presence_penalty !== undefined) options.presencePenalty = request.presence_penalty
        if (request.frequency_penalty !== undefined) options.frequencyPenalty = request.frequency_penalty

        // Handle streaming response
        if (request.stream) {
            return streamSSE(c, async (stream) => {
                try {
                    const result = streamText(options)
                    let isFirstChunk = true

                    for await (const chunk of result.textStream) {
                        const data: any = {
                            id: completionId,
                            object: "chat.completion.chunk",
                            created,
                            model: request.model,
                            system_fingerprint: "fp_opencode",
                            choices: [
                                {
                                    index: 0,
                                    delta: isFirstChunk
                                        ? { role: "assistant", content: chunk }
                                        : { content: chunk },
                                    finish_reason: null,
                                },
                            ],
                        }
                        isFirstChunk = false
                        await stream.writeSSE({ data: JSON.stringify(data) })
                    }

                    // Send final chunk with finish_reason
                    const finalData = {
                        id: completionId,
                        object: "chat.completion.chunk",
                        created,
                        model: request.model,
                        system_fingerprint: "fp_opencode",
                        choices: [
                            {
                                index: 0,
                                delta: {},
                                finish_reason: "stop",
                            },
                        ],
                    }
                    await stream.writeSSE({ data: JSON.stringify(finalData) })
                    await stream.writeSSE({ data: "[DONE]" })
                } catch (e) {
                    log.error("streaming error", { error: e })
                    const errorData = {
                        error: { message: e instanceof Error ? e.message : "Unknown error", type: "server_error" },
                    }
                    await stream.writeSSE({ data: JSON.stringify(errorData) })
                }
            })
        }

        // Handle non-streaming response (use streamText internally since some models require it)
        try {
            const result = streamText(options)

            // Collect all chunks into a single response
            let fullText = ""
            for await (const chunk of result.textStream) {
                fullText += chunk
            }

            // Get final result for usage info
            const finalResult = await result

            return c.json({
                id: completionId,
                object: "chat.completion",
                created,
                model: request.model,
                system_fingerprint: "fp_opencode",
                choices: [
                    {
                        index: 0,
                        message: {
                            role: "assistant",
                            content: fullText,
                        },
                        finish_reason: "stop",
                    },
                ],
                usage: {
                    prompt_tokens: (finalResult.usage as any)?.promptTokens ?? 0,
                    completion_tokens: (finalResult.usage as any)?.completionTokens ?? 0,
                    total_tokens: ((finalResult.usage as any)?.promptTokens ?? 0) + ((finalResult.usage as any)?.completionTokens ?? 0),
                },
            })
        } catch (e: any) {
            const errorMessage = e?.message ?? "Unknown error"
            const errorDetails = e?.cause?.message ?? e?.responseBody ?? e?.data ?? JSON.stringify(e)
            log.error("generation error", { error: errorMessage, details: errorDetails, stack: e?.stack })
            return c.json(
                {
                    error: {
                        message: errorMessage,
                        type: "server_error",
                        details: errorDetails
                    }
                },
                500
            )
        }
    })

    // Cursor-specific endpoint (Responses API format)
    // Cursor sends Responses API requests but expects them at /v1/chat/completions
    // This endpoint provides an alternative that properly handles Responses API format
    .post("/v1/cursor", async (c) => {
        const body = await c.req.json()

        // Try to parse as Responses API first, fall back to Chat Completions
        const responsesApiParsed = ResponsesApiRequest.safeParse(body)

        if (responsesApiParsed.success) {
            const request = responsesApiParsed.data
            log.info("cursor/responses request", {
                model: request.model,
                inputType: typeof request.input,
                hasInstructions: !!request.instructions,
            })

            const { providerID, modelID } = Provider.parseModel(request.model)

            let modelInfo: Provider.Model
            let language: LanguageModelV2

            try {
                modelInfo = await Provider.getModel(providerID, modelID)
                language = await Provider.getLanguage(modelInfo)
            } catch (e) {
                log.error("model not found", { model: request.model, error: e })
                return c.json(
                    { error: { message: `Model not found: ${request.model}`, type: "invalid_request_error" } },
                    404
                )
            }

            const messages = transformResponsesInput(request.input)
            const responseId = generateResponseId()
            const created = Math.floor(Date.now() / 1000)
            const instructions = request.instructions ?? "You are a helpful assistant."

            // Build generation options
            const options: any = {
                model: language,
                messages,
                providerOptions: {
                    openai: {
                        instructions,
                        store: false,
                    },
                },
            }

            if (request.temperature !== undefined) options.temperature = request.temperature
            if (request.max_output_tokens !== undefined) options.maxTokens = request.max_output_tokens

            // Responses API uses streaming by default
            return streamSSE(c, async (stream) => {
                try {
                    const result = streamText(options)
                    let fullContent = ""

                    // Send response.created event
                    await stream.writeSSE({
                        event: "response.created",
                        data: JSON.stringify({
                            type: "response.created",
                            response: {
                                id: responseId,
                                object: "response",
                                created_at: created,
                                status: "in_progress",
                                model: request.model,
                            }
                        })
                    })

                    // Stream content deltas
                    for await (const chunk of result.textStream) {
                        fullContent += chunk
                        await stream.writeSSE({
                            event: "response.output_text.delta",
                            data: JSON.stringify({
                                type: "response.output_text.delta",
                                delta: chunk,
                            })
                        })
                    }

                    // Send completion event
                    await stream.writeSSE({
                        event: "response.completed",
                        data: JSON.stringify({
                            type: "response.completed",
                            response: {
                                id: responseId,
                                object: "response",
                                created_at: created,
                                status: "completed",
                                model: request.model,
                                output: [{
                                    type: "message",
                                    role: "assistant",
                                    content: [{ type: "output_text", text: fullContent }]
                                }]
                            }
                        })
                    })

                    await stream.writeSSE({ data: "[DONE]" })
                } catch (e: any) {
                    log.error("cursor streaming error", { error: e?.message })
                    await stream.writeSSE({
                        event: "error",
                        data: JSON.stringify({
                            type: "error",
                            error: { message: e?.message ?? "Unknown error" }
                        })
                    })
                }
            })
        }

        // Fall back to Chat Completions format
        return c.json({ error: { message: "Invalid Responses API request", type: "invalid_request_error" } }, 400)
    })
