package claudeweb

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type ChatMessage struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"`
}

type ChatCompletionRequest struct {
	Model       string        `json:"model"`
	Messages    []ChatMessage `json:"messages"`
	Temperature *float64      `json:"temperature,omitempty"`
	MaxTokens   int           `json:"max_tokens,omitempty"`
	Stream      bool          `json:"stream,omitempty"`
}

type ChatCompletionResponse struct {
	ID      string                 `json:"id"`
	Object  string                 `json:"object"`
	Created int64                  `json:"created"`
	Model   string                 `json:"model"`
	Choices []ChatCompletionChoice `json:"choices"`
	Usage   map[string]int         `json:"usage"`
}

type ChatCompletionMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatCompletionChoice struct {
	Index        int                   `json:"index"`
	Message      ChatCompletionMessage `json:"message"`
	FinishReason string                `json:"finish_reason"`
}

type ChatCompletionChunk struct {
	ID      string                      `json:"id"`
	Object  string                      `json:"object"`
	Created int64                       `json:"created"`
	Model   string                      `json:"model"`
	Choices []ChatCompletionChunkChoice `json:"choices"`
}

type ChatCompletionChunkChoice struct {
	Index        int                      `json:"index"`
	Delta        ChatCompletionChunkDelta `json:"delta"`
	FinishReason *string                  `json:"finish_reason"`
}

type ChatCompletionChunkDelta struct {
	Role    string `json:"role,omitempty"`
	Content string `json:"content,omitempty"`
}

type ClaudeCookieExport struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}
type ClaudeAuthExport struct {
	Cookies []ClaudeCookieExport `json:"cookies"`
}

func BuildPrompt(messages []ChatMessage) string {
	parts := make([]string, 0, len(messages))
	for _, message := range messages {
		content := strings.TrimSpace(stringifyContent(message.Content))
		if content != "" {
			parts = append(parts, fmt.Sprintf("%s:\n%s", strings.ToUpper(message.Role), content))
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n\n"))
}

func normalizeModel(model string) string {
	switch strings.TrimSpace(model) {
	case "", "claude-3-7-sonnet-latest":
		return "claude-sonnet-5"
	case "claude-3-5-haiku-latest":
		return "claude-haiku-4-5"
	default:
		return strings.TrimSpace(model)
	}
}

func NewUUID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return fmt.Sprintf("local-%d", time.Now().UnixNano())
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16])
}

func BuildClaudeAppendMessagePayload(request ChatCompletionRequest, organizationID string) (string, map[string]interface{}) {
	model := normalizeModel(request.Model)
	conversationUUID := NewUUID()
	prompt := BuildPrompt(request.Messages)
	humanMessageUUID := NewUUID()
	assistantMessageUUID := NewUUID()
	payload := map[string]interface{}{
		"completion": map[string]interface{}{
			"prompt":         prompt,
			"timezone":       "Asia/Shanghai",
			"locale":         "en-US",
			"model":          model,
			"effort":         "medium",
			"thinking_mode":  "auto",
			"tools":          []interface{}{},
			"attachments":    []interface{}{},
			"files":          []interface{}{},
			"sync_sources":   []interface{}{},
			"rendering_mode": "messages",
		},
		"organization_uuid": organizationID,
		"conversation_uuid": conversationUUID,
		"text":              prompt,
		"prompt":            prompt,
		"model":             model,
		"timezone":          "Asia/Shanghai",
		"locale":            "en-US",
		"attachments":       []interface{}{},
		"files":             []interface{}{},
		"sync_sources":      []interface{}{},
		"rendering_mode":    "messages",
		"turn_message_uuids": map[string]interface{}{
			"human_message_uuid":     humanMessageUUID,
			"assistant_message_uuid": assistantMessageUUID,
		},
	}
	if request.MaxTokens > 0 {
		payload["max_tokens"] = request.MaxTokens
	}
	if request.Temperature != nil {
		payload["temperature"] = *request.Temperature
	}
	return conversationUUID, payload
}

func BuildClaudeCompletionPayload(request ChatCompletionRequest, organizationID string) (string, map[string]interface{}) {
	model := normalizeModel(request.Model)
	conversationUUID := NewUUID()
	payload := map[string]interface{}{
		"prompt": BuildPrompt(request.Messages), "timezone": "Asia/Shanghai", "locale": "en-US", "model": model,
		"effort": "medium", "thinking_mode": "auto", "tools": []interface{}{},
		"turn_message_uuids": map[string]interface{}{"human_message_uuid": NewUUID(), "assistant_message_uuid": NewUUID()},
		"attachments":        []interface{}{}, "files": []interface{}{}, "sync_sources": []interface{}{}, "rendering_mode": "messages",
		"create_conversation_params": map[string]interface{}{"name": "", "model": model, "include_conversation_preferences": true, "paprika_mode": nil, "compass_mode": nil, "tool_search_mode": "auto", "is_temporary": false, "enabled_imagine": true},
	}
	if request.MaxTokens > 0 {
		payload["max_tokens"] = request.MaxTokens
	}
	if request.Temperature != nil {
		payload["temperature"] = *request.Temperature
	}
	return conversationUUID, payload
}

func BuildOpenAIResponse(model, text string) ChatCompletionResponse {
	choice := ChatCompletionChoice{Index: 0, FinishReason: "stop"}
	choice.Message.Role = "assistant"
	choice.Message.Content = strings.TrimSpace(text)
	return ChatCompletionResponse{ID: fmt.Sprintf("chatcmpl-local-%d", time.Now().UnixNano()), Object: "chat.completion", Created: time.Now().Unix(), Model: normalizeModel(model), Choices: []ChatCompletionChoice{choice}, Usage: map[string]int{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}}
}

func NewStreamID() string { return fmt.Sprintf("chatcmpl-local-%d", time.Now().UnixNano()) }
func BuildOpenAIStreamChunk(model, streamID string, created int64, role string, content string, finishReason *string) ChatCompletionChunk {
	choice := ChatCompletionChunkChoice{Index: 0, FinishReason: finishReason}
	choice.Delta.Role = role
	choice.Delta.Content = content
	return ChatCompletionChunk{ID: streamID, Object: "chat.completion.chunk", Created: created, Model: normalizeModel(model), Choices: []ChatCompletionChunkChoice{choice}}
}

func ExtractClaudeStreamDelta(body []byte) (string, bool) {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" || trimmed == "[DONE]" {
		return "", true
	}
	var decoded map[string]interface{}
	if json.Unmarshal(body, &decoded) != nil {
		return "", false
	}
	if eventType, _ := decoded["type"].(string); eventType == "message_stop" || eventType == "completion" {
		return "", true
	}
	return pickStructuredText(decoded), false
}

func ExtractClaudeText(body []byte) string {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return ""
	}
	if strings.Contains(trimmed, "\ndata:") || strings.HasPrefix(trimmed, "data:") {
		var b strings.Builder
		for _, line := range strings.Split(trimmed, "\n") {
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if payload == "" || payload == "[DONE]" {
				continue
			}
			if text := extractStructuredText([]byte(payload)); text != "" {
				b.WriteString(text)
			}
		}
		if b.Len() > 0 {
			return sanitizeClaudeWebText(strings.TrimSpace(b.String()))
		}
	}
	if text := extractStructuredText(body); text != "" {
		return sanitizeClaudeWebText(text)
	}
	return sanitizeClaudeWebText(trimmed)
}

func sanitizeClaudeWebText(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	if idx := strings.Index(text, "Claude responded:"); idx >= 0 {
		text = text[idx+len("Claude responded:"):]
	}
	lines := strings.Split(text, "\n")
	filtered := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "Thought for ") {
			continue
		}
		if line == "Claude is AI and can make mistakes. Please double-check responses." || line == "Share" || line == "Want to be notified when Claude responds?" || line == "Notify" {
			continue
		}
		if line == "" || line == "" || line == "" || line == "" || line == "" || line == "" || line == "" || line == "" || line == "" || line == "" {
			continue
		}
		filtered = append(filtered, line)
	}
	joined := strings.TrimSpace(strings.Join(filtered, "\n"))
	chunks := strings.Split(joined, "\n\n")
	seen := map[string]bool{}
	out := make([]string, 0, len(chunks))
	for _, chunk := range chunks {
		chunk = strings.TrimSpace(chunk)
		if chunk == "" || seen[chunk] {
			continue
		}
		seen[chunk] = true
		out = append(out, chunk)
	}
	joined = strings.TrimSpace(strings.Join(out, "\n\n"))
	if i := strings.Index(joined, "\n"); i >= 0 {
		joined = strings.TrimSpace(joined[:i])
	}
	if i := strings.Index(joined, "\nWant to be notified"); i >= 0 {
		joined = strings.TrimSpace(joined[:i])
	}
	return joined
}

func stringifyContent(value interface{}) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []interface{}:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			parts = append(parts, stringifyContent(item))
		}
		return strings.Join(parts, " ")
	case map[string]interface{}:
		if text, ok := typed["text"].(string); ok {
			return text
		}
		encoded, _ := json.Marshal(typed)
		return string(encoded)
	default:
		encoded, _ := json.Marshal(typed)
		return string(encoded)
	}
}

func extractStructuredText(body []byte) string {
	var decoded interface{}
	if json.Unmarshal(body, &decoded) != nil {
		return ""
	}
	return pickStructuredText(decoded)
}
func pickStructuredText(value interface{}) string {
	switch typed := value.(type) {
	case map[string]interface{}:
		for _, key := range []string{"completion", "text", "content", "delta", "content_block", "message", "result", "data"} {
			if raw, ok := typed[key]; ok {
				if text := pickStructuredText(raw); text != "" {
					return text
				}
			}
		}
	case []interface{}:
		var b strings.Builder
		for _, item := range typed {
			b.WriteString(pickStructuredText(item))
		}
		return b.String()
	case string:
		return typed
	}
	return ""
}
