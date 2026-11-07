package cache

import (
	"strings"
	"testing"
)

func TestToolCallReplayRewrittenID(t *testing.T) {
	RememberGeminiToolCallSignature("exec-1793922615869620000-23", "SIG_A")
	if got := GeminiToolCallSignature("exec179392261586962000023", "skip"); got != "SIG_A" {
		t.Fatalf("rewritten id lookup = %q", got)
	}
	if got := GeminiToolCallSignature("call_other", "skip"); got != "skip" {
		t.Fatalf("unknown id lookup = %q", got)
	}
	if got := GeminiToolCallSignature("---", "skip"); got != "skip" {
		t.Fatalf("empty key lookup = %q", got)
	}
	RememberGeminiToolCallSignature("exec-2", geminiSkipThoughtSignature)
	if _, ok := LookupToolCallReplay(ToolCallReplayGeminiSignature, "exec-2"); ok {
		t.Fatal("placeholder must not be stored")
	}
	// namespaces do not collide
	RememberToolCallReplay("other", "exec-1793922615869620000-23", "OTHER")
	if got := GeminiToolCallSignature("exec179392261586962000023", "skip"); got != "SIG_A" {
		t.Fatalf("namespace collision: %q", got)
	}
}

func TestToolCallReplayByteCap(t *testing.T) {
	big := strings.Repeat("x", ToolCallReplayMaxBytes/16)
	for i := 0; i < 40; i++ {
		RememberToolCallReplay("cap", "id"+strings.Repeat("a", i), big)
	}
	toolCallReplayMu.Lock()
	total, n := toolCallReplayBytes, len(toolCallReplayEntries)
	toolCallReplayMu.Unlock()
	if total > ToolCallReplayMaxBytes {
		t.Fatalf("bytes %d over cap", total)
	}
	if _, ok := LookupToolCallReplay("cap", "id"+strings.Repeat("a", 39)); !ok {
		t.Fatalf("newest entry evicted (n=%d)", n)
	}
	if _, ok := LookupToolCallReplay("cap", "id"); ok {
		t.Fatal("oldest entry should be evicted")
	}
}
