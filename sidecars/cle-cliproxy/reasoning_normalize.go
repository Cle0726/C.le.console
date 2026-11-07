package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"strings"

	"github.com/gin-gonic/gin"
)

// thinkTag pairs are the plaintext thinking wrappers seen across Qwen, Doubao,
// MiniMax-compatible gateways, and several workbench extension providers.
var thinkTagPairs = [][2]string{
	{"<think>", "</think>"},
	{"<thinking>", "</thinking>"},
}

// thinkSplitState keeps a partial tag that arrived at the end of a stream chunk
// so the next chunk can finish it. A nil state splits one complete payload.
type thinkSplitState struct {
	inThink bool
	hold    string
}

func (s *thinkSplitState) split(input string) (reasoning, visible string) {
	if s == nil {
		local := thinkSplitState{}
		reasoning, visible = local.split(input)
		if local.inThink {
			reasoning += local.hold
		} else {
			visible += local.hold
		}
		return reasoning, visible
	}
	text := s.hold + input
	s.hold = ""
	var reasonB, visibleB strings.Builder
	for len(text) > 0 {
		if s.inThink {
			at, size := findThinkTag(text, false)
			if at < 0 {
				if hold := partialThinkSuffix(text, false); hold != "" {
					reasonB.WriteString(text[:len(text)-len(hold)])
					s.hold = hold
				} else {
					reasonB.WriteString(text)
				}
				break
			}
			reasonB.WriteString(text[:at])
			text = text[at+size:]
			s.inThink = false
			continue
		}
		at, size := findThinkTag(text, true)
		if at < 0 {
			if hold := partialThinkSuffix(text, true); hold != "" {
				visibleB.WriteString(text[:len(text)-len(hold)])
				s.hold = hold
			} else {
				visibleB.WriteString(text)
			}
			break
		}
		visibleB.WriteString(text[:at])
		text = text[at+size:]
		s.inThink = true
	}
	return reasonB.String(), visibleB.String()
}

func (s *thinkSplitState) finish() (reasoning, visible string) {
	if s == nil || s.hold == "" {
		return "", ""
	}
	held := s.hold
	s.hold = ""
	if s.inThink {
		return held, ""
	}
	return "", held
}

func findThinkTag(text string, open bool) (at, size int) {
	at = -1
	for _, pair := range thinkTagPairs {
		tag := pair[0]
		if !open {
			tag = pair[1]
		}
		idx := strings.Index(text, tag)
		if idx >= 0 && (at < 0 || idx < at) {
			at = idx
			size = len(tag)
		}
	}
	return at, size
}

func partialThinkSuffix(text string, open bool) string {
	best := 0
	for _, pair := range thinkTagPairs {
		tag := pair[0]
		if !open {
			tag = pair[1]
		}
		limit := len(tag) - 1
		if limit > len(text) {
			limit = len(text)
		}
		for n := limit; n > best; n-- {
			if strings.HasSuffix(text, tag[:n]) {
				best = n
				break
			}
		}
	}
	if best == 0 {
		return ""
	}
	return text[len(text)-best:]
}

// normalizeOpenAIReasoningJSON copies thinking text from the field names used
// by the workbench providers into reasoning_content, and lifts complete
// <think> / <thinking> blocks out of visible content.
func normalizeOpenAIReasoningJSON(raw []byte, state *thinkSplitState) []byte {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' || !json.Valid(trimmed) {
		return raw
	}
	var root map[string]any
	if err := json.Unmarshal(trimmed, &root); err != nil {
		return raw
	}
	choices, ok := root["choices"].([]any)
	if !ok {
		return raw
	}
	changed := false
	for _, item := range choices {
		choice, ok := item.(map[string]any)
		if !ok {
			continue
		}
		for _, key := range []string{"delta", "message"} {
			node, ok := choice[key].(map[string]any)
			if !ok {
				continue
			}
			if promoteReasoningFields(node) {
				changed = true
			}
			if splitContentThinking(node, state) {
				changed = true
			}
		}
	}
	if !changed {
		return raw
	}
	out, err := json.Marshal(root)
	if err != nil {
		return raw
	}
	return out
}

func promoteReasoningFields(node map[string]any) bool {
	if existing, ok := node["reasoning_content"].(string); ok && strings.TrimSpace(existing) != "" {
		return false
	}
	for _, key := range []string{"reasoning", "reasoning_text", "thinking"} {
		text, ok := node[key].(string)
		if !ok || strings.TrimSpace(text) == "" {
			continue
		}
		node["reasoning_content"] = text
		return true
	}
	details, ok := node["reasoning_details"].([]any)
	if !ok {
		return false
	}
	var b strings.Builder
	for _, item := range details {
		obj, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if text, ok := obj["text"].(string); ok {
			b.WriteString(text)
		}
	}
	if b.Len() == 0 {
		return false
	}
	node["reasoning_content"] = b.String()
	return true
}

func splitContentThinking(node map[string]any, state *thinkSplitState) bool {
	content, ok := node["content"].(string)
	if !ok || content == "" {
		return false
	}
	if !strings.Contains(content, "<") && (state == nil || state.hold == "") {
		return false
	}
	local := state
	flush := false
	if local == nil {
		local = &thinkSplitState{}
		flush = true
	}
	reasoning, visible := local.split(content)
	if flush {
		extraReason, extraVisible := local.finish()
		reasoning += extraReason
		visible += extraVisible
	}
	if reasoning == "" && visible == content && (state == nil || state.hold == "") {
		return false
	}
	if reasoning != "" {
		if existing, ok := node["reasoning_content"].(string); ok && existing != "" {
			node["reasoning_content"] = existing + reasoning
		} else {
			node["reasoning_content"] = reasoning
		}
	}
	if visible == "" {
		delete(node, "content")
	} else {
		node["content"] = visible
	}
	return true
}

func openAIReasoningTailDelta(reasoning, visible string) map[string]any {
	delta := map[string]any{}
	if reasoning != "" {
		delta["reasoning_content"] = reasoning
	}
	if visible != "" {
		delta["content"] = visible
	}
	return delta
}

func writeNormalizedOpenAIChatStream(c *gin.Context, body io.Reader) {
	flusher, _ := c.Writer.(interface{ Flush() })
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	var state thinkSplitState
	for scanner.Scan() {
		line := scanner.Bytes()
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) == 0 {
			continue
		}
		var frame []byte
		if bytes.HasPrefix(trimmed, []byte("data:")) {
			payload := bytes.TrimSpace(trimmed[len("data:"):])
			if len(payload) > 0 && payload[0] == '{' {
				payload = normalizeOpenAIReasoningJSON(payload, &state)
			}
			frame = frameOpenAIStreamChunk(payload)
		} else {
			frame = append(append([]byte{}, line...), '\n')
		}
		if len(frame) == 0 {
			continue
		}
		if _, err := c.Writer.Write(frame); err != nil {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
	}
	if reasoning, visible := state.finish(); reasoning != "" || visible != "" {
		payload := map[string]any{
			"object": "chat.completion.chunk",
			"choices": []any{map[string]any{
				"index":         0,
				"delta":         openAIReasoningTailDelta(reasoning, visible),
				"finish_reason": nil,
			}},
		}
		if encoded, err := json.Marshal(payload); err == nil {
			_, _ = c.Writer.Write(frameOpenAIStreamChunk(encoded))
			if flusher != nil {
				flusher.Flush()
			}
		}
	}
}

func normalizeOpenAIReasoningChunk(state *thinkSplitState, chunk []byte) []byte {
	trimmed := bytes.TrimSpace(chunk)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("[DONE]")) {
		return chunk
	}
	if bytes.HasPrefix(trimmed, []byte("data:")) || bytes.Contains(chunk, []byte("\ndata:")) {
		lines := bytes.Split(chunk, []byte("\n"))
		changed := false
		for i, line := range lines {
			lineTrim := bytes.TrimSpace(line)
			if !bytes.HasPrefix(lineTrim, []byte("data:")) {
				continue
			}
			data := bytes.TrimSpace(lineTrim[len("data:"):])
			if len(data) == 0 || data[0] != '{' {
				continue
			}
			next := normalizeOpenAIReasoningJSON(data, state)
			if bytes.Equal(next, data) {
				continue
			}
			lines[i] = append([]byte("data: "), next...)
			changed = true
		}
		if !changed {
			return chunk
		}
		return bytes.Join(lines, []byte("\n"))
	}
	if trimmed[0] != '{' {
		return chunk
	}
	next := normalizeOpenAIReasoningJSON(trimmed, state)
	if bytes.Equal(next, trimmed) {
		return chunk
	}
	return next
}
