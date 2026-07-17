package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"claude-web-gateway-sidecar/internal/claudeweb"
	"claude-web-gateway-sidecar/internal/config"
)

func TestUnaryRetries429WithNextSessionKeyAndAppendMessage(t *testing.T) {
	var cookies []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/append_message" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		cookies = append(cookies, r.Header.Get("Cookie"))
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), "hello") {
			t.Fatalf("payload should contain prompt: %s", body)
		}
		if strings.Contains(r.Header.Get("Cookie"), "sessionKey=sk-rate") {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`rate limited`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"completion":"ok"}`))
	}))
	defer upstream.Close()

	dir := t.TempDir()
	runtimePath := filepath.Join(dir, "runtime.json")
	auth := map[string]any{"cookies": []map[string]string{{"name": "lastActiveOrg", "value": "org-1"}}}
	authData, _ := json.Marshal(auth)
	if err := os.WriteFile(filepath.Join(dir, "claude-auth-export.json"), authData, 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := &config.GatewayConfig{ListenHost: "127.0.0.1", ListenPort: 8787, UpstreamBaseURL: upstream.URL, MaxRetries: 2, CooldownMinutes: 15, ClaudeDailyLimit: 10, RespectRetryAfter: true, Accounts: []config.ClaudeSessionAccount{{ID: "a1", Label: "rate", SessionKey: "sk-rate", Enabled: true, DailyLimit: 10}, {ID: "a2", Label: "ok", SessionKey: "sk-ok", Enabled: true, DailyLimit: 10}}}
	svc := NewService(cfg, claudeweb.NewScheduler(cfg, runtimePath), runtimePath)
	req := claudeweb.ChatCompletionRequest{Model: "claude-sonnet-5", Messages: []claudeweb.ChatMessage{{Role: "user", Content: "hello"}}}
	w := httptest.NewRecorder()
	svc.handleUnaryChatCompletions(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("unexpected status %d body=%s", w.Code, w.Body.String())
	}
	if len(cookies) != 2 || !strings.Contains(cookies[0], "sessionKey=sk-rate") || !strings.Contains(cookies[1], "sessionKey=sk-ok") {
		t.Fatalf("unexpected cookies: %#v", cookies)
	}
	states := svc.Scheduler.Snapshot()
	if states[0].Status != "cooling_down" || states[1].TodayCalls != 1 {
		t.Fatalf("unexpected states: %#v", states)
	}
}

func TestClassifyCloudflareAndInvalidSession(t *testing.T) {
	cf := classifyUpstreamFailure(http.StatusForbidden, nil, []byte("Just a moment... Cloudflare"), "direct_http", false)
	if cf.Kind != "cloudflare_block" {
		t.Fatalf("expected cloudflare_block, got %#v", cf)
	}
	invalid := classifyUpstreamFailure(http.StatusForbidden, nil, []byte("account_session_invalid"), "direct_http", false)
	if invalid.Kind != "invalid_session" {
		t.Fatalf("expected invalid_session, got %#v", invalid)
	}
}

func TestApplyClaudeHeadersLooksLikeBrowserRequest(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "https://claude.ai/api/append_message", nil)
	applyClaudeHeaders(req, "https://claude.ai", "org-1", "sk-test")
	mustHave := map[string]string{
		"Accept":                    "text/event-stream, application/json",
		"Accept-Language":           "en-US,en;q=0.9",
		"Origin":                    "https://claude.ai",
		"Referer":                   "https://claude.ai/new",
		"X-Organization-Uuid":       "org-1",
		"Anthropic-Client-Platform": "web_claude_ai",
		"Sec-Fetch-Site":            "same-origin",
		"Sec-Fetch-Mode":            "cors",
		"Sec-Fetch-Dest":            "empty",
		"Priority":                  "u=1, i",
	}
	for key, want := range mustHave {
		if got := req.Header.Get(key); got != want {
			t.Fatalf("header %s = %q, want %q", key, got, want)
		}
	}
	if !strings.Contains(req.Header.Get("Cookie"), "sessionKey=sk-test") || !strings.Contains(req.Header.Get("Cookie"), "lastActiveOrg=org-1") {
		t.Fatalf("cookie was not populated correctly: %s", req.Header.Get("Cookie"))
	}
	if !strings.Contains(req.Header.Get("User-Agent"), "Chrome/") {
		t.Fatalf("user-agent should look like Chrome: %s", req.Header.Get("User-Agent"))
	}
}

func TestBuildOpenAIResponseUsesCanonicalLowercaseMessageFields(t *testing.T) {
	payload, err := json.Marshal(claudeweb.BuildOpenAIResponse("claude-sonnet-5", "ok"))
	if err != nil {
		t.Fatal(err)
	}
	body := string(payload)
	if !strings.Contains(body, `"role":"assistant"`) || !strings.Contains(body, `"content":"ok"`) {
		t.Fatalf("OpenAI response should use lowercase role/content fields: %s", body)
	}
	if strings.Contains(body, `"Role"`) || strings.Contains(body, `"Content"`) {
		t.Fatalf("OpenAI response leaked Go field names: %s", body)
	}
}

func TestClassifyModernInterceptionPayloads(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   string
	}{
		{http.StatusForbidden, `{"cf-mitigated":"challenge"}`, "cloudflare_block"},
		{http.StatusForbidden, `captcha required`, "cloudflare_block"},
		{http.StatusForbidden, `request blocked by risk control`, "risk_control_block"},
		{http.StatusTooManyRequests, `too many requests`, "rate_limited"},
		{http.StatusUnauthorized, `login required`, "invalid_session"},
	}
	for _, tt := range cases {
		got := classifyUpstreamFailure(tt.status, nil, []byte(tt.body), "direct_http", false)
		if got.Kind != tt.want {
			t.Fatalf("classify(%d,%q) = %s, want %s", tt.status, tt.body, got.Kind, tt.want)
		}
	}
}

func TestBrowserBridgeModeStreamsBufferedSSE(t *testing.T) {
	var directCalls int
	direct := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		directCalls++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer direct.Close()

	bridgeCalls := 0
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/append-message" {
			t.Fatalf("unexpected bridge path: %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer bridge-token" {
			t.Fatalf("unexpected bridge auth header: %q", got)
		}
		bridgeCalls++
		writeJSON(w, http.StatusOK, map[string]any{
			"status":  200,
			"headers": map[string]any{"contentType": "text/event-stream"},
			"body": strings.Join([]string{
				`data: {"type":"content_block_delta","delta":{"text":"BRIDGE_OK"}}`,
				``,
				`data: {"type":"message_stop"}`,
				``,
			}, "\n"),
		})
	}))
	defer bridge.Close()

	dir := t.TempDir()
	runtimePath := filepath.Join(dir, "runtime.json")
	writeAuthExport(t, dir, "org-bridge")
	cfg := &config.GatewayConfig{
		ListenHost:         "127.0.0.1",
		ListenPort:         8787,
		UpstreamBaseURL:    direct.URL,
		TransportMode:      "browser_bridge",
		HelperMode:         "probe_only",
		BrowserBridgeURL:   bridge.URL,
		BrowserBridgeToken: "bridge-token",
	}
	svc := NewService(cfg, claudeweb.NewScheduler(cfg, runtimePath), runtimePath)
	request := claudeweb.ChatCompletionRequest{
		Model:    "claude-sonnet-5",
		Stream:   true,
		Messages: []claudeweb.ChatMessage{{Role: "user", Content: "hello from bridge"}},
	}
	w := httptest.NewRecorder()
	svc.handleStreamingChatCompletions(w, request)
	if w.Code != http.StatusOK {
		t.Fatalf("unexpected status %d body=%s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `BRIDGE_OK`) || !strings.Contains(body, `[DONE]`) {
		t.Fatalf("expected SSE relay body, got %s", body)
	}
	if directCalls != 0 {
		t.Fatalf("direct upstream should not be used in browser_bridge mode, got %d calls", directCalls)
	}
	if bridgeCalls != 1 {
		t.Fatalf("expected one bridge call, got %d", bridgeCalls)
	}
}

func TestAutoFallsBackToBrowserBridgeOnCloudflareBeforeStreamingStarts(t *testing.T) {
	var directCalls int
	direct := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		directCalls++
		if r.URL.Path != "/api/append_message" {
			t.Fatalf("unexpected direct path: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`Just a moment... Cloudflare`))
	}))
	defer direct.Close()

	bridgeCalls := 0
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bridgeCalls++
		writeJSON(w, http.StatusOK, map[string]any{
			"status":  200,
			"headers": map[string]any{"contentType": "text/event-stream"},
			"body": strings.Join([]string{
				`data: {"type":"content_block_delta","delta":{"text":"FALLBACK_OK"}}`,
				``,
				`data: {"type":"message_stop"}`,
				``,
			}, "\n"),
		})
	}))
	defer bridge.Close()

	dir := t.TempDir()
	runtimePath := filepath.Join(dir, "runtime.json")
	writeAuthExport(t, dir, "org-auto")
	cfg := &config.GatewayConfig{
		ListenHost:         "127.0.0.1",
		ListenPort:         8787,
		UpstreamBaseURL:    direct.URL,
		TransportMode:      "auto",
		HelperMode:         "browser_fetch",
		PreferBrowserOn403: true,
		CooldownMinutes:    15,
		MaxRetries:         1,
		ClaudeDailyLimit:   10,
		RespectRetryAfter:  true,
		BrowserBridgeURL:   bridge.URL,
		BrowserBridgeToken: "bridge-token",
		Accounts:           []config.ClaudeSessionAccount{{ID: "a1", Label: "Direct A1", SessionKey: "sk-a1", Enabled: true, DailyLimit: 10}},
	}
	svc := NewService(cfg, claudeweb.NewScheduler(cfg, runtimePath), runtimePath)
	request := claudeweb.ChatCompletionRequest{Model: "claude-sonnet-5", Stream: true, Messages: []claudeweb.ChatMessage{{Role: "user", Content: "hello auto"}}}
	w := httptest.NewRecorder()
	svc.handleStreamingChatCompletions(w, request)
	if w.Code != http.StatusOK {
		t.Fatalf("unexpected status %d body=%s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `FALLBACK_OK`) || !strings.Contains(body, `[DONE]`) {
		t.Fatalf("expected fallback SSE relay body, got %s", body)
	}
	if directCalls != 1 {
		t.Fatalf("expected one direct attempt before fallback, got %d", directCalls)
	}
	if bridgeCalls != 1 {
		t.Fatalf("expected one bridge fallback, got %d", bridgeCalls)
	}
	states := svc.Scheduler.Snapshot()
	if len(states) != 1 || states[0].Status != "cooling_down" || states[0].LastTransport != transportDirectHTTP {
		t.Fatalf("expected direct account to stay cooling_down after fallback, got %#v", states)
	}
}

func TestBrowserBridgeModeDoesNotFallbackToDirectWhenHelperUnavailable(t *testing.T) {
	var directCalls int
	direct := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		directCalls++
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"completion":"SHOULD_NOT_RUN"}`))
	}))
	defer direct.Close()

	dir := t.TempDir()
	runtimePath := filepath.Join(dir, "runtime.json")
	cfg := &config.GatewayConfig{ListenHost: "127.0.0.1", ListenPort: 8787, UpstreamBaseURL: direct.URL, TransportMode: "browser_bridge"}
	svc := NewService(cfg, claudeweb.NewScheduler(cfg, runtimePath), runtimePath)
	request := claudeweb.ChatCompletionRequest{Model: "claude-sonnet-5", Messages: []claudeweb.ChatMessage{{Role: "user", Content: "helper required"}}}
	w := httptest.NewRecorder()
	svc.handleUnaryChatCompletions(w, request)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("unexpected status %d body=%s", w.Code, w.Body.String())
	}
	if directCalls != 0 {
		t.Fatalf("direct upstream should not be used when browser bridge helper is unavailable")
	}
	if !strings.Contains(w.Body.String(), "browser bridge is not available") {
		t.Fatalf("expected helper unavailable error, got %s", w.Body.String())
	}
}

func writeAuthExport(t *testing.T, dir string, organizationID string) {
	t.Helper()
	auth := map[string]any{"cookies": []map[string]string{{"name": "lastActiveOrg", "value": organizationID}}}
	authData, err := json.Marshal(auth)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "claude-auth-export.json"), authData, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestAppendMessage404FallsBackToConversationCompletion(t *testing.T) {
	var paths []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), "你好") {
			t.Fatalf("payload should contain prompt: %s", body)
		}
		if r.URL.Path == "/api/append_message" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"type":"error","error":{"type":"not_found_error","message":"Not found"}}`))
			return
		}
		if strings.Contains(r.URL.Path, "/api/organizations/org-1/chat_conversations/") && strings.HasSuffix(r.URL.Path, "/completion") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"completion":"fallback ok"}`))
			return
		}
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte(r.URL.Path))
	}))
	defer upstream.Close()

	dir := t.TempDir()
	runtimePath := filepath.Join(dir, "runtime.json")
	auth := map[string]any{"cookies": []map[string]string{{"name": "lastActiveOrg", "value": "org-1"}}}
	authData, _ := json.Marshal(auth)
	if err := os.WriteFile(filepath.Join(dir, "claude-auth-export.json"), authData, 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := &config.GatewayConfig{ListenHost: "127.0.0.1", ListenPort: 8787, UpstreamBaseURL: upstream.URL, MaxRetries: 1, CooldownMinutes: 15, ClaudeDailyLimit: 10, RespectRetryAfter: true, Accounts: []config.ClaudeSessionAccount{{ID: "a1", Label: "ok", SessionKey: "sk-ok", Enabled: true, DailyLimit: 10}}}
	svc := NewService(cfg, claudeweb.NewScheduler(cfg, runtimePath), runtimePath)
	req := claudeweb.ChatCompletionRequest{Model: "claude-sonnet-5", Messages: []claudeweb.ChatMessage{{Role: "user", Content: "你好"}}}
	w := httptest.NewRecorder()
	svc.handleUnaryChatCompletions(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("unexpected status %d body=%s paths=%#v", w.Code, w.Body.String(), paths)
	}
	if len(paths) != 2 || paths[0] != "/api/append_message" || !strings.HasSuffix(paths[1], "/completion") {
		t.Fatalf("expected append_message then completion fallback, got %#v", paths)
	}
	if !strings.Contains(w.Body.String(), "fallback ok") {
		t.Fatalf("unexpected body: %s", w.Body.String())
	}
}

func TestLooksLikeEncodingFailure(t *testing.T) {
	positive := []string{
		"你的消息似乎出现了乱码，我没能完整读出内容。能麻烦你重新发一遍吗？",
		"It looks like your message came through with garbled/corrupted characters",
		"I'm just seeing a few boxes/symbols.",
	}
	for _, value := range positive {
		if !looksLikeEncodingFailure(value) {
			t.Fatalf("expected encoding failure marker for %q", value)
		}
	}
	negative := []string{
		"今天是星期二。",
		"收到。",
		"OK_BRIDGE_TEST",
	}
	for _, value := range negative {
		if looksLikeEncodingFailure(value) {
			t.Fatalf("did not expect encoding failure marker for %q", value)
		}
	}
}

func TestShouldPreferBrowserBridgeForRequestDetectsChineseContent(t *testing.T) {
	cfg := &config.GatewayConfig{TransportMode: "auto", HelperMode: "browser_fetch", PreferBrowserOn403: true}
	svc := NewService(cfg, claudeweb.NewScheduler(cfg, filepath.Join(t.TempDir(), "runtime.json")), filepath.Join(t.TempDir(), "runtime.json"))
	if !svc.shouldPreferBrowserBridgeForRequest(claudeweb.ChatCompletionRequest{Messages: []claudeweb.ChatMessage{{Role: "user", Content: "今天星期几？"}}}) {
		t.Fatal("expected Chinese request to prefer browser bridge")
	}
	if svc.shouldPreferBrowserBridgeForRequest(claudeweb.ChatCompletionRequest{Messages: []claudeweb.ChatMessage{{Role: "user", Content: "Reply exactly OK"}}}) {
		t.Fatal("did not expect ASCII request to prefer browser bridge")
	}
}

func TestAutoUsesBrowserBridgeFirstForChineseUnaryRequests(t *testing.T) {
	directCalls := 0
	direct := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		directCalls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"completion":"DIRECT_SHOULD_NOT_RUN"}`))
	}))
	defer direct.Close()

	bridgeCalls := 0
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bridgeCalls++
		writeJSON(w, http.StatusOK, map[string]any{
			"status":  200,
			"headers": map[string]any{"contentType": "application/json"},
			"body":    `{"completion":"今天是星期二。"}`,
		})
	}))
	defer bridge.Close()

	dir := t.TempDir()
	runtimePath := filepath.Join(dir, "runtime.json")
	writeAuthExport(t, dir, "org-auto-cn")
	cfg := &config.GatewayConfig{
		ListenHost:         "127.0.0.1",
		ListenPort:         8787,
		UpstreamBaseURL:    direct.URL,
		TransportMode:      "auto",
		HelperMode:         "browser_fetch",
		PreferBrowserOn403: true,
		MaxRetries:         1,
		ClaudeDailyLimit:   10,
		BrowserBridgeURL:   bridge.URL,
		BrowserBridgeToken: "bridge-token",
		Accounts:           []config.ClaudeSessionAccount{{ID: "a1", Label: "Direct A1", SessionKey: "sk-a1", Enabled: true, DailyLimit: 10}},
	}
	svc := NewService(cfg, claudeweb.NewScheduler(cfg, runtimePath), runtimePath)
	request := claudeweb.ChatCompletionRequest{Model: "claude-sonnet-5", Messages: []claudeweb.ChatMessage{{Role: "user", Content: "今天星期几？请直接回答星期几。"}}}
	w := httptest.NewRecorder()
	svc.handleUnaryChatCompletions(w, request)
	if w.Code != http.StatusOK {
		t.Fatalf("unexpected status %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "今天是星期二") {
		t.Fatalf("expected browser bridge response, got %s", w.Body.String())
	}
	if directCalls != 0 {
		t.Fatalf("expected no direct call for Chinese request, got %d", directCalls)
	}
	if bridgeCalls != 1 {
		t.Fatalf("expected one bridge call, got %d", bridgeCalls)
	}
}

func TestBrowserBridgeUsesAppendMessageRouteForAsciiRequests(t *testing.T) {
	var calledPath string
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calledPath = r.URL.Path
		writeJSON(w, http.StatusOK, map[string]any{
			"status":  200,
			"headers": map[string]any{"contentType": "application/json"},
			"body":    `{"completion":"ok"}`,
		})
	}))
	defer bridge.Close()

	dir := t.TempDir()
	runtimePath := filepath.Join(dir, "runtime.json")
	writeAuthExport(t, dir, "org-bridge-ascii")
	cfg := &config.GatewayConfig{
		ListenHost:         "127.0.0.1",
		ListenPort:         8787,
		TransportMode:      "browser_bridge",
		HelperMode:         "browser_fetch",
		BrowserBridgeURL:   bridge.URL,
		BrowserBridgeToken: "bridge-token",
	}
	svc := NewService(cfg, claudeweb.NewScheduler(cfg, runtimePath), runtimePath)
	request := claudeweb.ChatCompletionRequest{Model: "claude-sonnet-5", Messages: []claudeweb.ChatMessage{{Role: "user", Content: "Reply exactly OK"}}}
	w := httptest.NewRecorder()
	svc.handleUnaryChatCompletions(w, request)
	if w.Code != http.StatusOK {
		t.Fatalf("unexpected status %d body=%s", w.Code, w.Body.String())
	}
	if calledPath != "/append-message" {
		t.Fatalf("expected browser bridge append-message route for ascii, got %q", calledPath)
	}
}

func TestBrowserBridgeUsesComposerChatRouteForChineseRequests(t *testing.T) {
	var calledPath string
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calledPath = r.URL.Path
		writeJSON(w, http.StatusOK, map[string]any{
			"status":  200,
			"headers": map[string]any{"contentType": "application/json"},
			"body":    `{"completion":"收到。"}`,
		})
	}))
	defer bridge.Close()

	dir := t.TempDir()
	runtimePath := filepath.Join(dir, "runtime.json")
	writeAuthExport(t, dir, "org-bridge-cn")
	cfg := &config.GatewayConfig{
		ListenHost:         "127.0.0.1",
		ListenPort:         8787,
		TransportMode:      "browser_bridge",
		HelperMode:         "browser_fetch",
		BrowserBridgeURL:   bridge.URL,
		BrowserBridgeToken: "bridge-token",
	}
	svc := NewService(cfg, claudeweb.NewScheduler(cfg, runtimePath), runtimePath)
	request := claudeweb.ChatCompletionRequest{Model: "claude-sonnet-5", Messages: []claudeweb.ChatMessage{{Role: "user", Content: "你好，请直接回复：收到。"}}}
	w := httptest.NewRecorder()
	svc.handleUnaryChatCompletions(w, request)
	if w.Code != http.StatusOK {
		t.Fatalf("unexpected status %d body=%s", w.Code, w.Body.String())
	}
	if calledPath != "/composer-chat" {
		t.Fatalf("expected browser bridge composer-chat route, got %q", calledPath)
	}
}

func TestShouldPreferBrowserBridgeForEncodingSensitivePrompts(t *testing.T) {
	cfg := &config.GatewayConfig{TransportMode: "auto", HelperMode: "browser_fetch", PreferBrowserOn403: true}
	svc := NewService(cfg, claudeweb.NewScheduler(cfg, filepath.Join(t.TempDir(), "runtime.json")), filepath.Join(t.TempDir(), "runtime.json"))
	cases := []string{
		"你好，请直接回复：收到。",
		"今天星期几？请直接回答星期几。",
		"请用中文回答：1+1等于几？",
	}
	for _, prompt := range cases {
		if !svc.shouldPreferBrowserBridgeForRequest(claudeweb.ChatCompletionRequest{Messages: []claudeweb.ChatMessage{{Role: "user", Content: prompt}}}) {
			t.Fatalf("expected request to prefer browser bridge: %q", prompt)
		}
	}
}

func TestBrowserBridgeUsesComposerChatRouteForEncodingSensitiveAsciiPrompt(t *testing.T) {
	var calledPath string
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calledPath = r.URL.Path
		writeJSON(w, http.StatusOK, map[string]any{
			"status":  200,
			"headers": map[string]any{"contentType": "application/json"},
			"body":    `{"completion":"收到。"}`,
		})
	}))
	defer bridge.Close()

	dir := t.TempDir()
	runtimePath := filepath.Join(dir, "runtime.json")
	writeAuthExport(t, dir, "org-bridge-sensitive")
	cfg := &config.GatewayConfig{
		ListenHost:         "127.0.0.1",
		ListenPort:         8787,
		TransportMode:      "browser_bridge",
		HelperMode:         "browser_fetch",
		BrowserBridgeURL:   bridge.URL,
		BrowserBridgeToken: "bridge-token",
	}
	svc := NewService(cfg, claudeweb.NewScheduler(cfg, runtimePath), runtimePath)
	request := claudeweb.ChatCompletionRequest{Model: "claude-sonnet-5", Messages: []claudeweb.ChatMessage{{Role: "user", Content: "Please directly reply in Chinese: 收到。"}}}
	w := httptest.NewRecorder()
	svc.handleUnaryChatCompletions(w, request)
	if w.Code != http.StatusOK {
		t.Fatalf("unexpected status %d body=%s", w.Code, w.Body.String())
	}
	if calledPath != "/composer-chat" {
		t.Fatalf("expected browser bridge composer-chat route for encoding-sensitive prompt, got %q", calledPath)
	}
}

func TestBrowserBridgeComposerChatSendsPlainTextPayload(t *testing.T) {
	var body map[string]any
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/composer-chat" {
			t.Fatalf("unexpected bridge path: %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"status":  200,
			"headers": map[string]any{"contentType": "application/json"},
			"body":    `{"completion":"收到。"}`,
		})
	}))
	defer bridge.Close()

	dir := t.TempDir()
	runtimePath := filepath.Join(dir, "runtime.json")
	writeAuthExport(t, dir, "org-bridge-sensitive")
	cfg := &config.GatewayConfig{ListenHost: "127.0.0.1", ListenPort: 8787, TransportMode: "browser_bridge", HelperMode: "browser_fetch", BrowserBridgeURL: bridge.URL, BrowserBridgeToken: "bridge-token"}
	svc := NewService(cfg, claudeweb.NewScheduler(cfg, runtimePath), runtimePath)
	request := claudeweb.ChatCompletionRequest{Model: "claude-sonnet-5", Messages: []claudeweb.ChatMessage{{Role: "user", Content: "你好，请直接回复：收到。"}}}
	w := httptest.NewRecorder()
	svc.handleUnaryChatCompletions(w, request)
	if w.Code != http.StatusOK {
		t.Fatalf("unexpected status %d body=%s", w.Code, w.Body.String())
	}
	payload, ok := body["payload"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected payload map for composer-chat, got %#v", body)
	}
	if got, _ := payload["text"].(string); !strings.Contains(got, "你好") {
		t.Fatalf("expected plain text payload.text for composer-chat, got %#v", body)
	}
	if _, exists := body["appendMessagePayload"]; exists {
		t.Fatalf("composer-chat should not receive appendMessagePayload envelope: %#v", body)
	}
}
