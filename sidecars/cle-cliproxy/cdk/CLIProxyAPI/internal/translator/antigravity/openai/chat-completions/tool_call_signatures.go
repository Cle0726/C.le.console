package chat_completions

import internalcache "github.com/router-for-me/CLIProxyAPI/v7/internal/cache"

// Gemini 3 attaches a thoughtSignature to every functionCall it makes. OpenAI
// Chat Completions clients have nowhere to keep it, so the relay remembers
// id -> real signature (internal/cache/tool_call_replay.go) and puts the real
// one back when the client replays that call. Unknown ids keep the
// validator-skip placeholder, exactly as before.

func rememberToolCallSignature(id, signature string) {
	internalcache.RememberGeminiToolCallSignature(id, signature)
}

func toolCallThoughtSignature(id string) string {
	return internalcache.GeminiToolCallSignature(id, geminiCLIFunctionThoughtSignature)
}
