package cache

import (
	"strings"
	"sync"
	"time"
)

// Tool-call replay store, shared by every upstream translator.
//
// Some upstreams attach opaque state to a tool call that must come back on
// the next request (Gemini's thoughtSignature on functionCall parts, and the
// same idea for other providers). OpenAI Chat Completions clients have no
// field to keep it, so the relay remembers it here, keyed by the tool-call id
// it handed out, and puts it back when the client replays that call.
//
// Clients may rewrite ids on the way back (OpenClaw strips everything but
// letters and digits: "exec-1793-23" returns as "exec179323"), so ids are
// keyed by their ASCII letters and digits only. Unknown ids (restart, other
// relay instance, expiry) simply miss and the caller keeps its old fallback.
//
// Memory is bounded twice: entry count and total value bytes. Oldest entries
// go first. Gemini signatures are 0.3-1.3 KB, so the defaults stay ~8 MB max.

const (
	ToolCallReplayTTL        = 6 * time.Hour
	ToolCallReplayMaxEntries = 5000
	ToolCallReplayMaxBytes   = 8 << 20
)

type toolCallReplayEntry struct {
	value string
	at    time.Time
}

var (
	toolCallReplayMu      sync.Mutex
	toolCallReplayEntries = map[string]toolCallReplayEntry{}
	toolCallReplayBytes   int
)

// ToolCallReplayKey keeps only the ASCII letters and digits of a tool-call id.
func ToolCallReplayKey(id string) string {
	var b strings.Builder
	b.Grow(len(id))
	for i := 0; i < len(id); i++ {
		c := id[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') {
			b.WriteByte(c)
		}
	}
	return b.String()
}

func toolCallReplayMapKey(namespace, id string) string {
	key := ToolCallReplayKey(id)
	if key == "" {
		return ""
	}
	return namespace + "\x00" + key
}

// RememberToolCallReplay stores value for (namespace, id).
func RememberToolCallReplay(namespace, id, value string) {
	mapKey := toolCallReplayMapKey(namespace, id)
	if mapKey == "" || value == "" || len(value) > ToolCallReplayMaxBytes/8 {
		return
	}
	now := time.Now()
	toolCallReplayMu.Lock()
	defer toolCallReplayMu.Unlock()
	if old, ok := toolCallReplayEntries[mapKey]; ok {
		toolCallReplayBytes -= len(old.value)
		delete(toolCallReplayEntries, mapKey)
	}
	if len(toolCallReplayEntries) >= ToolCallReplayMaxEntries || toolCallReplayBytes+len(value) > ToolCallReplayMaxBytes {
		for k, entry := range toolCallReplayEntries {
			if now.Sub(entry.at) > ToolCallReplayTTL {
				toolCallReplayBytes -= len(entry.value)
				delete(toolCallReplayEntries, k)
			}
		}
		for len(toolCallReplayEntries) > 0 && (len(toolCallReplayEntries) >= ToolCallReplayMaxEntries || toolCallReplayBytes+len(value) > ToolCallReplayMaxBytes) {
			oldestKey, oldestAt := "", now
			for k, entry := range toolCallReplayEntries {
				if oldestKey == "" || entry.at.Before(oldestAt) {
					oldestKey, oldestAt = k, entry.at
				}
			}
			toolCallReplayBytes -= len(toolCallReplayEntries[oldestKey].value)
			delete(toolCallReplayEntries, oldestKey)
		}
	}
	toolCallReplayEntries[mapKey] = toolCallReplayEntry{value: value, at: now}
	toolCallReplayBytes += len(value)
}

// LookupToolCallReplay returns the stored value for (namespace, id).
func LookupToolCallReplay(namespace, id string) (string, bool) {
	mapKey := toolCallReplayMapKey(namespace, id)
	if mapKey == "" {
		return "", false
	}
	toolCallReplayMu.Lock()
	defer toolCallReplayMu.Unlock()
	entry, ok := toolCallReplayEntries[mapKey]
	if !ok {
		return "", false
	}
	if time.Since(entry.at) > ToolCallReplayTTL {
		toolCallReplayBytes -= len(entry.value)
		delete(toolCallReplayEntries, mapKey)
		return "", false
	}
	return entry.value, true
}

// Namespace for Gemini thoughtSignature values (antigravity, gemini,
// gemini-cli all speak the same Gemini wire format).
const ToolCallReplayGeminiSignature = "gemini-thought-signature"

const geminiSkipThoughtSignature = "skip_thought_signature_validator"

// RememberGeminiToolCallSignature records a real functionCall thoughtSignature.
func RememberGeminiToolCallSignature(id, signature string) {
	if signature == "" || signature == geminiSkipThoughtSignature {
		return
	}
	RememberToolCallReplay(ToolCallReplayGeminiSignature, id, signature)
}

// GeminiToolCallSignature returns the remembered signature for a replayed
// tool call, or fallback when there is none.
func GeminiToolCallSignature(id, fallback string) string {
	if sig, ok := LookupToolCallReplay(ToolCallReplayGeminiSignature, id); ok {
		return sig
	}
	return fallback
}
