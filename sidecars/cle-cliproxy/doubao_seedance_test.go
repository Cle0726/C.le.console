package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

func TestDoubaoSeedanceGenerationMapsModelRatioAndCookie(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var upstreamBody map[string]any
	var upstreamCookie string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/video/create" {
			t.Fatalf("unexpected upstream request: %s %s", r.Method, r.URL.Path)
		}
		upstreamCookie = r.Header.Get("Cookie")
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &upstreamBody); err != nil {
			t.Fatalf("decode upstream body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"success":true,"data":{"task":{"task_id":"task-1"}}}`)
	}))
	defer upstream.Close()

	router := newDoubaoSeedanceTestRouter([]accountSpec{{
		ID:             "seedance-a",
		Provider:       doubaoSeedanceProvider,
		UpstreamAPIKey: "foo=bar; connect.sid=sid-value; theme=dark",
		BaseURL:        upstream.URL,
		Models:         []string{doubaoSeedanceModel15},
	}}, nil)
	req := httptest.NewRequest(http.MethodPost, videosGenerationsPath, strings.NewReader(`{
		"model":"doubao-seedance-1.5-pro","prompt":"cat","seconds":5,"size":"1280x720","input_image":"https://example.com/cat.png"
	}`))
	req.Header.Set("Authorization", "Bearer client-key")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if upstreamCookie != "connect.sid=sid-value" {
		t.Fatalf("unexpected cookie: %q", upstreamCookie)
	}
	if upstreamBody["model"] != "seedance-1-5-pro-251215" || upstreamBody["radio"] != "16:9" || upstreamBody["image"] != "https://example.com/cat.png" {
		t.Fatalf("unexpected mapped body: %#v", upstreamBody)
	}
	var response map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response["id"] != "task-1" || response["provider"] != doubaoSeedanceProvider || response["model"] != doubaoSeedanceModel15 {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestDoubaoSeedanceGenerationNeverRetriesMutation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var firstCalls atomic.Int32
	var secondCalls atomic.Int32
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		firstCalls.Add(1)
		http.Error(w, "temporary upstream failure", http.StatusBadGateway)
	}))
	defer first.Close()
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		secondCalls.Add(1)
		_, _ = io.WriteString(w, `{"taskId":"must-not-be-used"}`)
	}))
	defer second.Close()

	router := newDoubaoSeedanceTestRouter([]accountSpec{
		{ID: "first", Provider: doubaoSeedanceProvider, UpstreamAPIKey: "one", BaseURL: first.URL, Priority: 10, Models: []string{doubaoSeedanceModel15}},
		{ID: "second", Provider: doubaoSeedanceProvider, UpstreamAPIKey: "two", BaseURL: second.URL, Models: []string{doubaoSeedanceModel15}},
	}, nil)
	req := httptest.NewRequest(http.MethodPost, videosGenerationsPath, strings.NewReader(`{"model":"doubao-seedance-1.5-pro","prompt":"cat"}`))
	req.Header.Set("Authorization", "Bearer client-key")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if firstCalls.Load() != 1 || secondCalls.Load() != 0 {
		t.Fatalf("mutation must not fail over: first=%d second=%d", firstCalls.Load(), secondCalls.Load())
	}
	if !strings.Contains(w.Body.String(), "not retried") {
		t.Fatalf("response must explain retry safety: %s", w.Body.String())
	}
}

func TestDoubaoSeedanceStatusSafelyFailsOverReads(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var firstCalls atomic.Int32
	var secondCalls atomic.Int32
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		firstCalls.Add(1)
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	defer first.Close()
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		secondCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true,"items":[{"taskId":"task-2","status":"success","videoUrl":"https://cdn.example.com/video.mp4","model":"seedance-1-0-pro-fast"}]}`)
	}))
	defer second.Close()

	router := newDoubaoSeedanceTestRouter([]accountSpec{
		{ID: "first", Provider: doubaoSeedanceProvider, UpstreamAPIKey: "one", BaseURL: first.URL, Priority: 10},
		{ID: "second", Provider: doubaoSeedanceProvider, UpstreamAPIKey: "two", BaseURL: second.URL},
	}, nil)
	req := httptest.NewRequest(http.MethodGet, videosGenerationsPath+"/task-2", nil)
	req.Header.Set("Authorization", "Bearer client-key")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if firstCalls.Load() != 1 || secondCalls.Load() != 1 {
		t.Fatalf("safe status lookup should fail over: first=%d second=%d", firstCalls.Load(), secondCalls.Load())
	}
	if !strings.Contains(w.Body.String(), `"status":"completed"`) || !strings.Contains(w.Body.String(), `"model":"doubao-seedance-1.0-pro-fast"`) {
		t.Fatalf("unexpected normalized status: %s", w.Body.String())
	}
}

func TestDoubaoSeedanceHonorsDownstreamAccountScope(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var blockedCalls atomic.Int32
	blocked := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		blockedCalls.Add(1)
		_, _ = io.WriteString(w, `{"taskId":"wrong"}`)
	}))
	defer blocked.Close()
	allowed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"taskId":"scoped-task"}`)
	}))
	defer allowed.Close()

	router := newDoubaoSeedanceTestRouter([]accountSpec{
		{ID: "blocked", Provider: doubaoSeedanceProvider, UpstreamAPIKey: "one", BaseURL: blocked.URL, Priority: 100},
		{ID: "allowed", AuthID: "allowed-auth", Provider: doubaoSeedanceProvider, UpstreamAPIKey: "two", BaseURL: allowed.URL},
	}, []string{"allowed-auth"})
	req := httptest.NewRequest(http.MethodPost, videosGenerationsPath, strings.NewReader(`{"model":"doubao-seedance-1.5-pro","prompt":"cat"}`))
	req.Header.Set("Authorization", "Bearer client-key")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "scoped-task") {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if blockedCalls.Load() != 0 {
		t.Fatalf("out-of-scope account was called %d times", blockedCalls.Load())
	}
}

func TestDoubaoSeedanceRejectsUnsupportedRatioBeforeUpstream(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, `{"taskId":"wrong"}`)
	}))
	defer upstream.Close()
	router := newDoubaoSeedanceTestRouter([]accountSpec{{
		ID: "seedance", Provider: doubaoSeedanceProvider, UpstreamAPIKey: "sid", BaseURL: upstream.URL,
	}}, nil)
	req := httptest.NewRequest(http.MethodPost, videosGenerationsPath, strings.NewReader(`{"model":"doubao-seedance-1.5-pro","prompt":"cat","ratio":"5:7"}`))
	req.Header.Set("Authorization", "Bearer client-key")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest || calls.Load() != 0 {
		t.Fatalf("status=%d calls=%d body=%s", w.Code, calls.Load(), w.Body.String())
	}
}

func newDoubaoSeedanceTestRouter(accounts []accountSpec, accountScope []string) *gin.Engine {
	spec := apiKeySpec{
		ID:         "client-key-id",
		Label:      "Client key",
		Key:        "client-key",
		AccountIDs: accountScope,
		Enabled:    true,
	}
	m := &manifest{
		APIKeys:             []apiKeySpec{spec},
		Accounts:            accounts,
		ModelIDs:            []string{doubaoSeedanceModel15, doubaoSeedanceModel10Fast},
		Providers:           []string{doubaoSeedanceProvider},
		NativeModelRegistry: true,
		apiKeyByValue:       map[string]*apiKeySpec{"client-key": &spec},
	}
	return (&relayServer{
		cfg:      &config.Config{},
		manifest: m,
		policy:   &requestPolicy{manifest: m},
	}).router()
}
