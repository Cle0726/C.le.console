package executor

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

type agentIdentityRoundTripperFunc func(*http.Request) (*http.Response, error)

func (fn agentIdentityRoundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func testAgentIdentityAuth(t *testing.T, taskID string) *cliproxyauth.Auth {
	t.Helper()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	return &cliproxyauth.Auth{
		ID:       "agent-test",
		Provider: "codex",
		Metadata: map[string]any{
			"auth_mode":         "agentIdentity",
			"agent_runtime_id":  "runtime-test",
			"agent_private_key": base64.StdEncoding.EncodeToString(der),
			"task_id":           taskID,
		},
	}
}

func TestBuildCodexAgentAssertion(t *testing.T) {
	auth := testAgentIdentityAuth(t, "task-test")
	credential, err := loadCodexAgentIdentityCredential(auth)
	if err != nil {
		t.Fatal(err)
	}
	assertion, err := buildCodexAgentAssertion(
		credential,
		time.Date(2026, 7, 23, 10, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(assertion, "AgentAssertion ") {
		t.Fatalf("unexpected assertion: %q", assertion)
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(assertion, "AgentAssertion "))
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]string
	if err = json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope["agent_runtime_id"] != "runtime-test" || envelope["task_id"] != "task-test" {
		t.Fatalf("unexpected assertion envelope: %#v", envelope)
	}
	if envelope["signature"] == "" {
		t.Fatal("assertion signature is empty")
	}
}

func TestAgentIdentityRoundTripperRegistersMissingTask(t *testing.T) {
	auth := testAgentIdentityAuth(t, "")
	var registrationCalls, upstreamCalls int
	transport := agentIdentityRoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		if strings.Contains(req.URL.Path, "/task/register") {
			registrationCalls++
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body: io.NopCloser(strings.NewReader(
					`{"task_id":"registered-task"}`,
				)),
				Request: req,
			}, nil
		}
		upstreamCalls++
		if got := req.Header.Get("Authorization"); !strings.HasPrefix(got, "AgentAssertion ") {
			t.Fatalf("missing AgentAssertion authorization: %q", got)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
			Request:    req,
		}, nil
	})
	rt := &codexAgentIdentityRoundTripper{base: transport, auth: auth}
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, "https://example.test/responses", strings.NewReader(`{}`))
	req.GetBody = func() (io.ReadCloser, error) {
		return io.NopCloser(strings.NewReader(`{}`)), nil
	}
	resp, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if registrationCalls != 1 || upstreamCalls != 1 {
		t.Fatalf("registration=%d upstream=%d", registrationCalls, upstreamCalls)
	}
}
