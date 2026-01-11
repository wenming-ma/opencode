import { mkdir, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const CLIENT_ID = process.env.OPENAI_OAUTH_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"

type TokenResponse = {
  id_token?: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

type StoredAuth = {
  refresh: string
  access: string
  expires: number
  accountId: string
  updated: number
}

function now() {
  return Date.now()
}

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init && init.headers ? init.headers : {}),
    },
  })
}

function html(body: string, init?: ResponseInit) {
  return new Response(body, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...(init && init.headers ? init.headers : {}),
    },
  })
}

function parseCookies(header: string) {
  const out: Record<string, string> = {}
  if (!header) return out
  const parts = header.split(";")
  for (const part of parts) {
    const index = part.indexOf("=")
    if (index === -1) continue
    const k = part.slice(0, index).trim()
    const v = part.slice(index + 1).trim()
    if (k) out[k] = v
  }
  return out
}

function extractClientKey(request: Request) {
  const header = request.headers.get("authorization") || request.headers.get("Authorization")
  if (header && header.toLowerCase().startsWith("bearer ")) {
    return header.slice("bearer ".length).trim()
  }
  const url = new URL(request.url)
  const key = url.searchParams.get("key")
  return key ? key.trim() : ""
}

type LocalState = {
  proxyKey: string
}

async function localStatePath() {
  const dir = await ensureStateDir()
  return join(dir, "state.json")
}

async function loadLocalState(): Promise<LocalState | undefined> {
  const path = await localStatePath()
  const file = Bun.file(path)
  const exists = await file.exists()
  if (!exists) return
  return file.json().catch(() => undefined)
}

async function saveLocalState(state: LocalState) {
  const path = await localStatePath()
  await Bun.write(path, JSON.stringify(state, null, 2))
}

function generateProxyKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

async function getProxyKeys() {
  const raw = (process.env.PROXY_KEYS || "").trim()
  if (raw) {
    return raw
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
  }

  const state = await loadLocalState()
  if (state?.proxyKey) return [state.proxyKey]

  const proxyKey = generateProxyKey()
  await saveLocalState({ proxyKey })
  return [proxyKey]
}

async function requireProxyKey(
  request: Request,
): Promise<{ ok: true; key: string } | { ok: false; response: Response }> {
  const keys = await getProxyKeys()
  const clientKey = extractClientKey(request)

  if (!clientKey || !keys.includes(clientKey)) {
    return {
      ok: false as const,
      response: json({ error: "Unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } }),
    }
  }

  return { ok: true as const, key: clientKey }
}

function base64UrlDecodeToString(input: string) {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4)
  return atob(padded)
}

function parseJwtClaims(token: string): any | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  const payload = parts[1]
  if (!payload) return undefined
  return JSON.parse(base64UrlDecodeToString(payload))
}

function extractAccountIdFromClaims(claims: any): string | undefined {
  return (
    claims?.chatgpt_account_id ||
    claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims?.organizations?.[0]?.id
  )
}

function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

type PendingOAuth = {
  verifier: string
  state: string
  ticket: string
  created: number
}

const pending = new Map<string, PendingOAuth>()

function base64UrlEncode(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function generateState() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

function generatePkceVerifier() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = crypto.getRandomValues(new Uint8Array(43))
  let out = ""
  for (const byte of bytes) out += chars.charAt(byte % chars.length)
  return out
}

async function generatePKCE() {
  const verifier = generatePkceVerifier()
  const data = new TextEncoder().encode(verifier)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const challenge = base64UrlEncode(hash)
  return { verifier, challenge }
}

function buildAuthorizeUrl(redirectUri: string, challenge: string, state: string) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "codex-local-proxy",
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

async function exchangeCodeForTokens(code: string, redirectUri: string, verifier: string): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  })

  const text = await response.text().catch(() => "")
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${text}`)
  }

  return text ? (JSON.parse(text) as TokenResponse) : ({} as TokenResponse)
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })

  const text = await response.text().catch(() => "")
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status} ${text}`)
  }

  return text ? (JSON.parse(text) as TokenResponse) : ({} as TokenResponse)
}

async function ensureStateDir() {
  const dir = join(homedir(), ".local", "share", "codex-local-proxy")
  await mkdir(dir, { recursive: true }).catch(() => undefined)
  return dir
}

async function statePath() {
  const dir = await ensureStateDir()
  return join(dir, "auth.json")
}

async function loadAuth(): Promise<StoredAuth | undefined> {
  const path = await statePath()
  const file = Bun.file(path)
  const exists = await file.exists()
  if (!exists) return
  return file.json().catch(() => undefined)
}

async function saveAuth(auth: StoredAuth) {
  const path = await statePath()
  await Bun.write(path, JSON.stringify(auth, null, 2))
}

async function ensureAuthFresh() {
  const current = await loadAuth()
  if (!current?.refresh) {
    throw new Error("Not logged in. Import refresh token at /auth")
  }

  if (current.access && current.expires > now() + 30_000) {
    return current
  }

  const tokens = await refreshAccessToken(current.refresh)
  const accountId = extractAccountId(tokens) || current.accountId
  if (!accountId) {
    throw new Error("Failed to extract account id")
  }

  const next: StoredAuth = {
    refresh: tokens.refresh_token || current.refresh,
    access: tokens.access_token,
    expires: now() + (tokens.expires_in ?? 3600) * 1000,
    accountId,
    updated: now(),
  }
  await saveAuth(next)
  return next
}

function extractTextFromResponseObject(obj: any): string {
  if (typeof obj?.output_text === "string") return obj.output_text
  const output = obj?.output
  if (Array.isArray(output)) {
    for (const item of output) {
      const content = item?.content
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part?.text === "string") return part.text
          if (typeof part?.output_text === "string") return part.output_text
        }
      }
    }
  }
  return ""
}

function chatToResponsesRequest(body: any) {
  const input = Array.isArray(body?.messages)
    ? body.messages.map((m: any) => {
        const parts = Array.isArray(m?.content) ? m.content : [{ type: "input_text", text: String(m?.content ?? "") }]

        const content = parts.map((p: any) => {
          if (p?.type === "text") return { type: "input_text", text: String(p.text ?? "") }
          if (p?.type === "input_text") return { type: "input_text", text: String(p.text ?? "") }
          if (p?.type === "image_url" && p.image_url?.url) {
            return { type: "input_image", image_url: String(p.image_url.url) }
          }
          return { type: "input_text", text: typeof p === "string" ? p : JSON.stringify(p) }
        })

        return {
          role: String(m?.role ?? "user"),
          content,
        }
      })
    : body?.input

  const out: any = {
    model: body?.model,
    input,
  }

  if (body?.stream !== undefined) out.stream = body.stream
  if (body?.temperature !== undefined) out.temperature = body.temperature
  if (body?.top_p !== undefined) out.top_p = body.top_p
  if (body?.max_tokens !== undefined) out.max_output_tokens = body.max_tokens
  if (body?.max_output_tokens !== undefined) out.max_output_tokens = body.max_output_tokens

  if (body?.tools !== undefined) out.tools = body.tools
  if (body?.tool_choice !== undefined) out.tool_choice = body.tool_choice

  if (body?.reasoning !== undefined) out.reasoning = body.reasoning
  if (body?.response_format !== undefined) out.response_format = body.response_format

  return out
}

function sseHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  }
}

function formatSseData(data: string) {
  return `data: ${data}\n\n`
}

function chatCompletionChunk(id: string, model: string, delta: any, finish_reason: string | null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason }],
  }
}

async function proxyResponses(request: Request) {
  const auth = await ensureAuthFresh()
  const upstream = await fetch(CODEX_API_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": request.headers.get("content-type") || "application/json",
      authorization: `Bearer ${auth.access}`,
      "ChatGPT-Account-Id": auth.accountId,
    },
    body: request.body,
  })

  const headers = new Headers(upstream.headers)
  headers.delete("set-cookie")
  return new Response(upstream.body, { status: upstream.status, headers })
}

async function proxyChatCompletions(request: Request) {
  const auth = await ensureAuthFresh()
  const originalBody = (await request.json().catch(() => undefined)) as any
  if (!originalBody) return json({ error: "Invalid JSON" }, { status: 400 })

  const stream = !!originalBody.stream

  const responsesBody = chatToResponsesRequest(originalBody)
  responsesBody.stream = stream

  const upstream = await fetch(CODEX_API_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${auth.access}`,
      "ChatGPT-Account-Id": auth.accountId,
    },
    body: JSON.stringify(responsesBody),
  })

  if (!stream) {
    const obj = (await upstream.json().catch(() => undefined)) as any
    if (!obj) {
      const text = await upstream.text().catch(() => "")
      return json({ error: text || "Upstream error" }, { status: upstream.status })
    }

    const text = extractTextFromResponseObject(obj)
    const id = typeof obj?.id === "string" ? `chatcmpl_${obj.id}` : `chatcmpl_${crypto.randomUUID()}`
    const model = typeof originalBody?.model === "string" ? originalBody.model : "unknown"

    return json({
      id,
      object: "chat.completion",
      created: Math.floor(now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "")
    return json({ error: text || "Upstream error" }, { status: upstream.status })
  }

  const model = typeof originalBody?.model === "string" ? originalBody.model : "unknown"
  const id = `chatcmpl_${crypto.randomUUID()}`

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const streamBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(formatSseData(JSON.stringify(chatCompletionChunk(id, model, { role: "assistant" }, null)))),
      )

      let buffer = ""
      const reader = upstream.body!.getReader()
      while (true) {
        const result = await reader.read()
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true })

        while (true) {
          const sep = buffer.indexOf("\n\n")
          if (sep === -1) break
          const raw = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)

          const lines = raw.split("\n")
          for (const line of lines) {
            if (!line.startsWith("data:")) continue
            const data = line.slice("data:".length).trim()
            if (!data || data === "[DONE]") continue
            let obj
            obj = JSON.parse(data)
            const delta =
              typeof obj?.delta === "string" ? obj.delta : typeof obj?.text === "string" ? obj.text : undefined
            if (!delta) continue
            controller.enqueue(
              encoder.encode(formatSseData(JSON.stringify(chatCompletionChunk(id, model, { content: delta }, null)))),
            )
          }
        }
      }

      controller.enqueue(encoder.encode(formatSseData(JSON.stringify(chatCompletionChunk(id, model, {}, "stop")))))
      controller.enqueue(encoder.encode(formatSseData("[DONE]")))
      controller.close()
    },
  })

  return new Response(streamBody, { status: 200, headers: { ...sseHeaders() } })
}

async function handleAuthPage(request: Request) {
  const keys = await getProxyKeys()
  const key = keys[0] || ""
  const keyOk = !!key
  const keyQuery = keyOk ? `?key=${encodeURIComponent(key)}` : ""

  const stored = await loadAuth()

  const defaultButtons = keys
    .map((k) => `<a href="/auth?key=${encodeURIComponent(k)}"><button type="button">Use ${k.slice(0, 8)}…</button></a>`)
    .join(" ")

  const baseUrl = `http://127.0.0.1:${process.env.PORT || "8787"}/v1`

  const page = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Codex Local Proxy</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;margin:40px;max-width:900px;}
    code{background:#f5f5f5;padding:2px 6px;border-radius:4px;}
    .box{border:1px solid #ddd;border-radius:8px;padding:16px;margin:12px 0;}
    textarea{width:100%;height:140px;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
    button{padding:8px 12px;}
    a{color:#0366d6;text-decoration:none;}
    .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:8px;}
    .warn{color:#b42318;}
  </style>
</head>
<body>
  <h1>Codex Local Proxy</h1>

  <div class="box">
    <div><strong>Base URL:</strong> <code>${baseUrl}</code></div>
    <div><strong>Cursor API Key:</strong> one of <code>PROXY_KEYS</code></div>
  </div>

  <div class="box">
    <h2>Status</h2>
    ${
      stored?.accountId
        ? `<div>Logged in as: <code>${stored.accountId}</code></div>`
        : `<div class="warn">Not logged in yet.</div>`
    }
  </div>

  <div class="box">
    <h2>Proxy Key</h2>
    ${
      key
        ? keyOk
          ? `<div>Active key: <code>${key}</code></div>`
          : `<div class="warn">Key is invalid: <code>${key}</code></div>`
        : `<div class="warn">No active key in URL. Click one of the buttons below.</div>`
    }
    ${defaultButtons ? `<div class="row">${defaultButtons}</div>` : ""}
  </div>

  <div class="box">
    <h2>Connect (recommended)</h2>
    <p>This runs the same localhost OAuth flow as opencode (no manual token copy).</p>
    ${
      keyOk
        ? `<div class="row"><a href="/auth/start${keyQuery}"><button type="button">Connect ChatGPT Plus/Pro</button></a></div>`
        : `<div class="warn">Click a key button above first.</div>`
    }
  </div>

  <div class="box">
    <h2>Backup: import refresh token</h2>
    <p>Run <code>opencode auth login</code> → <code>OpenAI → ChatGPT Pro/Plus</code>, then copy <code>refresh</code> from <code>~/.local/share/opencode/auth.json</code>.</p>
    <form method="POST" action="/auth/import${keyQuery}">
      <textarea name="refresh" placeholder="Paste refresh token here"></textarea>
      <div style="margin-top:10px;"><button type="submit">Import</button></div>
    </form>
  </div>

  <div class="box">
    <form method="POST" action="/auth/logout${keyQuery}">
      <button type="submit">Logout</button>
    </form>
  </div>
</body>
</html>`

  return html(page)
}

async function handleAuthImport(request: Request) {
  const authz = await requireProxyKey(request)
  if (!authz.ok) return authz.response

  // Keeps manual import as a fallback.

  const form = await request.formData()
  const refresh = typeof form.get("refresh") === "string" ? String(form.get("refresh")).trim() : ""
  if (!refresh) return json({ error: "Missing refresh" }, { status: 400 })

  const tokens = await refreshAccessToken(refresh)
  const accountId = extractAccountId(tokens)
  if (!accountId) return json({ error: "Missing accountId" }, { status: 400 })

  const auth: StoredAuth = {
    refresh: tokens.refresh_token || refresh,
    access: tokens.access_token,
    expires: now() + (tokens.expires_in ?? 3600) * 1000,
    accountId,
    updated: now(),
  }

  await saveAuth(auth)
  return new Response(null, { status: 303, headers: { location: `/auth` } })
}

async function handleAuthStart(request: Request) {
  const authz = await requireProxyKey(request)
  if (!authz.ok) return authz.response

  const url = new URL(request.url)
  const host = url.hostname
  if (host !== "127.0.0.1" && host !== "localhost") {
    return html(
      `<!doctype html><html><body><h1>Open locally</h1><p>OAuth callback requires localhost. Open <code>http://127.0.0.1:${port}/auth</code> instead.</p></body></html>`,
      { status: 400 },
    )
  }

  const redirectUri = `http://127.0.0.1:${port}/auth/callback`
  const pkce = await generatePKCE()
  const state = generateState()
  const ticket = crypto.randomUUID()

  pending.set(state, {
    verifier: pkce.verifier,
    state,
    ticket,
    created: now(),
  })

  const authorizeUrl = buildAuthorizeUrl(redirectUri, pkce.challenge, state)

  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl,
      "set-cookie": `codex_oauth_ticket=${ticket}; Max-Age=600; Path=/auth/callback; SameSite=Lax`,
    },
  })
}

async function handleAuthCallback(request: Request) {
  const url = new URL(request.url)
  const error = url.searchParams.get("error")
  const errorDescription = url.searchParams.get("error_description")
  if (error) {
    const msg = errorDescription || error
    return html(`<!doctype html><html><body><h1>Authorization failed</h1><pre>${msg}</pre></body></html>`, {
      status: 400,
    })
  }

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  if (!code || !state) {
    return html("<!doctype html><html><body><h1>Missing code/state</h1></body></html>", { status: 400 })
  }

  const record = pending.get(state)
  if (!record) {
    return html("<!doctype html><html><body><h1>Invalid state</h1></body></html>", { status: 400 })
  }

  const cookies = parseCookies(request.headers.get("cookie") || "")
  const ticket = cookies["codex_oauth_ticket"] || ""
  if (!ticket || ticket !== record.ticket) {
    return html("<!doctype html><html><body><h1>Unauthorized</h1></body></html>", { status: 401 })
  }

  pending.delete(state)

  const redirectUri = `http://127.0.0.1:${port}/auth/callback`
  let tokens: TokenResponse
  try {
    tokens = await exchangeCodeForTokens(code, redirectUri, record.verifier)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return html(`<!doctype html><html><body><h1>Token exchange failed</h1><pre>${message}</pre></body></html>`, {
      status: 400,
    })
  }

  const accountId = extractAccountId(tokens)
  if (!accountId) {
    return html("<!doctype html><html><body><h1>Missing account id</h1></body></html>", { status: 400 })
  }

  const auth: StoredAuth = {
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: now() + (tokens.expires_in ?? 3600) * 1000,
    accountId,
    updated: now(),
  }

  await saveAuth(auth)

  return new Response(null, {
    status: 303,
    headers: {
      location: `/auth`,
      "set-cookie": "codex_oauth_ticket=; Max-Age=0; Path=/auth/callback; SameSite=Lax",
    },
  })
}

async function handleAuthLogout(request: Request) {
  const authz = await requireProxyKey(request)
  if (!authz.ok) return authz.response

  const path = await statePath()
  await unlink(path).catch(() => undefined)
  return new Response(null, { status: 303, headers: { location: `/auth` } })
}

const port = Number(process.env.PORT || 8787)

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === "/auth" && request.method === "GET") {
      return handleAuthPage(request)
    }

    if (url.pathname === "/auth/start" && request.method === "GET") {
      return handleAuthStart(request)
    }

    if (url.pathname === "/auth/callback" && request.method === "GET") {
      return handleAuthCallback(request)
    }

    if (url.pathname === "/auth/import" && request.method === "POST") {
      return handleAuthImport(request)
    }

    if (url.pathname === "/auth/logout" && request.method === "POST") {
      return handleAuthLogout(request)
    }

    if (url.pathname === "/healthz") {
      return json({ ok: true })
    }

    if (url.pathname === "/v1/models" && request.method === "GET") {
      const authz = await requireProxyKey(request)
      if (!authz.ok) return authz.response
      return json({
        object: "list",
        data: [
          { id: "gpt-5.2-codex", object: "model", created: 0, owned_by: "openai" },
          { id: "gpt-5.2", object: "model", created: 0, owned_by: "openai" },
          { id: "gpt-5.1-codex-mini", object: "model", created: 0, owned_by: "openai" },
          { id: "gpt-5.1-codex-max", object: "model", created: 0, owned_by: "openai" },
        ],
      })
    }

    if (url.pathname === "/v1/responses" && request.method === "POST") {
      const authz = await requireProxyKey(request)
      if (!authz.ok) return authz.response
      return proxyResponses(request)
    }

    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      const authz = await requireProxyKey(request)
      if (!authz.ok) return authz.response
      return proxyChatCompletions(request)
    }

    return json({ error: "Not found" }, { status: 404 })
  },
})

console.log(`codex-local-proxy listening on http://127.0.0.1:${port}`)
console.log(`auth page: http://127.0.0.1:${port}/auth`)
