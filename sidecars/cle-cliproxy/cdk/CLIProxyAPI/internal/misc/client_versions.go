package misc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	log "github.com/sirupsen/logrus"
)

const (
	ClientGeminiCLI    = "gemini-cli"
	ClientGoogleGenAI  = "google-genai"
	ClientClaudeCode   = "claude-code"
	ClientAnthropicSDK = "anthropic-sdk"
	ClientCodex        = "codex"
	ClientXAI          = "xai-grok"
	ClientCopilotChat  = "copilot-chat"
	ClientKiro         = "kiro"
	ClientNode         = "node"

	clientVersionRefreshInterval = 6 * time.Hour
	clientVersionFetchTimeout    = 10 * time.Second
)

// Fallbacks are the versions known when this build was made. StartClientVersionUpdaters
// replaces them with the vendor's current release, so a later release does not need a
// code change as long as the machine can reach the vendor.
var clientVersionFallbacks = map[string]string{
	ClientGeminiCLI:    "0.67.0",
	ClientGoogleGenAI:  "1.41.0",
	ClientClaudeCode:   "2.1.319",
	ClientAnthropicSDK: "1.6.0",
	ClientCodex:        "0.167.0",
	ClientXAI:          "1.0.77",
	ClientCopilotChat:  "0.48.1",
	ClientKiro:         "0.8.1",
	ClientNode:         "22.19.0",
}

type clientVersionFeed struct {
	id    string
	fetch func(context.Context, *http.Client) (string, error)
}

var (
	clientVersionMu      sync.RWMutex
	clientVersionCache   = map[string]string{}
	clientVersionsActive bool
	clientVersionOnce    sync.Once
)

func clientVersionFeeds() []clientVersionFeed {
	return []clientVersionFeed{
		{ClientGeminiCLI, npmLatestVersion("@google/gemini-cli")},
		{ClientGoogleGenAI, npmLatestVersion("@google/genai")},
		{ClientClaudeCode, npmLatestVersion("@anthropic-ai/claude-code")},
		{ClientAnthropicSDK, npmLatestVersion("@anthropic-ai/sdk")},
		{ClientCodex, npmLatestVersion("@openai/codex")},
		{ClientXAI, npmLatestVersion("@xai-official/grok")},
		{ClientNode, npmLatestVersion("node")},
		{ClientCopilotChat, copilotChatLatestVersion},
		{ClientKiro, kiroLatestVersion},
	}
}

// StartClientVersionUpdaters refreshes every account-pool client version in the background.
// Until the first successful fetch, callers still get the built-in fallback.
func StartClientVersionUpdaters(ctx context.Context) {
	clientVersionOnce.Do(func() {
		if ctx == nil {
			ctx = context.Background()
		}
		clientVersionMu.Lock()
		clientVersionsActive = true
		for id, version := range clientVersionFallbacks {
			clientVersionCache[id] = version
		}
		clientVersionMu.Unlock()
		go runClientVersionUpdaters(ctx)
	})
}

// ClientVersionsActive reports whether the background refresh has been started.
// Callers with a legacy fixture version should keep that fixture until then.
func ClientVersionsActive() bool {
	clientVersionMu.RLock()
	defer clientVersionMu.RUnlock()
	return clientVersionsActive
}

// ClientVersion returns the newest known version for id.
// Before StartClientVersionUpdaters it returns the built-in fallback.
func ClientVersion(id string) string {
	clientVersionMu.RLock()
	defer clientVersionMu.RUnlock()
	if clientVersionsActive {
		if version := strings.TrimSpace(clientVersionCache[id]); version != "" {
			return version
		}
	}
	return clientVersionFallbacks[id]
}

func runClientVersionUpdaters(ctx context.Context) {
	refreshClientVersions(ctx)
	ticker := time.NewTicker(clientVersionRefreshInterval)
	defer ticker.Stop()
	log.Infof("account-pool client version refresh started (interval=%s)", clientVersionRefreshInterval)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			refreshClientVersions(ctx)
		}
	}
}

func refreshClientVersions(ctx context.Context) {
	client := &http.Client{Timeout: clientVersionFetchTimeout}
	for _, feed := range clientVersionFeeds() {
		version, err := feed.fetch(ctx, client)
		if err != nil {
			log.WithError(err).WithField("client", feed.id).Debug("client version refresh failed, keeping fallback")
			continue
		}
		clientVersionMu.Lock()
		clientVersionCache[feed.id] = version
		clientVersionMu.Unlock()
		log.WithFields(log.Fields{"client": feed.id, "version": version}).Info("refreshed account-pool client version")
	}
}

func npmLatestVersion(pkg string) func(context.Context, *http.Client) (string, error) {
	return func(ctx context.Context, client *http.Client) (string, error) {
		escaped := strings.ReplaceAll(pkg, "/", "%2f")
		endpoint := "https://registry.npmjs.org/" + escaped + "/latest"
		body, err := clientVersionGET(ctx, client, endpoint, nil)
		if err != nil {
			return "", fmt.Errorf("npm %s: %w", pkg, err)
		}
		var doc struct {
			Version string `json:"version"`
		}
		if err := json.Unmarshal(body, &doc); err != nil {
			return "", fmt.Errorf("npm %s: decode: %w", pkg, err)
		}
		version := strings.TrimPrefix(strings.TrimSpace(doc.Version), "v")
		if !isValidClientVersion(version) {
			return "", fmt.Errorf("npm %s: invalid version %q", pkg, doc.Version)
		}
		return version, nil
	}
}

func copilotChatLatestVersion(ctx context.Context, client *http.Client) (string, error) {
	payload := []byte(`{"filters":[{"criteria":[{"filterType":7,"value":"GitHub.copilot-chat"}]}],"flags":914}`)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json;api-version=3.0-preview.1")
	req.Header.Set("Content-Type", "application/json")
	body, err := clientVersionDo(client, req)
	if err != nil {
		return "", fmt.Errorf("copilot marketplace: %w", err)
	}
	version, err := copilotChatVersionFromMarketplace(body)
	if err != nil {
		return "", err
	}
	return version, nil
}

func copilotChatVersionFromMarketplace(body []byte) (string, error) {
	var doc struct {
		Results []struct {
			Extensions []struct {
				Versions []struct {
					Version string `json:"version"`
				} `json:"versions"`
			} `json:"extensions"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return "", fmt.Errorf("copilot marketplace: decode: %w", err)
	}
	if len(doc.Results) == 0 || len(doc.Results[0].Extensions) == 0 || len(doc.Results[0].Extensions[0].Versions) == 0 {
		return "", fmt.Errorf("copilot marketplace: empty result")
	}
	version := strings.TrimSpace(doc.Results[0].Extensions[0].Versions[0].Version)
	if !isValidClientVersion(version) {
		return "", fmt.Errorf("copilot marketplace: invalid version %q", version)
	}
	return version, nil
}

func kiroLatestVersion(ctx context.Context, client *http.Client) (string, error) {
	body, err := clientVersionGET(ctx, client, "https://prod.download.desktop.kiro.dev/stable/latest-mac.yml", map[string]string{
		"User-Agent": "electron-builder",
	})
	if err != nil {
		return "", err
	}
	version := versionFromUpdaterManifest(body)
	if !isValidClientVersion(version) {
		return "", fmt.Errorf("kiro manifest: invalid version %q", version)
	}
	return version, nil
}

func versionFromUpdaterManifest(body []byte) string {
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(strings.ToLower(line), "version:") {
			continue
		}
		return strings.Trim(strings.TrimSpace(strings.TrimPrefix(line, "version:")), `"'`)
	}
	return ""
}

func clientVersionGET(ctx context.Context, client *http.Client, endpoint string, headers map[string]string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	return clientVersionDo(client, req)
}

func clientVersionDo(client *http.Client, req *http.Request) ([]byte, error) {
	if client == nil {
		client = &http.Client{Timeout: clientVersionFetchTimeout}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return body, nil
}

func isValidClientVersion(version string) bool {
	version = strings.TrimSpace(version)
	if version == "" || len(version) > 64 {
		return false
	}
	core := version
	if idx := strings.IndexAny(core, "-+"); idx >= 0 {
		core = core[:idx]
	}
	parts := strings.Split(core, ".")
	if len(parts) < 2 || len(parts) > 4 {
		return false
	}
	for _, part := range parts {
		if part == "" {
			return false
		}
		for _, ch := range part {
			if ch < '0' || ch > '9' {
				return false
			}
		}
	}
	return true
}
