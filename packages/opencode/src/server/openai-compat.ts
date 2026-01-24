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
    .post("/v1/chat/completions", async (c) => {
        const body = await c.req.json()
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

                    for await (const chunk of result.textStream) {
                        const data = {
                            id: completionId,
                            object: "chat.completion.chunk",
                            created,
                            model: request.model,
                            choices: [
                                {
                                    index: 0,
                                    delta: { content: chunk },
                                    finish_reason: null,
                                },
                            ],
                        }
                        await stream.writeSSE({ data: JSON.stringify(data) })
                    }

                    // Send final chunk with finish_reason
                    const finalData = {
                        id: completionId,
                        object: "chat.completion.chunk",
                        created,
                        model: request.model,
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
