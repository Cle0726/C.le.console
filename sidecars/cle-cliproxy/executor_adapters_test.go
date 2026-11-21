package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

// Every executor the sidecar wraps itself (WorkBuddy, Kiro, GitHub Copilot, Claude)
// owns the step that turns a placeholder key into a real account credential. CLIProxyAPI
// v8 can silently swap such a wrapper for a bare native executor in two places:
//   - ForAPIKey(): the conductor calls it on every API-key auth right before Execute, and a
//     promoted ForAPIKey from an embedded native executor returns the bare copy;
//   - rebinding: the service re-registers executors on startup, credential updates and
//     config reloads.
//
// Either way requests reach the provider with the placeholder key and every account answers
// 401 (v1.1.55 shipped exactly that for WorkBuddy). This test fails for any wrapper added
// later that loses its adapter the same way.
func TestSidecarAdaptersSurviveV8ScopingAndRebinding(t *testing.T) {
	temp := t.TempDir()
	cfg := &config.Config{AuthDir: filepath.Join(temp, "auths")}
	m := &manifest{Providers: []string{"workbuddy", "kiro", "github-copilot", "claude"}, NativeModelRegistry: true, RoutingStrategy: "round-robin", accountByID: map[string]*accountSpec{}, accountByAuthID: map[string]*accountSpec{}, accountByAPIKey: map[string]*accountSpec{}}
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

	adapters := map[string]string{
		"openai-compatible-workbuddy": "workbuddyExecutor",
		"kiro":                        "managedNativeExecutor",
		"github-copilot":              "managedNativeExecutor",
		"claude":                      "managedNativeExecutor",
	}
	registered := map[string]reflect.Type{}
	for key, name := range adapters {
		executor, ok := manager.Executor(key)
		if !ok {
			t.Fatalf("%s: no executor registered", key)
		}
		registered[key] = reflect.TypeOf(executor)
		if !strings.HasSuffix(registered[key].String(), name) {
			t.Fatalf("%s: registered %v, want the %s adapter", key, registered[key], name)
		}
		if scoped, ok := executor.(coreauth.APIKeyConfigExecutor); ok {
			if got := reflect.TypeOf(scoped.ForAPIKey()); got != registered[key] {
				t.Errorf("%s: ForAPIKey returns %v and would bypass the %v adapter", key, got, registered[key])
			}
		}
	}

	runtime.service.RebindRuntimeExecutors()
	for key := range adapters {
		executor, ok := manager.Executor(key)
		if !ok || reflect.TypeOf(executor) != registered[key] {
			t.Errorf("%s: adapter %v was replaced by %v when the service rebound its executors", key, registered[key], reflect.TypeOf(executor))
		}
	}
}
