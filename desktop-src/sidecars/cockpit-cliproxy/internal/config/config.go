package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

const (
	BrowserBridgeEnvURL       = "COCKPIT_BROWSER_BRIDGE_URL"
	BrowserBridgeEnvToken     = "COCKPIT_BROWSER_BRIDGE_TOKEN"
	BrowserBridgeEnvStateFile = "COCKPIT_BROWSER_BRIDGE_STATE_FILE"
)

type ClaudeSessionAccount struct {
	ID         string `json:"id"`
	Label      string `json:"label"`
	SessionKey string `json:"sessionKey"`
	ProxyURL   string `json:"proxyUrl,omitempty"`
	Enabled    bool   `json:"enabled"`
	DailyLimit int    `json:"dailyLimit,omitempty"`
}

type ClaudeSessionRuntimeState struct {
	AccountID           string `json:"accountId"`
	Status              string `json:"status"`
	TodayCalls          int    `json:"todayCalls"`
	CooldownUntil       string `json:"cooldownUntil,omitempty"`
	RetryAfterUntil     string `json:"retryAfterUntil,omitempty"`
	LastError           string `json:"lastError,omitempty"`
	LastSuccessAt       string `json:"lastSuccessAt,omitempty"`
	LastFailureKind     string `json:"lastFailureKind,omitempty"`
	LastStatusCode      int    `json:"lastStatusCode,omitempty"`
	LastTransport       string `json:"lastTransport,omitempty"`
	ConsecutiveFailures int    `json:"consecutiveFailures,omitempty"`
}

type GatewayConfig struct {
	Enabled                   bool                   `json:"enabled"`
	ListenHost                string                 `json:"listenHost"`
	ListenPort                int                    `json:"listenPort"`
	UpstreamBaseURL           string                 `json:"upstreamBaseUrl,omitempty"`
	TransportMode             string                 `json:"transportMode"`
	HelperMode                string                 `json:"helperMode"`
	ProbeBeforeStart          bool                   `json:"probeBeforeStart"`
	PreferBrowserOn403        bool                   `json:"preferBrowserOn403"`
	RespectRetryAfter         bool                   `json:"respectRetryAfter"`
	StreamFirstChunkTimeoutMs int                    `json:"streamFirstChunkTimeoutMs"`
	MaxRetries                int                    `json:"maxRetries"`
	CooldownMinutes           int                    `json:"cooldownMinutes"`
	ClaudeDailyLimit          int                    `json:"claudeDailyLimit"`
	RequireAPIKey             bool                   `json:"requireApiKey"`
	LocalAPIKey               string                 `json:"localApiKey,omitempty"`
	Accounts                  []ClaudeSessionAccount `json:"accounts"`
	BrowserBridgeURL          string                 `json:"-"`
	BrowserBridgeToken        string                 `json:"-"`
	BrowserBridgeStateFile    string                 `json:"-"`
}

type ModelInfo struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	OwnedBy string `json:"owned_by"`
}

func Load(path string) (*GatewayConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var cfg GatewayConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	Normalize(&cfg)
	return &cfg, nil
}

func Normalize(cfg *GatewayConfig) {
	if strings.TrimSpace(cfg.ListenHost) == "" {
		cfg.ListenHost = "127.0.0.1"
	}
	if cfg.ListenPort <= 0 {
		cfg.ListenPort = 8787
	}
	cfg.UpstreamBaseURL = strings.TrimRight(strings.TrimSpace(cfg.UpstreamBaseURL), "/")
	if cfg.UpstreamBaseURL == "" {
		cfg.UpstreamBaseURL = "https://claude.ai"
	}
	cfg.TransportMode = normalizeTransportMode(cfg.TransportMode)
	cfg.HelperMode = normalizeHelperMode(cfg.HelperMode)
	if cfg.StreamFirstChunkTimeoutMs <= 0 {
		cfg.StreamFirstChunkTimeoutMs = 8000
	}
	if cfg.MaxRetries <= 0 {
		cfg.MaxRetries = 3
	}
	if cfg.CooldownMinutes <= 0 {
		cfg.CooldownMinutes = 15
	}
	if cfg.ClaudeDailyLimit <= 0 {
		cfg.ClaudeDailyLimit = 100
	}
	cfg.BrowserBridgeURL = strings.TrimSpace(os.Getenv(BrowserBridgeEnvURL))
	cfg.BrowserBridgeToken = strings.TrimSpace(os.Getenv(BrowserBridgeEnvToken))
	cfg.BrowserBridgeStateFile = strings.TrimSpace(os.Getenv(BrowserBridgeEnvStateFile))
	for i := range cfg.Accounts {
		cfg.Accounts[i].ID = strings.TrimSpace(cfg.Accounts[i].ID)
		if cfg.Accounts[i].ID == "" {
			cfg.Accounts[i].ID = fmt.Sprintf("acct_%d", i+1)
		}
		if strings.TrimSpace(cfg.Accounts[i].Label) == "" {
			cfg.Accounts[i].Label = fmt.Sprintf("Claude Web %d", i+1)
		}
		cfg.Accounts[i].SessionKey = strings.TrimSpace(cfg.Accounts[i].SessionKey)
		cfg.Accounts[i].ProxyURL = strings.TrimSpace(cfg.Accounts[i].ProxyURL)
		if cfg.Accounts[i].DailyLimit <= 0 {
			cfg.Accounts[i].DailyLimit = cfg.ClaudeDailyLimit
		}
	}
}

func normalizeTransportMode(value string) string {
	switch strings.TrimSpace(value) {
	case "browser_bridge":
		return "browser_bridge"
	case "auto":
		return "auto"
	default:
		return "direct_http"
	}
}

func normalizeHelperMode(value string) string {
	switch strings.TrimSpace(value) {
	case "disabled":
		return "disabled"
	case "browser_fetch":
		return "browser_fetch"
	case "page_context":
		return "page_context"
	default:
		return "probe_only"
	}
}

func DefaultModels() []ModelInfo {
	return []ModelInfo{
		{ID: "claude-sonnet-5", Object: "model", Created: 0, OwnedBy: "claude-web"},
		{ID: "claude-haiku-4-5", Object: "model", Created: 0, OwnedBy: "claude-web"},
		{ID: "claude-3-7-sonnet-latest", Object: "model", Created: 0, OwnedBy: "claude-web"},
		{ID: "claude-3-5-haiku-latest", Object: "model", Created: 0, OwnedBy: "claude-web"},
	}
}
