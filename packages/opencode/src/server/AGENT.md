# OpenCode Server

## Overview

The OpenCode server is a Hono-based HTTP server that provides:
1. **OpenCode API** - Internal APIs for the TUI and web clients
2. **OpenAI-Compatible API** - Unified interface exposing all logged-in models through OpenAI-compatible endpoints

---

## Architecture

### System Context

```
┌─────────────────────────────────────────────────────────────────────┐
│                          External Clients                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │   Cursor    │  │ OpenAI SDK  │  │    curl     │  │  Chat UI    │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘ │
└─────────┼────────────────┼────────────────┼────────────────┼────────┘
          │                │                │                │
          └────────────────┴────────────────┴────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │    OpenCode Server (:9090)   │
                    │  ┌──────────────────────┐   │
                    │  │  OpenAI-Compat Routes │   │
                    │  │    /v1/models         │   │
                    │  │    /v1/chat/completions│  │
                    │  │    /chat              │   │
                    │  └──────────────────────┘   │
                    └──────────────┬──────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          │                        │                        │
┌─────────▼─────────┐  ┌──────────▼──────────┐  ┌─────────▼─────────┐
│   OpenAI API      │  │   Anthropic API     │  │   OpenCode Zen    │
│  (Responses API)  │  │   (Messages API)    │  │   (Custom API)    │
└───────────────────┘  └─────────────────────┘  └───────────────────┘
```

### Component Diagram

```
server/
├── server.ts              # Main Hono app, middleware, core routes
│   ├── Global middleware (logging, CORS, error handling)
│   ├── Health check endpoints (/health, /health/ready)
│   ├── Session management routes
│   └── Mount point for OpenAICompatRoute
│
├── openai-compat.ts       # OpenAI-compatible API implementation
│   ├── GET  /chat         → Serves chat.html UI
│   ├── GET  /v1/models    → Lists all available models
│   ├── GET  /v1/models/:id → Get specific model details
│   └── POST /v1/chat/completions → Chat with streaming
│
├── chat.html              # Web-based chat interface
│   ├── Model selector (fetches from /v1/models)
│   ├── Chat message display with streaming
│   └── Dark theme with glassmorphism UI
│
└── error.ts               # Error utilities
```

### Request Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                    POST /v1/chat/completions                          │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 1. Parse & Validate Request (Zod)                                     │
│    • model: "openai/gpt-5.2-codex"                                    │
│    • messages: [{role: "user", content: "..."}]                       │
│    • stream: true/false                                               │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 2. Parse Model ID                                                     │
│    Provider.parseModel("openai/gpt-5.2-codex")                        │
│    → { providerID: "openai", modelID: "gpt-5.2-codex" }              │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 3. Load Model & SDK                                                   │
│    Provider.getModel(providerID, modelID)                             │
│    Provider.getLanguage(modelInfo)                                    │
│    → Returns configured LanguageModelV2 instance                      │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 4. Transform Messages                                                 │
│    • Extract system message → providerOptions.openai.instructions     │
│    • Convert OpenAI format → AI SDK CoreMessage format                │
│    • Add provider-specific options (store: false for Codex)          │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 5. Generate Response                                                  │
│    streamText(options) → Stream chunks via SSE                        │
│    • For streaming: Write chunks as SSE events                        │
│    • For non-streaming: Collect chunks, return JSON                   │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 6. Format OpenAI Response                                             │
│    {                                                                  │
│      "id": "chatcmpl-xxx",                                            │
│      "object": "chat.completion",                                     │
│      "choices": [{ "message": { "content": "..." } }],               │
│      "usage": { "prompt_tokens": X, "completion_tokens": Y }         │
│    }                                                                  │
└──────────────────────────────────────────────────────────────────────┘
```

### Provider Integration

```
┌─────────────────────────────────────────────────────────────────┐
│                     Provider Namespace                           │
│                   (provider/provider.ts)                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Provider.list()         → Get all authenticated providers       │
│  Provider.parseModel()   → Split "provider/model" string         │
│  Provider.getModel()     → Get model config & capabilities       │
│  Provider.getLanguage()  → Load SDK & create LanguageModelV2     │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                     CUSTOM_LOADERS                               │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │ openai  │  │anthropic │  │ opencode │  │  google  │  ...    │
│  └────┬────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘         │
│       │            │             │              │                │
│       ▼            ▼             ▼              ▼                │
│  @ai-sdk/     @ai-sdk/     custom SDK     @ai-sdk/              │
│   openai      anthropic                    google                │
└─────────────────────────────────────────────────────────────────┘
```

### Key Data Structures

```typescript
// Provider Model Configuration
interface Provider.Model {
  id: string              // e.g., "gpt-5.2-codex"
  provider: string        // e.g., "openai"
  capabilities: {
    temperature: boolean
    reasoning: boolean
    attachment: boolean
    toolcall: boolean
  }
  api: {
    npm: string           // e.g., "@ai-sdk/openai"
    url: string           // Base URL
  }
}

// OpenAI-Compatible Request
interface ChatCompletionRequest {
  model: string           // "provider/model" format
  messages: Message[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  tools?: Tool[]          // Accepted but not processed
}

// AI SDK Options
interface GenerateOptions {
  model: LanguageModelV2
  messages: CoreMessage[]
  providerOptions: {
    openai: {
      instructions: string  // System message for Responses API
      store: false          // Required for OAuth auth
    }
  }
}
```

### File Structure

## OpenAI-Compatible API

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/models` | GET | List all available models |
| `/v1/models/:id` | GET | Get specific model info |
| `/v1/chat/completions` | POST | Chat completion (streaming & non-streaming) |
| `/chat` | GET | Web chat interface |

### Model ID Format

Models are exposed as `{provider}/{model}`, e.g.:
- `openai/gpt-5.2-codex`
- `anthropic/claude-sonnet-4`
- `opencode/gpt-5-nano`

### Request Example

```bash
curl http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-5.2-codex",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### Key Implementation Details

1. **Provider Options**: OpenAI Codex models (Responses API) require:
   - `instructions` - system message passed via `providerOptions.openai.instructions`
   - `store: false` - required for OAuth authentication
   - `stream: true` - Codex models require streaming

2. **Streaming**: Uses `streamText()` from AI SDK for all requests (some models require streaming)

3. **Tools**: The API accepts `tools` parameter for compatibility but doesn't process them

## Authentication

- **No server-level auth** - The server currently doesn't authenticate incoming requests
- **Provider auth** - Uses OpenCode's internal provider authentication (OAuth, API keys, etc.)

> ⚠️ **Security**: If exposing via tunnel, consider adding API key authentication

## Configuration

The server reads configuration from:
- `--port` / `--host` CLI flags
- `opencode.json` global config
- Environment variables

## Testing

```bash
# Run comprehensive API tests
bun run test-openai-api.ts http://localhost:9090

# Test via Cloudflare tunnel
bun run test-openai-api.ts https://api.wenming-dev.org
```

## Dependencies

- `hono` - Web framework
- `ai` - Vercel AI SDK for model abstraction
- `zod` - Request validation
- `../provider/provider` - Model loading and SDK management

## Cursor Compatibility

The server supports **Cursor IDE** which sends requests in OpenAI Responses API format (`input` field) but expects Chat Completions SSE format in response.

### How It Works

1. **Auto-detection**: The `/v1/chat/completions` endpoint detects Responses API format by checking for `input` field
2. **Transform**: Converts `input` to `messages` format internally
3. **Response**: Returns standard Chat Completions SSE format

### Cursor Configuration

| Setting | Value |
|---------|-------|
| **Base URL** | `https://api.wenming-dev.org/v1` |
| **API Key** | `dummy` (any value - auth handled internally) |
| **Model** | `openai/gpt-5.2-codex` |

### Technical Details

The implementation follows **Ollama's OpenAI-compatible format** for maximum compatibility:

```
Cursor Request (Responses API format):
{
  "model": "openai/gpt-5.2-codex",
  "input": [{"role":"user","content":"Hello"}],  // Array of messages
  "stream": true
}

Server Response (Ollama-compatible Chat Completions SSE format):
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":123,"model":"openai/gpt-5.2-codex","system_fingerprint":"fp_opencode","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":123,"model":"openai/gpt-5.2-codex","system_fingerprint":"fp_opencode","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

Key format details (matching Ollama):
- `system_fingerprint`: Always `"fp_opencode"`
- First chunk includes `role: "assistant"` in delta
- Final chunk has empty delta and `finish_reason: "stop"`
- Stream ends with `data: [DONE]`

### Implementation Notes

1. **AI SDK Stream Property**: The AI SDK's `fullStream` uses different property names depending on the underlying API:
   - OpenAI Responses API (Codex models): Uses `part.text`
   - Standard Chat Completions: Uses `part.textDelta`
   - The server handles both with: `(part as any).text ?? part.textDelta`

2. **System Message Handling**: For OpenAI Responses API, the system message is extracted from `input` and passed via `providerOptions.openai.instructions` (not in the messages array).

3. **Tools**: Cursor sends 19 tools with invalid schemas (`type: "None"`). These are currently not passed to the LLM due to OpenAI schema validation errors. Tool calling support is planned for future implementation.

## Future Improvements

- [ ] Add API key authentication for server endpoints
- [ ] Support tool calling for Agent mode compatibility
- [ ] Add `/v1/embeddings` endpoint
- [ ] Add rate limiting
- [ ] WebSocket support for real-time updates
