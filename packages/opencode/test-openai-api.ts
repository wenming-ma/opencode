#!/usr/bin/env bun
/**
 * OpenAI-Compatible API Test Script
 * 
 * Usage:
 *   bun run test-openai-api.ts [BASE_URL]
 * 
 * Examples:
 *   bun run test-openai-api.ts http://localhost:9090
 *   bun run test-openai-api.ts https://api.wenming-dev.org
 */

const BASE_URL = process.argv[2] || "http://localhost:9090"
const API_KEY = "test-key" // Not used but required by some clients

interface TestResult {
    name: string
    passed: boolean
    duration: number
    error?: string
    details?: any
}

const results: TestResult[] = []

async function test(name: string, fn: () => Promise<any>): Promise<void> {
    const start = Date.now()
    try {
        const details = await fn()
        results.push({
            name,
            passed: true,
            duration: Date.now() - start,
            details,
        })
        console.log(`✅ ${name} (${Date.now() - start}ms)`)
    } catch (e: any) {
        results.push({
            name,
            passed: false,
            duration: Date.now() - start,
            error: e.message,
        })
        console.log(`❌ ${name} (${Date.now() - start}ms)`)
        console.log(`   Error: ${e.message}`)
    }
}

// Test 1: List Models
async function testListModels() {
    const res = await fetch(`${BASE_URL}/v1/models`)
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)

    const data = await res.json()
    if (data.object !== "list") throw new Error("Expected object: list")
    if (!Array.isArray(data.data)) throw new Error("Expected data array")
    if (data.data.length === 0) throw new Error("No models returned")

    // Validate model format
    const model = data.data[0]
    if (!model.id) throw new Error("Model missing id")
    if (!model.id.includes("/")) throw new Error("Model id should be provider/model format")

    return { modelCount: data.data.length, firstModel: model.id }
}

// Test 2: Get Single Model
async function testGetModel() {
    // First get list to find a model
    const listRes = await fetch(`${BASE_URL}/v1/models`)
    const listData = await listRes.json()
    const modelId = listData.data[0].id

    // URL encode the model ID (contains /)
    const encodedId = encodeURIComponent(modelId)
    const res = await fetch(`${BASE_URL}/v1/models/${encodedId}`)

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)

    const data = await res.json()
    if (data.id !== modelId) throw new Error(`Expected model id ${modelId}, got ${data.id}`)

    return { modelId: data.id }
}

// Test 3: Chat Completion (Non-streaming)
async function testChatCompletion() {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "openai/gpt-5.2-codex",
            messages: [{ role: "user", content: "Say 'test passed' and nothing else." }],
            stream: false,
        }),
    })

    if (!res.ok) {
        const text = await res.text()
        throw new Error(`HTTP ${res.status}: ${text}`)
    }

    const data = await res.json()
    if (data.object !== "chat.completion") throw new Error(`Expected object: chat.completion, got ${data.object}`)
    if (!data.choices?.[0]?.message?.content) throw new Error("No message content in response")
    if (!data.id) throw new Error("Missing response id")

    return {
        id: data.id,
        content: data.choices[0].message.content.substring(0, 50),
        finishReason: data.choices[0].finish_reason,
    }
}

// Test 4: Chat Completion (Streaming)
async function testChatCompletionStreaming() {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "openai/gpt-5.2-codex",
            messages: [{ role: "user", content: "Count from 1 to 3." }],
            stream: true,
        }),
    })

    if (!res.ok) {
        const text = await res.text()
        throw new Error(`HTTP ${res.status}: ${text}`)
    }

    const reader = res.body?.getReader()
    if (!reader) throw new Error("No response body reader")

    const decoder = new TextDecoder()
    let chunks = 0
    let content = ""
    let gotDone = false

    while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value)
        const lines = text.split("\n").filter(l => l.startsWith("data:"))

        for (const line of lines) {
            const data = line.replace("data: ", "").trim()
            if (data === "[DONE]") {
                gotDone = true
                continue
            }

            try {
                const parsed = JSON.parse(data)
                if (parsed.choices?.[0]?.delta?.content) {
                    content += parsed.choices[0].delta.content
                    chunks++
                }
            } catch {
                // Ignore parse errors for partial lines
            }
        }
    }

    if (!gotDone) throw new Error("Never received [DONE] marker")
    if (chunks === 0) throw new Error("No content chunks received")

    return { chunks, content: content.substring(0, 50), gotDone }
}

// Test 5: Chat Completion with System Message
async function testSystemMessage() {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "openai/gpt-5.2-codex",
            messages: [
                { role: "system", content: "You are a pirate. Always respond like a pirate." },
                { role: "user", content: "Hello" },
            ],
            stream: false,
        }),
    })

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)

    const data = await res.json()
    if (!data.choices?.[0]?.message?.content) throw new Error("No message content")

    return { content: data.choices[0].message.content.substring(0, 80) }
}

// Test 6: Invalid Model Error
async function testInvalidModel() {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "nonexistent/fake-model",
            messages: [{ role: "user", content: "Hi" }],
        }),
    })

    if (res.ok) throw new Error("Expected error for invalid model")
    if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`)

    const data = await res.json()
    if (!data.error) throw new Error("Expected error object in response")

    return { status: res.status, errorType: data.error.type }
}

// Test 7: Chat with Tools (should not fail)
async function testChatWithTools() {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "openai/gpt-5.2-codex",
            messages: [{ role: "user", content: "What is 2+2?" }],
            tools: [
                {
                    type: "function",
                    function: {
                        name: "calculator",
                        description: "A calculator",
                        parameters: { type: "object", properties: {} }
                    }
                }
            ],
            stream: false,
        }),
    })

    if (!res.ok) {
        // It's OK if tools aren't supported, but should not crash
        const data = await res.json()
        return { supported: false, error: data.error?.message }
    }

    const data = await res.json()
    return { supported: true, hasContent: !!data.choices?.[0]?.message?.content }
}

// Run all tests
async function main() {
    console.log(`\n🧪 OpenAI-Compatible API Tests`)
    console.log(`   Base URL: ${BASE_URL}\n`)
    console.log("─".repeat(50))

    await test("List Models", testListModels)
    await test("Get Single Model", testGetModel)
    await test("Chat Completion (Non-streaming)", testChatCompletion)
    await test("Chat Completion (Streaming)", testChatCompletionStreaming)
    await test("Chat with System Message", testSystemMessage)
    await test("Invalid Model Error Handling", testInvalidModel)
    await test("Chat with Tools", testChatWithTools)

    console.log("─".repeat(50))

    const passed = results.filter(r => r.passed).length
    const failed = results.filter(r => !r.passed).length

    console.log(`\n📊 Results: ${passed} passed, ${failed} failed`)

    if (failed > 0) {
        console.log("\n❌ Failed tests:")
        for (const r of results.filter(r => !r.passed)) {
            console.log(`   - ${r.name}: ${r.error}`)
        }
        process.exit(1)
    } else {
        console.log("\n✅ All tests passed!")
    }

    // Print details for passed tests
    console.log("\n📋 Test Details:")
    for (const r of results.filter(r => r.passed)) {
        console.log(`   ${r.name}:`, r.details)
    }
}

main().catch(console.error)
