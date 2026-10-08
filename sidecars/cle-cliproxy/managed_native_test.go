package main

import (
	"context"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestManagedNativeBridgeRotatesAndKeepsOriginalPrivate(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/credentials/kiro~account-1" || r.Header.Get("Authorization") != "Bearer local-secret" {
			t.Error("invalid capability request")
		}
		calls++
		if calls == 2 && r.URL.Query().Get("refresh") != "1" {
			t.Error("force refresh lost")
		}
		w.Header().Set("Content-Type", "application/json")
		if calls == 1 {
			_, _ = w.Write([]byte(`{"metadata":{"access_token":"first","profile_arn":"test"}}`))
		} else {
			_, _ = w.Write([]byte(`{"metadata":{"access_token":"rotated"}}`))
		}
	}))
	defer server.Close()
	auth := &coreauth.Auth{ID: "account-1", Provider: "kiro", Attributes: map[string]string{"api_key": "local-secret", "header:" + managedCredentialHeader: server.URL + "/credentials/kiro~account-1"}}
	first, err := prepareManagedNativeAuth(context.Background(), auth, false)
	if err != nil {
		t.Fatal(err)
	}
	if first.Metadata["access_token"] != "first" || first.Attributes["header:"+managedCredentialHeader] != "" {
		t.Fatal("fresh token or capability stripping failed")
	}
	second, err := prepareManagedNativeAuth(context.Background(), first, true)
	if err != nil {
		t.Fatal(err)
	}
	if second.Metadata["access_token"] != "rotated" || auth.Metadata["access_token"] != nil {
		t.Fatal("mutated authoritative account or failed rotation")
	}
	original, err := (&managedNativeExecutor{}).Refresh(context.Background(), auth)
	if err != nil {
		t.Fatal(err)
	}
	if original.Metadata["access_token"] != nil {
		t.Fatal("persisted duplicate OAuth token")
	}
}

func TestManagedNativeBridgeRejectsRemoteAndRedirects(t *testing.T) {
	for _, endpoint := range []string{"https://example.com/credentials/kiro~x", "http://127.0.0.1/credentials/kiro~x/../../token", "http://127.0.0.1/credentials/kiro~x?evil=1", "http://user@127.0.0.1/credentials/kiro~x"} {
		auth := &coreauth.Auth{Provider: "kiro", Attributes: map[string]string{"header:" + managedCredentialHeader: endpoint}}
		if _, err := prepareManagedNativeAuth(context.Background(), auth, false); err == nil {
			t.Fatal("accepted unsafe bridge")
		}
	}
	destinationCalls := 0
	destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { destinationCalls++ }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, http.StatusFound) }))
	defer source.Close()
	auth := &coreauth.Auth{Provider: "kiro", Attributes: map[string]string{"api_key": "private", "header:" + managedCredentialHeader: source.URL + "/credentials/kiro~x"}}
	_, err := prepareManagedNativeAuth(context.Background(), auth, false)
	if err == nil || destinationCalls != 0 || strings.Contains(err.Error(), "private") {
		t.Fatal("redirect followed or secret leaked")
	}
}

func TestManagedNativeBridgeRejectsMissingOrInvalidTokens(t *testing.T) {
	for _, body := range []string{`{"metadata":{}}`, `{"metadata":{"access_token":123}}`, `{"metadata":{"access_token":""}}`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) }))
		auth := &coreauth.Auth{Provider: "github-copilot", Attributes: map[string]string{"header:" + managedCredentialHeader: server.URL + "/credentials/github-copilot~x"}}
		_, err := prepareManagedNativeAuth(context.Background(), auth, false)
		server.Close()
		if err == nil {
			t.Fatal("accepted invalid token")
		}
	}
}
