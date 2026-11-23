// The chat completions answer (plugin/chat.mjs) read back as a few plain
// events, and a streamed Response to write another API's events into. The
// Anthropic and Responses routes are both made of these two.

const SSE = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" }

async function* dataLines(response) {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const part of response.body) {
    buffer += decoder.decode(part, { stream: true })
    let end
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      for (const line of block.split("\n")) if (line.startsWith("data: ")) yield line.slice(6)
    }
  }
}

const usageOf = (u) => ({
  input: Math.max(0, (u?.prompt_tokens ?? 0) - (u?.prompt_tokens_details?.cached_tokens ?? 0)),
  cached: u?.prompt_tokens_details?.cached_tokens ?? 0,
  output: u?.completion_tokens ?? 0,
  total: u?.total_tokens ?? 0,
})

// A streamed chat completion as events:
//   { type: "reasoning" | "text", text }
//   { type: "tool", call: { id, name, arguments } }
//   { type: "done", usage: { input, cached, output, total } }
//   { type: "error", message }
// "done" or "error" is always the last one.
export async function* turnEvents(response) {
  let usage = usageOf()
  try {
    for await (const data of dataLines(response)) {
      if (data === "[DONE]") break
      let chunk
      try {
        chunk = JSON.parse(data)
      } catch {
        continue
      }
      if (chunk.error) return void (yield { type: "error", message: String(chunk.error.message ?? "upstream error") })
      if (chunk.usage) usage = usageOf(chunk.usage)
      const delta = chunk.choices?.[0]?.delta
      if (!delta) continue
      if (delta.reasoning_content) yield { type: "reasoning", text: delta.reasoning_content }
      if (delta.content) yield { type: "text", text: delta.content }
      for (const call of delta.tool_calls ?? [])
        yield { type: "tool", call: { id: call.id, name: call.function?.name ?? "", arguments: call.function?.arguments || "{}" } }
    }
  } catch (e) {
    return void (yield { type: "error", message: String(e?.message ?? e) })
  }
  yield { type: "done", usage }
}

// A whole (not streamed) chat completion as the same things.
export function turnResult(completion) {
  const message = completion?.choices?.[0]?.message ?? {}
  return {
    reasoning: message.reasoning_content ?? "",
    text: message.content ?? "",
    calls: (message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function?.name ?? "", arguments: c.function?.arguments || "{}" })),
    usage: usageOf(completion?.usage),
  }
}

// A streamed Response; `write(send)` sends events with send(name, data) and
// the stream closes when it returns.
export function eventStream(write) {
  const encoder = new TextEncoder()
  let closed = false
  const body = new ReadableStream({
    start(controller) {
      const send = (event, data) => {
        if (!closed) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      Promise.resolve()
        .then(() => write(send))
        .catch(() => {})
        .finally(() => {
          if (!closed) controller.close()
          closed = true
        })
    },
    cancel() {
      closed = true
    },
  })
  return new Response(body, { status: 200, headers: SSE })
}

// What a failed chat completion said: { status, message, code }.
export async function failure(response) {
  let error = {}
  try {
    error = (await response.json())?.error ?? {}
  } catch {}
  return { status: response.status, message: String(error.message ?? `HTTP ${response.status}`), code: String(error.code ?? error.type ?? "") }
}

export const textOf = (content, types = ["text"]) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((p) => p && types.includes(p.type) && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n")
      : ""
