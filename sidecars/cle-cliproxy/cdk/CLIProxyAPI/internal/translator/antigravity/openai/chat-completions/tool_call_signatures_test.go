package chat_completions

import (
	"context"
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

func TestToolCallSignatureRoundTrips(t *testing.T) {
	var param any
	chunk := []byte(`{"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"exec","args":{"command":"date"}},"thoughtSignature":"REAL_SIGNATURE_abcdefghijklmnopqrstuvwxyz0123456789"}]}}]}}`)
	out := ConvertAntigravityResponseToOpenAI(context.Background(), "model", nil, nil, chunk, &param)
	if len(out) == 0 {
		t.Fatal("no output chunk")
	}
	id := gjson.GetBytes(out[0], "choices.0.delta.tool_calls.0.id").String()
	if id == "" {
		t.Fatalf("no tool call id in %s", out[0])
	}
	req := []byte(`{"model":"gemini-3.8-flash-tiered","messages":[{"role":"user","content":"hi"},` +
		`{"role":"assistant","content":"","tool_calls":[{"id":"` + id + `","type":"function","function":{"name":"exec","arguments":"{\"command\":\"date\"}"}}]},` +
		`{"role":"tool","tool_call_id":"` + id + `","content":"Thu"},` +
		`{"role":"assistant","content":"","tool_calls":[{"id":"unknown-1","type":"function","function":{"name":"exec","arguments":"{}"}}]},` +
		`{"role":"tool","tool_call_id":"unknown-1","content":"x"}]}`)
	converted := string(ConvertOpenAIRequestToAntigravity("gemini-3.8-flash-tiered", req, true))
	if !strings.Contains(converted, "REAL_SIGNATURE_abcdefghijklmnopqrstuvwxyz0123456789") {
		t.Fatalf("real signature not replayed: %s", converted)
	}
	if !strings.Contains(converted, geminiCLIFunctionThoughtSignature) {
		t.Fatalf("unknown call should keep the placeholder: %s", converted)
	}
}

// OpenClaw sends the id back with the dashes removed.
func TestToolCallSignatureSurvivesRewrittenID(t *testing.T) {
	rememberToolCallSignature("exec-1793922615869620000-23", "SIG_FOR_REWRITTEN_ID")
	if got := toolCallThoughtSignature("exec179392261586962000023"); got != "SIG_FOR_REWRITTEN_ID" {
		t.Fatalf("rewritten id lookup = %q", got)
	}
	if got := toolCallThoughtSignature("call_other"); got != geminiCLIFunctionThoughtSignature {
		t.Fatalf("unknown id lookup = %q", got)
	}
	if got := toolCallThoughtSignature("---"); got != geminiCLIFunctionThoughtSignature {
		t.Fatalf("empty key lookup = %q", got)
	}
}
