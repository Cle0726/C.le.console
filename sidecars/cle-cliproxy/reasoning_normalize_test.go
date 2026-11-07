package main

import (
	"encoding/json"
	"testing"
)

func jsonString(t *testing.T, raw []byte, path ...string) string {
	t.Helper()
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		t.Fatalf("unmarshal: %v payload=%s", err, raw)
	}
	var current any = root
	for _, key := range path {
		switch typed := current.(type) {
		case map[string]any:
			current = typed[key]
		case []any:
			var index int
			for _, r := range key {
				index = index*10 + int(r-'0')
			}
			current = typed[index]
		default:
			t.Fatalf("path %v stopped at %T in %s", path, current, raw)
		}
	}
	text, _ := current.(string)
	return text
}

func TestNormalizeOpenAIReasoningJSONPromotesWorkbenchFields(t *testing.T) {
	raw := []byte(`{"choices":[{"delta":{"reasoning":"从推理字段来"},"message":{"reasoning_text":"全文","thinking":"不会覆盖已有 reasoning_text"}}]}`)
	out := normalizeOpenAIReasoningJSON(raw, nil)
	if got := jsonString(t, out, "choices", "0", "delta", "reasoning_content"); got != "从推理字段来" {
		t.Fatalf("delta reasoning_content = %q, payload=%s", got, out)
	}
	if got := jsonString(t, out, "choices", "0", "message", "reasoning_content"); got != "全文" {
		t.Fatalf("message reasoning_content = %q, payload=%s", got, out)
	}
}

func TestNormalizeOpenAIReasoningJSONSplitsThinkTags(t *testing.T) {
	raw := []byte(`{"choices":[{"message":{"role":"assistant","content":"<thinking>先分析</thinking>答案"}}]}`)
	out := normalizeOpenAIReasoningJSON(raw, nil)
	if got := jsonString(t, out, "choices", "0", "message", "reasoning_content"); got != "先分析" {
		t.Fatalf("reasoning_content = %q, payload=%s", got, out)
	}
	if got := jsonString(t, out, "choices", "0", "message", "content"); got != "答案" {
		t.Fatalf("content = %q, payload=%s", got, out)
	}
}

func TestNormalizeOpenAIReasoningChunkHoldsPartialTag(t *testing.T) {
	var state thinkSplitState
	first := normalizeOpenAIReasoningChunk(&state, []byte(`{"choices":[{"delta":{"content":"可见<thi"}}]}`))
	if got := jsonString(t, first, "choices", "0", "delta", "content"); got != "可见" {
		t.Fatalf("visible content = %q, payload=%s", got, first)
	}
	second := normalizeOpenAIReasoningChunk(&state, []byte(`{"choices":[{"delta":{"content":"nk>思考</think>结论"}}]}`))
	if got := jsonString(t, second, "choices", "0", "delta", "reasoning_content"); got != "思考" {
		t.Fatalf("reasoning_content = %q, payload=%s", got, second)
	}
	if got := jsonString(t, second, "choices", "0", "delta", "content"); got != "结论" {
		t.Fatalf("content = %q, payload=%s", got, second)
	}
}
