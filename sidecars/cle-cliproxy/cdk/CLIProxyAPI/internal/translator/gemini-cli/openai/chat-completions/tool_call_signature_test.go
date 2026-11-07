package chat_completions

import (
	"context"
	"regexp"
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

func TestGeminiCLIToolCallSignatureRoundTrips(t *testing.T) {
	var param any
	chunk := []byte(`{"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"exec","args":{"command":"date"}},"thoughtSignature":"CLI_REAL_SIGNATURE_0123456789"}]}}]}}`)
	out := ConvertCliResponseToOpenAI(context.Background(), "model", nil, nil, chunk, &param)
	if len(out) == 0 {
		t.Fatal("no output chunk")
	}
	id := gjson.GetBytes(out[0], "choices.0.delta.tool_calls.0.id").String()
	if id == "" {
		t.Fatalf("no tool call id in %s", out[0])
	}
	id = regexp.MustCompile(`[^A-Za-z0-9]`).ReplaceAllString(id, "") // OpenClaw rewrite
	req := []byte(`{"model":"gemini-3-flash","messages":[{"role":"user","content":"hi"},` +
		`{"role":"assistant","content":"","tool_calls":[{"id":"` + id + `","type":"function","function":{"name":"exec","arguments":"{\"command\":\"date\"}"}}]},` +
		`{"role":"tool","tool_call_id":"` + id + `","content":"Thu"}]}`)
	converted := string(ConvertOpenAIRequestToGeminiCLI("gemini-3-flash", req, true))
	if !strings.Contains(converted, "CLI_REAL_SIGNATURE_0123456789") {
		t.Fatalf("real signature not replayed: %s", converted)
	}
}
