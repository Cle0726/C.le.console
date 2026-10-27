package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
	"github.com/tidwall/gjson"
)

func TestImageSelectorSkipsFreeAndUnavailableAccounts(t *testing.T) {
	selector := testRoundRobinSelector([]accountSpec{
		{ID: "free", AuthID: "free.json", Provider: "codex", PlanType: "free"},
		{ID: "unavailable", AuthID: "unavailable.json", Provider: "codex", PlanType: "plus", ImageGenerationStatus: "unavailable"},
		{ID: "plus", AuthID: "plus.json", Provider: "codex", PlanType: "plus"},
	})
	auths := []*coreauth.Auth{{ID: "free.json", Provider: "codex"}, {ID: "unavailable.json", Provider: "codex"}, {ID: "plus.json", Provider: "codex"}}
	for _, kind := range []string{"image_generation", "image_edit"} {
		ctx := context.WithValue(context.Background(), requestKindContextKey, kind)
		for i := 0; i < 6; i++ {
			chosen, err := selector.Pick(ctx, "codex", "gpt-6-luna", cliproxyexecutor.Options{}, auths)
			if err != nil || chosen.ID != "plus.json" {
				t.Fatalf("%s selected %#v, error %v", kind, chosen, err)
			}
		}
		if _, err := selector.Pick(ctx, "codex", "gpt-6-luna", cliproxyexecutor.Options{}, auths[:2]); err == nil || !strings.Contains(err.Error(), "没有可用于生图的账号") {
			t.Fatalf("missing clear error for %s: %v", kind, err)
		}
	}
}

func TestImageRelaySelectsEligibleAccountBeforeHostFallback(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var models, authHeaders []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		models = append(models, gjson.GetBytes(body, "model").String())
		authHeaders = append(authHeaders, r.Header.Get("Authorization"))
		if len(models) == 1 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"code":"model_not_found"}}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: " + `{"type":"response.completed","response":{"output":[{"type":"image_generation_call","result":"AA==","output_format":"png"}]}}` + "\n\n"))
	}))
	defer upstream.Close()
	selector := testRoundRobinSelector([]accountSpec{
		{ID: "test-free", AuthID: "image-host-free.json", Provider: "codex", PlanType: "free"},
		{ID: "test-plus", AuthID: "image-host-plus.json", Provider: "codex", PlanType: "plus"},
	})
	m := selector.manifest
	m.ModelIDs = []string{"gpt-image-2"} // The configured host is deliberately absent.
	m.apiKeyByValue = map[string]*apiKeySpec{"client-key": {ID: "key", Key: "client-key", Enabled: true}}
	cfg := &config.Config{}
	cfg.GPTImage2BaseModel = "gpt-host-not-in-catalog"
	manager := coreauth.NewManager(nil, selector, nil)
	manager.RegisterExecutor(executor.NewCodexExecutor(cfg))
	for _, item := range []struct{ id, key, plan string }{
		{"image-host-free.json", "free-test-key", "free"},
		{"image-host-plus.json", "plus-test-key", "plus"},
	} {
		auth, err := manager.Register(context.Background(), &coreauth.Auth{ID: item.id, Provider: "codex", Status: coreauth.StatusActive,
			Attributes: map[string]string{"base_url": upstream.URL, "api_key": item.key, "plan_type": item.plan}})
		if err != nil {
			t.Fatal(err)
		}
		registerManifestModelsForAuth(manager, m, auth)
		t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(item.id) })
	}
	router := (&relayServer{runtime: manager, cfg: cfg, manifest: m, policy: &requestPolicy{manifest: m}}).router()
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"model":"gpt-image-2","prompt":"draw"}`))
	req.Header.Set("Authorization", "Bearer client-key")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK || gjson.GetBytes(w.Body.Bytes(), "data.0.b64_json").String() != "AA==" {
		t.Fatalf("image request failed: %d %s", w.Code, w.Body.String())
	}
	if !reflect.DeepEqual(models, []string{"gpt-host-not-in-catalog", "gpt-6-luna"}) {
		t.Fatalf("unexpected host sequence: %v", models)
	}
	if !reflect.DeepEqual(authHeaders, []string{"Bearer plus-test-key", "Bearer plus-test-key"}) {
		t.Fatalf("image was not retried on the same plus account: %v", authHeaders)
	}
}

func TestImageRelayUsesConfiguredHostAndRejectsFreeOnlyPool(t *testing.T) {
	gin.SetMode(gin.TestMode)
	stream := make(chan cliproxyexecutor.StreamChunk, 1)
	stream <- cliproxyexecutor.StreamChunk{Payload: []byte("data: " + `{"type":"response.completed","response":{"output":[{"type":"image_generation_call","result":"AA=="}]}}` + "\n\n")}
	close(stream)
	runtime := &fakeRuntime{streamResult: &cliproxyexecutor.StreamResult{Headers: http.Header{}, Chunks: stream}}
	m := &manifest{Accounts: []accountSpec{{ID: "plus", PlanType: "plus", Provider: "codex"}},
		ModelIDs: []string{"gpt-image-2"}, apiKeyByValue: map[string]*apiKeySpec{"client-key": {ID: "key", Key: "client-key", Enabled: true}}}
	cfg := &config.Config{}
	cfg.GPTImage2BaseModel = "gpt-6-sol"
	router := (&relayServer{runtime: runtime, cfg: cfg, manifest: m, policy: &requestPolicy{manifest: m}}).router()
	send := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"model":"gpt-image-2","prompt":"draw"}`))
		req.Header.Set("Authorization", "Bearer client-key")
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	if w := send(); w.Code != http.StatusOK {
		t.Fatalf("configured request: %d %s", w.Code, w.Body.String())
	}
	if runtime.lastReq.Model != "gpt-image-2" || gjson.GetBytes(runtime.lastReq.Payload, "model").String() != "gpt-6-sol" {
		t.Fatal("configured image host did not reach the executor")
	}
	m.Accounts[0].PlanType = "free"
	if w := send(); w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "没有可用于生图的账号") {
		t.Fatalf("free pool: %d %s", w.Code, w.Body.String())
	}
	// The Rust gateway hides gpt-image-2 when the pool has no eligible account.
	// The middleware must still give the useful reason, not an unrelated 404.
	m.ModelIDs = nil
	if w := send(); w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "没有可用于生图的账号") {
		t.Fatalf("hidden image model with free pool: %d %s", w.Code, w.Body.String())
	}
	if runtime.streamCalls != 1 {
		t.Fatal("free pool reached upstream")
	}
}
