package httpapi

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"claude-web-gateway-sidecar/internal/claudeweb"
	"claude-web-gateway-sidecar/internal/config"
)

const (
	transportDirectHTTP    = "direct_http"
	transportBrowserBridge = "browser_bridge"
)

type UpstreamFailure struct {
	StatusCode      int
	Kind            string
	Message         string
	Transport       string
	RetryAfterDelay time.Duration
	RetryAfterUntil string
}

type Service struct {
	Config      *config.GatewayConfig
	Scheduler   *claudeweb.Scheduler
	RuntimePath string
	Models      []config.ModelInfo
	Bridge      *browserBridgeClient
}

func NewService(cfg *config.GatewayConfig, scheduler *claudeweb.Scheduler, runtimePath string) *Service {
	return &Service{
		Config:      cfg,
		Scheduler:   scheduler,
		RuntimePath: runtimePath,
		Models:      config.DefaultModels(),
		Bridge:      newBrowserBridgeClient(cfg),
	}
}

func (s *Service) HandleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, HealthResponse{Status: "ok", AccountsCount: len(s.Config.Accounts), ModelsCount: len(s.Models)})
}

func (s *Service) HandleModels(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, ModelsResponse{Object: "list", Data: s.Models})
}

func (s *Service) HandleRuntime(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Scheduler.Snapshot())
}

func (s *Service) HandleChatCompletions(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	var req claudeweb.ChatCompletionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", fmt.Sprintf("invalid JSON body: %v", err))
		return
	}
	if req.Stream {
		s.handleStreamingChatCompletions(w, req)
		return
	}
	s.handleUnaryChatCompletions(w, req)
}

func (s *Service) handleUnaryChatCompletions(w http.ResponseWriter, request claudeweb.ChatCompletionRequest) {
	if s.shouldUseBrowserBridgeOnly() || s.shouldPreferBrowserBridgeForRequest(request) {
		raw, failure := s.executeBrowserBridgeCompletion(request)
		if failure != nil {
			writeOpenAIError(w, normalizeStatus(failure.StatusCode), "upstream_error", failure.Message)
			return
		}
		s.writeOpenAIUnaryResponse(w, request.Model, raw)
		return
	}

	attempts := s.maxAttempts()
	var lastFailure *UpstreamFailure
	bridgeBroken := false
	for attempt := 0; attempt < attempts; attempt++ {
		account, err := s.Scheduler.NextEligible()
		if err != nil {
			if s.shouldAllowBrowserBridgeFallback() && !bridgeBroken {
				raw, failure := s.executeBrowserBridgeCompletion(request)
				if failure == nil {
					s.writeOpenAIUnaryResponse(w, request.Model, raw)
					return
				}
				lastFailure = failure
				if failure.Kind == "helper_unavailable" {
					bridgeBroken = true
				}
				break
			}
			writeOpenAIError(w, http.StatusTooManyRequests, "no_available_session", err.Error())
			return
		}
		raw, failure := s.executeClaudeCompletion(account, request)
		if failure == nil {
			s.Scheduler.MarkSuccess(account.ID, transportDirectHTTP)
			if bridgeRaw, ok := s.maybeUseBrowserBridgeForBetterUnicode(request, raw); ok {
				s.writeOpenAIUnaryResponse(w, request.Model, bridgeRaw)
				return
			}
			s.writeOpenAIUnaryResponse(w, request.Model, raw)
			return
		}
		lastFailure = failure
		if !s.recordAccountFailure(account.ID, *failure) {
			writeOpenAIError(w, normalizeStatus(failure.StatusCode), "upstream_error", failure.Message)
			return
		}
		if s.shouldFallbackToBrowserBridge(*failure) && !bridgeBroken {
			bridgeRaw, bridgeFailure := s.executeBrowserBridgeCompletion(request)
			if bridgeFailure == nil {
				s.writeOpenAIUnaryResponse(w, request.Model, bridgeRaw)
				return
			}
			lastFailure = bridgeFailure
			if bridgeFailure.Kind == "helper_unavailable" {
				bridgeBroken = true
			}
		}
	}
	if lastFailure == nil {
		writeOpenAIError(w, http.StatusBadGateway, "upstream_error", "unknown upstream error")
		return
	}
	writeOpenAIError(w, normalizeStatus(lastFailure.StatusCode), "upstream_error", lastFailure.Message)
}

func (s *Service) handleStreamingChatCompletions(w http.ResponseWriter, request claudeweb.ChatCompletionRequest) {
	streamID := claudeweb.NewStreamID()
	created := time.Now().Unix()
	if s.shouldUseBrowserBridgeOnly() {
		started, failure := s.proxyBrowserBridgeStream(w, request, streamID, created)
		if failure == nil || started {
			return
		}
		writeOpenAIError(w, normalizeStatus(failure.StatusCode), "upstream_error", failure.Message)
		return
	}

	attempts := s.maxAttempts()
	var lastFailure *UpstreamFailure
	bridgeBroken := false
	for attempt := 0; attempt < attempts; attempt++ {
		account, err := s.Scheduler.NextEligible()
		if err != nil {
			if s.shouldAllowBrowserBridgeFallback() && !bridgeBroken {
				started, failure := s.proxyBrowserBridgeStream(w, request, streamID, created)
				if failure == nil || started {
					return
				}
				lastFailure = failure
				if failure.Kind == "helper_unavailable" {
					bridgeBroken = true
				}
				break
			}
			writeOpenAIError(w, http.StatusTooManyRequests, "no_available_session", err.Error())
			return
		}
		response, err := s.startClaudeAppendMessageRequest(account, request)
		if err != nil {
			failure := networkFailure(err, transportDirectHTTP)
			lastFailure = &failure
			if !s.recordAccountFailure(account.ID, failure) {
				writeOpenAIError(w, normalizeStatus(failure.StatusCode), "upstream_error", failure.Message)
				return
			}
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			raw, _ := io.ReadAll(response.Body)
			response.Body.Close()
			failure := classifyUpstreamFailure(response.StatusCode, response.Header, raw, transportDirectHTTP, s.Config.RespectRetryAfter)
			lastFailure = &failure
			if !s.recordAccountFailure(account.ID, failure) {
				writeOpenAIError(w, normalizeStatus(failure.StatusCode), "upstream_error", failure.Message)
				return
			}
			if s.shouldFallbackToBrowserBridge(failure) && !bridgeBroken {
				started, bridgeFailure := s.proxyBrowserBridgeStream(w, request, streamID, created)
				if bridgeFailure == nil || started {
					return
				}
				lastFailure = bridgeFailure
				if bridgeFailure.Kind == "helper_unavailable" {
					bridgeBroken = true
				}
			}
			continue
		}
		started, err := s.proxyClaudeStream(w, response, request.Model, streamID, created)
		if err == nil {
			s.Scheduler.MarkSuccess(account.ID, transportDirectHTTP)
			return
		}
		failure := UpstreamFailure{StatusCode: http.StatusBadGateway, Kind: "stream_parse_error", Message: err.Error(), Transport: transportDirectHTTP}
		lastFailure = &failure
		_ = s.recordAccountFailure(account.ID, failure)
		if started {
			return
		}
	}
	if lastFailure == nil {
		writeOpenAIError(w, http.StatusBadGateway, "upstream_error", "unknown upstream error")
		return
	}
	writeOpenAIError(w, normalizeStatus(lastFailure.StatusCode), "upstream_error", lastFailure.Message)
}

func (s *Service) transportMode() string {
	if s == nil || s.Config == nil {
		return transportDirectHTTP
	}
	switch strings.TrimSpace(s.Config.TransportMode) {
	case transportBrowserBridge:
		return transportBrowserBridge
	case "auto":
		return "auto"
	default:
		return transportDirectHTTP
	}
}

func (s *Service) helperModeAllowsBrowserBridge() bool {
	if s == nil || s.Config == nil {
		return false
	}
	switch strings.TrimSpace(s.Config.HelperMode) {
	case "browser_fetch", "page_context":
		return true
	default:
		return false
	}
}

func (s *Service) shouldUseBrowserBridgeOnly() bool {
	return s.transportMode() == transportBrowserBridge
}

func (s *Service) shouldAllowBrowserBridgeFallback() bool {
	return s.transportMode() == "auto" && s.Config != nil && s.Config.PreferBrowserOn403 && s.helperModeAllowsBrowserBridge()
}

func containsCJKText(value string) bool {
	for _, r := range value {
		switch {
		case r >= 0x4E00 && r <= 0x9FFF:
			return true
		case r >= 0x3400 && r <= 0x4DBF:
			return true
		case r >= 0x3040 && r <= 0x30FF:
			return true
		case r >= 0xAC00 && r <= 0xD7AF:
			return true
		}
	}
	return false
}

func requestContainsCJK(request claudeweb.ChatCompletionRequest) bool {
	for _, message := range request.Messages {
		if containsCJKText(claudeweb.BuildPrompt([]claudeweb.ChatMessage{message})) {
			return true
		}
	}
	return false
}

func (s *Service) shouldPreferBrowserBridgeForRequest(request claudeweb.ChatCompletionRequest) bool {
	if s.shouldUseBrowserBridgeOnly() {
		return true
	}
	if s.shouldAllowBrowserBridgeFallback() && requestContainsCJK(request) {
		return true
	}
	if looksLikeEncodingSensitiveRequest(request) {
		return true
	}
	return false
}

func looksLikeEncodingSensitiveRequest(request claudeweb.ChatCompletionRequest) bool {
	prompt := strings.ToLower(strings.TrimSpace(claudeweb.BuildPrompt(request.Messages)))
	if prompt == "" {
		return false
	}
	markers := []string{
		"请直接回复",
		"请直接回答",
		"请用中文回答",
		"星期几",
		"收到",
		"乱码",
	}
	for _, marker := range markers {
		if strings.Contains(prompt, marker) {
			return true
		}
	}
	return false
}

func (s *Service) shouldFallbackToBrowserBridge(failure UpstreamFailure) bool {
	if !s.shouldAllowBrowserBridgeFallback() {
		return false
	}
	switch failure.Kind {
	case "cloudflare_block", "risk_control_block":
		return true
	default:
		return false
	}
}

func looksLikeEncodingFailure(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false
	}
	markers := []string{
		"乱码",
		"没能完整读出",
		"重新发一遍",
		"didn't render properly",
		"came through empty",
		"appeared garbled",
		"garbled/corrupted characters",
		"encoding issue",
		"boxes/symbols",
	}
	for _, marker := range markers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func (s *Service) maybeUseBrowserBridgeForBetterUnicode(request claudeweb.ChatCompletionRequest, raw []byte) ([]byte, bool) {
	if !s.shouldAllowBrowserBridgeFallback() {
		return raw, false
	}
	text := claudeweb.ExtractClaudeText(raw)
	if !looksLikeEncodingFailure(text) {
		return raw, false
	}
	bridgeRaw, failure := s.executeBrowserBridgeCompletion(request)
	if failure != nil {
		return raw, false
	}
	return bridgeRaw, true
}

func (s *Service) writeOpenAIUnaryResponse(w http.ResponseWriter, model string, raw []byte) {
	writeJSON(w, http.StatusOK, claudeweb.BuildOpenAIResponse(model, claudeweb.ExtractClaudeText(raw)))
}

func (s *Service) maxAttempts() int {
	attempts := s.Config.MaxRetries
	if attempts <= 0 {
		attempts = 1
	}
	if len(s.Config.Accounts) > 0 && attempts > len(s.Config.Accounts) {
		attempts = len(s.Config.Accounts)
	}
	return attempts
}

func (s *Service) recordAccountFailure(accountID string, failure UpstreamFailure) bool {
	cooldown := time.Duration(s.Config.CooldownMinutes) * time.Minute
	switch failure.Kind {
	case "rate_limited":
		if failure.RetryAfterDelay > cooldown {
			cooldown = failure.RetryAfterDelay
		}
		s.Scheduler.MarkCooldown(accountID, failure.Message, failure.Kind, failure.StatusCode, failure.Transport, cooldown, failure.RetryAfterUntil)
		return true
	case "invalid_session":
		s.Scheduler.MarkInvalid(accountID, failure.Message, failure.Kind, failure.StatusCode, failure.Transport)
		return true
	case "cloudflare_block", "risk_control_block":
		s.Scheduler.MarkCooldown(accountID, failure.Message, failure.Kind, failure.StatusCode, failure.Transport, cooldown, failure.RetryAfterUntil)
		return true
	case "network_error", "upstream_5xx", "stream_parse_error":
		s.Scheduler.MarkCooldown(accountID, failure.Message, failure.Kind, failure.StatusCode, failure.Transport, 2*time.Minute, failure.RetryAfterUntil)
		return true
	default:
		return false
	}
}

func (s *Service) startClaudeAppendMessageRequest(account *config.ClaudeSessionAccount, request claudeweb.ChatCompletionRequest) (*http.Response, error) {
	organizationID, err := s.loadLastActiveOrg()
	if err != nil {
		return nil, err
	}
	client, err := claudeweb.NewHTTPClient(account.ProxyURL)
	if err != nil {
		return nil, fmt.Errorf("invalid proxy URL for %s: %w", account.Label, err)
	}
	_, payload := claudeweb.BuildClaudeAppendMessagePayload(request, organizationID)
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	baseURL := claudeBaseURL(s.Config)
	completionURL := fmt.Sprintf("%s/api/append_message", baseURL)
	httpRequest, err := http.NewRequest(http.MethodPost, completionURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	applyClaudeHeaders(httpRequest, baseURL, organizationID, account.SessionKey)
	return client.Do(httpRequest)
}

func (s *Service) startClaudeCompletionRequest(account *config.ClaudeSessionAccount, request claudeweb.ChatCompletionRequest) (*http.Response, error) {
	organizationID, err := s.loadLastActiveOrg()
	if err != nil {
		return nil, err
	}
	client, err := claudeweb.NewHTTPClient(account.ProxyURL)
	if err != nil {
		return nil, fmt.Errorf("invalid proxy URL for %s: %w", account.Label, err)
	}
	conversationUUID, payload := claudeweb.BuildClaudeCompletionPayload(request, organizationID)
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	baseURL := claudeBaseURL(s.Config)
	completionURL := fmt.Sprintf("%s/api/organizations/%s/chat_conversations/%s/completion", baseURL, organizationID, conversationUUID)
	httpRequest, err := http.NewRequest(http.MethodPost, completionURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	applyClaudeHeaders(httpRequest, baseURL, organizationID, account.SessionKey)
	return client.Do(httpRequest)
}

func (s *Service) executeBrowserBridgeCompletion(request claudeweb.ChatCompletionRequest) ([]byte, *UpstreamFailure) {
	if s == nil || s.Bridge == nil || !s.Bridge.available() {
		failure := helperUnavailableFailure("browser bridge is not available")
		return nil, &failure
	}
	organizationID, err := s.loadLastActiveOrg()
	if err != nil {
		failure := helperUnavailableFailure(err.Error())
		return nil, &failure
	}
	response, err := s.Bridge.executeCompletion(request, organizationID)
	if err != nil {
		failure := helperUnavailableFailure(err.Error())
		return nil, &failure
	}
	if response.Status < 200 || response.Status >= 300 {
		failure := classifyUpstreamFailure(response.Status, response.httpHeader(), []byte(response.Body), transportBrowserBridge, s.Config.RespectRetryAfter)
		return []byte(response.Body), &failure
	}
	return []byte(response.Body), nil
}

func (s *Service) proxyBrowserBridgeStream(w http.ResponseWriter, request claudeweb.ChatCompletionRequest, streamID string, created int64) (bool, *UpstreamFailure) {
	raw, failure := s.executeBrowserBridgeCompletion(request)
	if failure != nil {
		return false, failure
	}
	started, err := s.proxyClaudeStreamReader(w, bytes.NewReader(raw), request.Model, streamID, created)
	if err != nil {
		failure := UpstreamFailure{StatusCode: http.StatusBadGateway, Kind: "stream_parse_error", Message: err.Error(), Transport: transportBrowserBridge}
		return started, &failure
	}
	return true, nil
}

func applyClaudeHeaders(r *http.Request, baseURL, organizationID, sessionKey string) {
	r.Header.Set("content-type", "application/json")
	r.Header.Set("accept", "text/event-stream, application/json")
	r.Header.Set("accept-language", "en-US,en;q=0.9")
	r.Header.Set("origin", baseURL)
	r.Header.Set("referer", baseURL+"/new")
	r.Header.Set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
	r.Header.Set("x-organization-uuid", organizationID)
	r.Header.Set("anthropic-client-platform", "web_claude_ai")
	r.Header.Set("anthropic-client-sha", "unknown")
	r.Header.Set("sec-ch-ua", `"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"`)
	r.Header.Set("sec-ch-ua-mobile", "?0")
	r.Header.Set("sec-ch-ua-platform", `"Windows"`)
	r.Header.Set("sec-fetch-dest", "empty")
	r.Header.Set("sec-fetch-mode", "cors")
	r.Header.Set("sec-fetch-site", "same-origin")
	r.Header.Set("priority", "u=1, i")
	r.Header.Set("cache-control", "no-cache")
	r.Header.Set("pragma", "no-cache")
	r.Header.Set("cookie", fmt.Sprintf("sessionKey=%s; lastActiveOrg=%s", sessionKey, organizationID))
}

func (s *Service) executeClaudeCompletion(account *config.ClaudeSessionAccount, request claudeweb.ChatCompletionRequest) ([]byte, *UpstreamFailure) {
	response, err := s.startClaudeAppendMessageRequest(account, request)
	if err != nil {
		failure := networkFailure(err, transportDirectHTTP)
		return nil, &failure
	}
	raw, failure := readClaudeResponse(response, transportDirectHTTP, s.Config.RespectRetryAfter)
	if failure == nil || failure.StatusCode != http.StatusNotFound || !isAppendMessageNotFound(raw) {
		return raw, failure
	}

	response, err = s.startClaudeCompletionRequest(account, request)
	if err != nil {
		failure := networkFailure(err, transportDirectHTTP)
		return nil, &failure
	}
	return readClaudeResponse(response, transportDirectHTTP, s.Config.RespectRetryAfter)
}

func readClaudeResponse(response *http.Response, transport string, respectRetryAfter bool) ([]byte, *UpstreamFailure) {
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		failure := classifyUpstreamFailure(response.StatusCode, response.Header, raw, transport, respectRetryAfter)
		return raw, &failure
	}
	return raw, nil
}

func isAppendMessageNotFound(raw []byte) bool {
	body := strings.ToLower(strings.TrimSpace(string(raw)))
	return strings.Contains(body, "not_found_error") || strings.Contains(body, "not found")
}

func (s *Service) proxyClaudeStream(w http.ResponseWriter, response *http.Response, model, streamID string, created int64) (bool, error) {
	defer response.Body.Close()
	return s.proxyClaudeStreamReader(w, response.Body, model, streamID, created)
}

func (s *Service) proxyClaudeStreamReader(w http.ResponseWriter, reader io.Reader, model, streamID string, created int64) (bool, error) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return false, fmt.Errorf("response writer does not support streaming")
	}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
	started := false
	sentRole := false
	emitted := false
	ensure := func() {
		if started {
			return
		}
		w.Header().Set("content-type", "text/event-stream")
		w.Header().Set("cache-control", "no-cache")
		w.Header().Set("connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		started = true
	}
	send := func(role, content string, finish *string) error {
		ensure()
		chunk := claudeweb.BuildOpenAIStreamChunk(model, streamID, created, role, content, finish)
		data, err := json.Marshal(chunk)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		text, stop := claudeweb.ExtractClaudeStreamDelta([]byte(payload))
		if text != "" {
			if !sentRole {
				if err := send("assistant", "", nil); err != nil {
					return started, err
				}
				sentRole = true
			}
			if err := send("", text, nil); err != nil {
				return started, err
			}
			emitted = true
		}
		if stop {
			finish := "stop"
			if !sentRole {
				if err := send("assistant", "", nil); err != nil {
					return started, err
				}
				sentRole = true
			}
			if err := send("", "", &finish); err != nil {
				return started, err
			}
			_, err := io.WriteString(w, "data: [DONE]\n\n")
			flusher.Flush()
			return true, err
		}
	}
	if err := scanner.Err(); err != nil {
		return started, err
	}
	if !emitted {
		return started, fmt.Errorf("upstream stream produced no text")
	}
	finish := "stop"
	if err := send("", "", &finish); err != nil {
		return started, err
	}
	_, err := io.WriteString(w, "data: [DONE]\n\n")
	flusher.Flush()
	return true, err
}

func (s *Service) loadLastActiveOrg() (string, error) {
	exportPath := filepath.Join(filepath.Dir(s.RuntimePath), "claude-auth-export.json")
	data, err := os.ReadFile(exportPath)
	if err != nil {
		return "", fmt.Errorf("read auth export: %w", err)
	}
	var export claudeweb.ClaudeAuthExport
	if err := json.Unmarshal(data, &export); err != nil {
		return "", fmt.Errorf("parse auth export: %w", err)
	}
	for _, cookie := range export.Cookies {
		if cookie.Name == "lastActiveOrg" && cookie.Value != "" {
			return cookie.Value, nil
		}
	}
	return "", fmt.Errorf("lastActiveOrg cookie not found in auth export")
}

func networkFailure(err error, transport string) UpstreamFailure {
	return UpstreamFailure{StatusCode: http.StatusBadGateway, Kind: "network_error", Message: err.Error(), Transport: transport}
}

func classifyUpstreamFailure(status int, headers http.Header, raw []byte, transport string, respectRetryAfter bool) UpstreamFailure {
	body := truncate(raw)
	failure := UpstreamFailure{StatusCode: status, Kind: "upstream_4xx", Transport: transport}
	if respectRetryAfter {
		failure.RetryAfterDelay, failure.RetryAfterUntil = parseRetryAfter(headers.Get("Retry-After"))
	}
	switch status {
	case http.StatusUnauthorized:
		failure.Kind = "invalid_session"
		failure.Message = "sessionKey unauthorized: " + body
	case http.StatusForbidden:
		if isInvalidSessionPayload(body) {
			failure.Kind = "invalid_session"
			failure.Message = "invalid Claude session: " + body
		} else if isCloudflarePayload(body) {
			failure.Kind = "cloudflare_block"
			failure.Message = "cloudflare or risk control block: " + body
		} else {
			failure.Kind = "risk_control_block"
			failure.Message = "risk control block: " + body
		}
	case http.StatusTooManyRequests:
		failure.Kind = "rate_limited"
		failure.Message = "claude web rate limit: " + body
	default:
		if status >= 500 {
			failure.Kind = "upstream_5xx"
		}
		failure.Message = fmt.Sprintf("unexpected upstream status %d: %s", status, body)
	}
	return failure
}

func parseRetryAfter(value string) (time.Duration, string) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, ""
	}
	if sec, err := strconv.Atoi(value); err == nil {
		d := time.Duration(sec) * time.Second
		return d, time.Now().UTC().Add(d).Format(time.RFC3339)
	}
	if ts, err := http.ParseTime(value); err == nil {
		d := time.Until(ts.UTC())
		if d < 0 {
			d = 0
		}
		return d, ts.UTC().Format(time.RFC3339)
	}
	return 0, ""
}

func claudeBaseURL(cfg *config.GatewayConfig) string {
	if cfg != nil && strings.TrimSpace(cfg.UpstreamBaseURL) != "" {
		return strings.TrimRight(strings.TrimSpace(cfg.UpstreamBaseURL), "/")
	}
	if value := strings.TrimSpace(os.Getenv("CLAUDE_WEB_BASE_URL")); value != "" {
		return strings.TrimRight(value, "/")
	}
	return "https://claude.ai"
}

func isInvalidSessionPayload(message string) bool {
	lower := strings.ToLower(message)
	return strings.Contains(lower, "account_session_invalid") || strings.Contains(lower, "invalid authorization") || strings.Contains(lower, "session invalid")
}

func isCloudflarePayload(message string) bool {
	lower := strings.ToLower(message)
	markers := []string{"just a moment", "cf-mitigated", "cloudflare", "challenge", "captcha", "turnstile", "cf-ray", "attention required", "checking your browser"}
	for _, marker := range markers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func normalizeStatus(status int) int {
	if status == 0 {
		return http.StatusBadGateway
	}
	return status
}

func truncate(data []byte) string {
	text := strings.TrimSpace(string(data))
	if len(text) > 300 {
		return text[:300]
	}
	return text
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeOpenAIError(w http.ResponseWriter, status int, kind, message string) {
	writeJSON(w, status, map[string]interface{}{"error": map[string]interface{}{"message": message, "type": kind}})
}
