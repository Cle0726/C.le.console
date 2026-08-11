package executor

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/nacl/box"
)

const codexAgentIdentityAuthMode = "agentIdentity"

var codexAgentIdentityAuthAPIBaseURL = "https://auth.openai.com/api/accounts"

type codexAgentIdentityCredential struct {
	runtimeID   string
	privateKey  ed25519.PrivateKey
	taskID      string
	fingerprint string
}

type codexAgentIdentityRuntime struct {
	mu         sync.Mutex
	credential codexAgentIdentityCredential
}

var codexAgentIdentityRuntimes sync.Map

func codexAgentIdentityMetadataString(auth *cliproxyauth.Auth, keys ...string) string {
	if auth == nil || auth.Metadata == nil {
		return ""
	}
	for _, key := range keys {
		if value, ok := auth.Metadata[key].(string); ok {
			if value = strings.TrimSpace(value); value != "" {
				return value
			}
		}
	}
	return ""
}

func isCodexAgentIdentityAuth(auth *cliproxyauth.Auth) bool {
	mode := codexAgentIdentityMetadataString(auth, "auth_mode", "openai_auth_mode")
	return strings.EqualFold(mode, codexAgentIdentityAuthMode)
}

func loadCodexAgentIdentityCredential(auth *cliproxyauth.Auth) (codexAgentIdentityCredential, error) {
	if !isCodexAgentIdentityAuth(auth) {
		return codexAgentIdentityCredential{}, errors.New("codex agent identity auth is required")
	}
	runtimeID := codexAgentIdentityMetadataString(auth, "agent_runtime_id", "agentRuntimeId")
	encodedPrivateKey := codexAgentIdentityMetadataString(auth, "agent_private_key", "agentPrivateKey")
	if runtimeID == "" || encodedPrivateKey == "" {
		return codexAgentIdentityCredential{}, errors.New("codex agent identity runtime or private key is missing")
	}
	der, err := base64.StdEncoding.DecodeString(encodedPrivateKey)
	if err != nil {
		return codexAgentIdentityCredential{}, errors.New("codex agent identity private key is not valid base64")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return codexAgentIdentityCredential{}, errors.New("codex agent identity private key is not valid PKCS#8")
	}
	privateKey, ok := parsed.(ed25519.PrivateKey)
	if !ok || len(privateKey) != ed25519.PrivateKeySize {
		return codexAgentIdentityCredential{}, errors.New("codex agent identity private key is not Ed25519")
	}
	fingerprintBytes := sha256.Sum256([]byte(runtimeID + "\x00" + encodedPrivateKey))
	return codexAgentIdentityCredential{
		runtimeID:   runtimeID,
		privateKey:  privateKey,
		taskID:      codexAgentIdentityMetadataString(auth, "task_id", "taskId"),
		fingerprint: base64.RawURLEncoding.EncodeToString(fingerprintBytes[:]),
	}, nil
}

func codexAgentIdentityRuntimeFor(auth *cliproxyauth.Auth) (*codexAgentIdentityRuntime, error) {
	credential, err := loadCodexAgentIdentityCredential(auth)
	if err != nil {
		return nil, err
	}
	key := strings.TrimSpace(auth.ID)
	if key == "" {
		key = credential.fingerprint
	}
	candidate := &codexAgentIdentityRuntime{credential: credential}
	actual, _ := codexAgentIdentityRuntimes.LoadOrStore(key, candidate)
	runtimeState, ok := actual.(*codexAgentIdentityRuntime)
	if !ok {
		return nil, errors.New("codex agent identity runtime has invalid type")
	}
	runtimeState.mu.Lock()
	if runtimeState.credential.fingerprint != credential.fingerprint {
		runtimeState.credential = credential
	} else if runtimeState.credential.taskID == "" && credential.taskID != "" {
		runtimeState.credential.taskID = credential.taskID
	}
	runtimeState.mu.Unlock()
	return runtimeState, nil
}

func buildCodexAgentAssertion(credential codexAgentIdentityCredential, now time.Time) (string, error) {
	if credential.runtimeID == "" || credential.taskID == "" {
		return "", errors.New("codex agent identity runtime or task is missing")
	}
	timestamp := now.UTC().Format(time.RFC3339)
	payload := []byte(credential.runtimeID + ":" + credential.taskID + ":" + timestamp)
	signature, err := credential.privateKey.Sign(nil, payload, crypto.Hash(0))
	if err != nil {
		return "", errors.New("failed to sign codex agent assertion")
	}
	envelope, err := json.Marshal(map[string]string{
		"agent_runtime_id": credential.runtimeID,
		"task_id":          credential.taskID,
		"timestamp":        timestamp,
		"signature":        base64.StdEncoding.EncodeToString(signature),
	})
	if err != nil {
		return "", errors.New("failed to serialize codex agent assertion")
	}
	return "AgentAssertion " + base64.RawURLEncoding.EncodeToString(envelope), nil
}

func decryptCodexAgentIdentityTaskID(credential codexAgentIdentityCredential, encoded string) (string, error) {
	ciphertext, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return "", errors.New("encrypted codex agent task id is not valid base64")
	}
	digest := sha512.Sum512(credential.privateKey.Seed())
	var curvePrivate [32]byte
	copy(curvePrivate[:], digest[:32])
	curvePrivate[0] &= 248
	curvePrivate[31] &= 127
	curvePrivate[31] |= 64
	curvePublicBytes, err := curve25519.X25519(curvePrivate[:], curve25519.Basepoint)
	if err != nil {
		return "", errors.New("failed to derive codex agent identity decryption key")
	}
	var curvePublic [32]byte
	copy(curvePublic[:], curvePublicBytes)
	plaintext, ok := box.OpenAnonymous(nil, ciphertext, &curvePublic, &curvePrivate)
	if !ok {
		return "", errors.New("failed to decrypt codex agent task id")
	}
	taskID := strings.TrimSpace(string(plaintext))
	if taskID == "" {
		return "", errors.New("decrypted codex agent task id is empty")
	}
	return taskID, nil
}

func registerCodexAgentIdentityTask(ctx context.Context, transport http.RoundTripper, credential codexAgentIdentityCredential) (string, error) {
	timestamp := time.Now().UTC().Format(time.RFC3339)
	signature, err := credential.privateKey.Sign(nil, []byte(credential.runtimeID+":"+timestamp), crypto.Hash(0))
	if err != nil {
		return "", errors.New("failed to sign codex agent task registration")
	}
	body, _ := json.Marshal(map[string]string{
		"timestamp": timestamp,
		"signature": base64.StdEncoding.EncodeToString(signature),
	})
	requestCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	url := strings.TrimRight(codexAgentIdentityAuthAPIBaseURL, "/") + "/v1/agent/" + credential.runtimeID + "/task/register"
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if transport == nil {
		transport = http.DefaultTransport
	}
	resp, err := transport.RoundTrip(req)
	if err != nil {
		return "", fmt.Errorf("codex agent task registration failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("codex agent task registration returned status %d", resp.StatusCode)
	}
	var result struct {
		TaskID               string `json:"task_id"`
		TaskIDCamel          string `json:"taskId"`
		EncryptedTaskID      string `json:"encrypted_task_id"`
		EncryptedTaskIDCamel string `json:"encryptedTaskId"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&result); err != nil {
		return "", errors.New("codex agent task registration response is invalid")
	}
	if result.TaskID != "" {
		return strings.TrimSpace(result.TaskID), nil
	}
	if result.TaskIDCamel != "" {
		return strings.TrimSpace(result.TaskIDCamel), nil
	}
	encrypted := result.EncryptedTaskID
	if encrypted == "" {
		encrypted = result.EncryptedTaskIDCamel
	}
	if strings.TrimSpace(encrypted) == "" {
		return "", errors.New("codex agent task registration response omitted task id")
	}
	return decryptCodexAgentIdentityTaskID(credential, encrypted)
}

func persistCodexAgentIdentityTask(auth *cliproxyauth.Auth, credential codexAgentIdentityCredential, taskID string) error {
	taskID = strings.TrimSpace(taskID)
	if auth == nil || taskID == "" || auth.Attributes == nil {
		return nil
	}
	path := strings.TrimSpace(auth.Attributes["path"])
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var payload map[string]any
	if err = json.Unmarshal(data, &payload); err != nil {
		return err
	}
	payload["task_id"] = taskID
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	temp, err := os.CreateTemp(filepath.Dir(path), ".agent-identity-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	_ = temp.Chmod(0o600)
	if _, err = temp.Write(encoded); err == nil {
		err = temp.Sync()
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(tempPath, path)
}

func ensureCodexAgentIdentityAssertion(ctx context.Context, auth *cliproxyauth.Auth, transport http.RoundTripper, expectedTaskID string) (string, error) {
	runtimeState, err := codexAgentIdentityRuntimeFor(auth)
	if err != nil {
		return "", err
	}
	runtimeState.mu.Lock()
	defer runtimeState.mu.Unlock()
	if runtimeState.credential.taskID == "" || (expectedTaskID != "" && runtimeState.credential.taskID == expectedTaskID) {
		taskID, err := registerCodexAgentIdentityTask(ctx, transport, runtimeState.credential)
		if err != nil {
			return "", err
		}
		if err = persistCodexAgentIdentityTask(auth, runtimeState.credential, taskID); err != nil {
			return "", err
		}
		runtimeState.credential.taskID = taskID
		CloseCodexWebsocketSessionsForAuthID(auth.ID, "agent_identity_task_recovered")
	}
	return buildCodexAgentAssertion(runtimeState.credential, time.Now())
}

func isCodexAgentIdentityTaskInvalid(statusCode int, body []byte) bool {
	if statusCode != http.StatusUnauthorized {
		return false
	}
	lower := strings.ToLower(string(body))
	return strings.Contains(lower, "invalid_task_id") ||
		strings.Contains(lower, "task_not_found") ||
		strings.Contains(lower, "task expired") ||
		strings.Contains(lower, "invalid task id")
}

type codexAgentIdentityRoundTripper struct {
	base http.RoundTripper
	auth *cliproxyauth.Auth
}

func cloneCodexAgentIdentityRequest(req *http.Request) (*http.Request, error) {
	cloned := req.Clone(req.Context())
	cloned.Header = req.Header.Clone()
	if req.GetBody != nil {
		body, err := req.GetBody()
		if err != nil {
			return nil, err
		}
		cloned.Body = body
	} else if req.Body != nil {
		body, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		req.Body = io.NopCloser(bytes.NewReader(body))
		req.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(body)), nil
		}
		cloned.Body = io.NopCloser(bytes.NewReader(body))
	}
	return cloned, nil
}

func (t *codexAgentIdentityRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	assertion, err := ensureCodexAgentIdentityAssertion(req.Context(), t.auth, t.base, "")
	if err != nil {
		return nil, err
	}
	first, err := cloneCodexAgentIdentityRequest(req)
	if err != nil {
		return nil, err
	}
	first.Header.Set("Authorization", assertion)
	resp, err := t.base.RoundTrip(first)
	if err != nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		return resp, err
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	resp.Body = io.NopCloser(bytes.NewReader(body))
	if !isCodexAgentIdentityTaskInvalid(resp.StatusCode, body) {
		return resp, nil
	}
	runtimeState, err := codexAgentIdentityRuntimeFor(t.auth)
	if err != nil {
		return nil, err
	}
	runtimeState.mu.Lock()
	expectedTaskID := runtimeState.credential.taskID
	runtimeState.mu.Unlock()
	assertion, err = ensureCodexAgentIdentityAssertion(req.Context(), t.auth, t.base, expectedTaskID)
	if err != nil {
		return nil, err
	}
	retry, err := cloneCodexAgentIdentityRequest(req)
	if err != nil {
		return nil, err
	}
	retry.Header.Set("Authorization", assertion)
	return t.base.RoundTrip(retry)
}

func newCodexAuthenticatedHTTPClient(ctx context.Context, cfg *config.Config, auth *cliproxyauth.Auth) *http.Client {
	client := helps.NewUtlsHTTPClient(ctx, cfg, auth, 0)
	if !isCodexAgentIdentityAuth(auth) {
		return client
	}
	base := client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	client.Transport = &codexAgentIdentityRoundTripper{base: base, auth: auth}
	return client
}
