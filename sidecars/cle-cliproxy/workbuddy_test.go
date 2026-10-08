package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	executor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
	translator "github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
)

func TestNativeOpenAIFramerRestoresConsumedDoneOnlyOnce(t *testing.T) {
	var output bytes.Buffer
	framer := newRelayStreamFramer(translator.FormatOpenAI, "/v1/chat/completions")
	if err := framer.Write(&output, []byte(`{"choices":[{"finish_reason":"stop"}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := framer.Close(&output); err != nil {
		t.Fatal(err)
	}
	if err := framer.Close(&output); err != nil {
		t.Fatal(err)
	}
	if strings.Count(output.String(), "data: [DONE]") != 1 {
		t.Fatalf("missing or duplicate DONE: %s", output.String())
	}
	var gemini bytes.Buffer
	framer = newRelayStreamFramer(translator.FormatGemini, "/v1beta/models/test:streamGenerateContent")
	_ = framer.Close(&gemini)
	if gemini.Len() != 0 {
		t.Fatal("added OpenAI marker to Gemini protocol")
	}
}

type workbuddyTestTransport func(*http.Request) (*http.Response, error)

func (f workbuddyTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

const workbuddyTestStream = `: heartbeat
data: {"id":"test-id","model":"hy3","created":123,"choices":[{"delta":{"content":"OK","reasoning_content":"thought"}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\"x\":"}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}

data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}

data: [DONE]

`

func TestWorkbuddyAggregatePreservesMetadataReasoningToolsAndUsage(t *testing.T) {
	raw, err := aggregateWorkbuddyCompletion(strings.NewReader(workbuddyTestStream))
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	if body["id"] != "test-id" || body["model"] != "hy3" || body["created"] != float64(123) {
		t.Fatalf("metadata lost: %s", raw)
	}
	message := body["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)
	if message["content"] != "OK" || message["reasoning_content"] != "thought" {
		t.Fatalf("message lost: %s", raw)
	}
	call := message["tool_calls"].([]any)[0].(map[string]any)
	if call["function"].(map[string]any)["arguments"] != `{"x":1}` {
		t.Fatalf("tools lost: %s", raw)
	}
	if body["usage"].(map[string]any)["total_tokens"] != float64(5) {
		t.Fatalf("usage lost: %s", raw)
	}
	if _, err := aggregateWorkbuddyCompletion(strings.NewReader(`data: {"choices":[{"delta":{"content":"partial"}}]}`)); err == nil {
		t.Fatal("accepted truncated stream")
	}
}

func TestWorkbuddyNormalizesRequestWithoutDiscardingUserContent(t *testing.T) {
	raw, streaming, err := prepareWorkbuddyBody([]byte(`{"model":"workbuddy/deepseek-test","messages":[{"role":"developer","content":"my policy"},{"role":"user","content":"unchanged"},{"role":"assistant","content":"prior"}],"max_completion_tokens":10,"tool_choice":{"type":"function","function":{"name":"lookup"}}}`))
	if err != nil || streaming {
		t.Fatalf("prepare: %s %v", raw, err)
	}
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	messages := body["messages"].([]any)
	if body["model"] != "deepseek-test" || body["stream"] != true || body["max_tokens"] != float64(10) || body["tool_choice"] != "lookup" {
		t.Fatalf("normalization: %s", raw)
	}
	if messages[0].(map[string]any)["content"] != "my policy" || messages[1].(map[string]any)["content"] != "unchanged" {
		t.Fatal("modified user instructions")
	}
	if _, exists := messages[2].(map[string]any)["reasoning_content"]; !exists {
		t.Fatal("missing reasoning backfill")
	}
}

func workbuddyTestBridge(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer internal-key" {
			w.WriteHeader(401)
			return
		}
		token := "original"
		if r.URL.Query().Get("refresh") == "1" {
			token = "refreshed"
		}
		_ = json.NewEncoder(w).Encode(workbuddyCredential{BaseURL: "https://copilot.tencent.com", Headers: map[string]string{"Authorization": "Bearer " + token, "X-IDE-Name": "WorkBuddy"}})
	}))
}

func TestWorkbuddyRefreshes401AndConvertsHTTP200BusinessFailures(t *testing.T) {
	bridge := workbuddyTestBridge(t)
	defer bridge.Close()
	for _, tc := range []struct {
		name, payload string
		want          int
	}{
		{"success", workbuddyTestStream, 200},
		{"empty credits", `{"code":1,"message":"积分不足"}`, 402},
		{"channel rejected", `{"code":11128,"message":"unapproved channel"}`, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			attempts := 0
			transport := &workbuddyRoundTripper{base: workbuddyTestTransport(func(r *http.Request) (*http.Response, error) {
				attempts++
				if r.Header.Get(workbuddyCredentialHeader) != "" || r.URL.Host != "copilot.tencent.com" {
					t.Fatal("leaked internal header or incorrect upstream")
				}
				if attempts == 1 {
					return workbuddyErrorResponse(r, 401, "expired"), nil
				}
				if r.Header.Get("Authorization") != "Bearer refreshed" {
					t.Fatal("credential did not refresh")
				}
				contentType := "application/json"
				if tc.want == 200 {
					contentType = "text/event-stream"
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{contentType}}, Body: io.NopCloser(strings.NewReader(tc.payload))}, nil
			})}
			request, _ := http.NewRequest("POST", "https://copilot.tencent.com/v2/chat/completions", strings.NewReader(`{"model":"workbuddy/hy3","messages":[{"role":"user","content":"hello"}]}`))
			request.Header.Set(workbuddyCredentialHeader, bridge.URL+"/credentials/account")
			request.Header.Set("Authorization", "Bearer internal-key")
			response, err := transport.RoundTrip(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != tc.want || attempts != 2 {
				t.Fatalf("status %d attempts %d", response.StatusCode, attempts)
			}
		})
	}
}

func TestWorkbuddyStreamingDoesNotHideLateErrorOrTruncation(t *testing.T) {
	for _, stream := range []string{
		"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
		"data: {\"choices\":[]}\n\ndata: {\"code\":11128,\"message\":\"unapproved channel\"}\n\n",
	} {
		_, err := io.ReadAll(&workbuddyValidatedReader{reader: bufio.NewReader(strings.NewReader(stream))})
		if err == nil {
			t.Fatal("incomplete stream reported as success")
		}
	}
}

func TestWorkbuddyUsesNativeResponsesTranslation(t *testing.T) {
	bridge := workbuddyTestBridge(t)
	defer bridge.Close()
	previous := http.DefaultTransport
	http.DefaultTransport = workbuddyTestTransport(func(r *http.Request) (*http.Response, error) {
		payload, _ := io.ReadAll(r.Body)
		if !bytes.Contains(payload, []byte(`"messages"`)) || bytes.Contains(payload, []byte(`"input"`)) {
			t.Fatalf("Responses not translated: %s", payload)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(workbuddyTestStream))}, nil
	})
	defer func() { http.DefaultTransport = previous }()
	e := newWorkbuddyExecutor(&config.Config{})
	auth := &coreauth.Auth{ID: "test", Provider: "workbuddy", Attributes: map[string]string{"base_url": "https://copilot.tencent.com/v2", "api_key": "internal-key", "header:" + workbuddyCredentialHeader: bridge.URL + "/credentials/account"}}
	result, err := e.Execute(context.Background(), auth, executor.Request{Model: "hy3", Payload: []byte(`{"model":"hy3","input":"hello"}`)}, executor.Options{SourceFormat: translator.FromString("openai-response")})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(result.Payload, []byte(`"object":"response"`)) || !bytes.Contains(result.Payload, []byte("OK")) {
		t.Fatalf("incorrect translated response: %s", result.Payload)
	}
}

func TestWorkbuddyRuntimeRotatesSeparateManagedCredentials(t *testing.T) {
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/credentials/")
		if r.Header.Get("Authorization") != "Bearer internal-"+id {
			w.WriteHeader(401)
			return
		}
		_ = json.NewEncoder(w).Encode(workbuddyCredential{BaseURL: "https://copilot.tencent.com", Headers: map[string]string{"Authorization": "Bearer account-" + id}})
	}))
	defer bridge.Close()
	var selected []string
	previous := http.DefaultTransport
	http.DefaultTransport = workbuddyTestTransport(func(r *http.Request) (*http.Response, error) {
		selected = append(selected, r.Header.Get("Authorization"))
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload["model"] != "hy3" {
			t.Fatalf("upstream alias not resolved: %v", payload["model"])
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(workbuddyTestStream))}, nil
	})
	defer func() { http.DefaultTransport = previous }()
	temp := t.TempDir()
	cfg := &config.Config{AuthDir: filepath.Join(temp, "auths")}
	m := &manifest{Providers: []string{"workbuddy"}, NativeModelRegistry: true, RoutingStrategy: "round-robin", ModelIDs: []string{"workbuddy/hy3"}, accountByID: map[string]*accountSpec{}, accountByAuthID: map[string]*accountSpec{}, accountByAPIKey: map[string]*accountSpec{}}
	for _, id := range []string{"a", "b"} {
		cfg.OpenAICompatibility = append(cfg.OpenAICompatibility, config.OpenAICompatibility{Name: "workbuddy", BaseURL: "https://copilot.tencent.com/v2", APIKeyEntries: []config.OpenAICompatibilityAPIKey{{APIKey: "internal-" + id}}, Headers: map[string]string{workbuddyCredentialHeader: bridge.URL + "/credentials/" + id}, Models: []config.OpenAICompatibilityModel{{Name: "hy3", Alias: "workbuddy/hy3"}}})
		account := &accountSpec{ID: id, AuthID: id, Provider: "workbuddy", UpstreamAPIKey: "internal-" + id, Models: []string{"workbuddy/hy3"}}
		m.Accounts = append(m.Accounts, *account)
		m.accountByID[id] = account
		m.accountByAPIKey[account.UpstreamAPIKey] = account
	}
	configPath := filepath.Join(temp, "config.json")
	raw, _ := json.Marshal(cfg)
	if err := os.WriteFile(configPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	manager := buildCoreAuthManager(cfg, &cleSelector{manifest: m}, &authHook{manifest: m})
	runtime, err := newSidecarRuntime(context.Background(), configPath, cfg, m, manager)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Stop()
	for i := 0; i < 2; i++ {
		_, err := runtime.Execute(context.Background(), []string{"workbuddy"}, executor.Request{Model: "workbuddy/hy3", Payload: []byte(`{"model":"workbuddy/hy3","messages":[{"role":"user","content":"hello"}]}`)}, executor.Options{SourceFormat: translator.FromString("openai")})
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(selected) != 2 || selected[0] == selected[1] {
		t.Fatalf("accounts did not rotate independently: %v", selected)
	}
}
