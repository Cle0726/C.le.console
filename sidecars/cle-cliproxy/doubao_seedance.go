package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/proxyutil"
)

const (
	doubaoSeedanceProvider       = "doubao-seedance"
	doubaoSeedanceDefaultBaseURL = "https://doubao.happieapi.top"
	doubaoSeedanceModel15        = "doubao-seedance-1.5-pro"
	doubaoSeedanceModel10Fast    = "doubao-seedance-1.0-pro-fast"
)

var doubaoSeedanceModels = map[string]string{
	doubaoSeedanceModel15:     "seedance-1-5-pro-251215",
	"seedance-1-5-pro-251215": "seedance-1-5-pro-251215",
	doubaoSeedanceModel10Fast: "seedance-1-0-pro-fast",
	"seedance-1-0-pro-fast":   "seedance-1-0-pro-fast",
}

var doubaoSeedancePublicModels = map[string]string{
	"seedance-1-5-pro-251215": doubaoSeedanceModel15,
	"seedance-1-0-pro-fast":   doubaoSeedanceModel10Fast,
}

type doubaoSeedanceAccountHealth struct {
	Until    time.Time
	Failures int
	Reason   string
}

type doubaoSeedanceTaskOwner struct {
	AccountID string
	Model     string
}

type doubaoSeedanceGateway struct {
	manifest *manifest

	mu         sync.Mutex
	cursor     int
	health     map[string]doubaoSeedanceAccountHealth
	taskOwners map[string]doubaoSeedanceTaskOwner
	clients    map[string]*http.Client
}

type doubaoSeedanceGenerationRequest struct {
	Model          string `json:"model"`
	Prompt         string `json:"prompt"`
	Duration       int    `json:"duration"`
	Seconds        int    `json:"seconds"`
	Radio          string `json:"radio"`
	Ratio          string `json:"ratio"`
	Size           string `json:"size"`
	Image          string `json:"image"`
	InputImage     string `json:"input_image"`
	InputReference string `json:"input_reference"`
}

func newDoubaoSeedanceGateway(m *manifest) *doubaoSeedanceGateway {
	return &doubaoSeedanceGateway{
		manifest:   m,
		health:     make(map[string]doubaoSeedanceAccountHealth),
		taskOwners: make(map[string]doubaoSeedanceTaskOwner),
		clients:    make(map[string]*http.Client),
	}
}

func (s *relayServer) doubaoSeedanceGateway() *doubaoSeedanceGateway {
	if s == nil {
		return nil
	}
	s.seedanceOnce.Do(func() {
		s.seedance = newDoubaoSeedanceGateway(s.manifest)
	})
	return s.seedance
}

func (s *relayServer) doubaoSeedanceTaskKnown(taskID string) bool {
	gateway := s.doubaoSeedanceGateway()
	return gateway != nil && gateway.taskKnown(taskID)
}

func isDoubaoSeedanceModel(model string) bool {
	_, ok := doubaoSeedanceModels[strings.ToLower(strings.TrimSpace(model))]
	return ok
}

func doubaoSeedanceModel(model string) (publicModel, upstreamModel string, ok bool) {
	upstreamModel, ok = doubaoSeedanceModels[strings.ToLower(strings.TrimSpace(model))]
	if !ok {
		return "", "", false
	}
	publicModel = doubaoSeedancePublicModels[upstreamModel]
	return publicModel, upstreamModel, true
}

func (s *relayServer) handleDoubaoSeedanceGeneration(c *gin.Context, spec *apiKeySpec, rawJSON []byte) {
	gateway := s.doubaoSeedanceGateway()
	if gateway == nil {
		writeAPIError(c, http.StatusServiceUnavailable, "Doubao Seedance gateway is unavailable", "upstream_unavailable")
		return
	}
	gateway.create(c, spec, rawJSON)
}

func (s *relayServer) handleDoubaoSeedanceStatus(c *gin.Context) {
	spec, ok := s.requireAPIKey(c)
	if !ok {
		return
	}
	gateway := s.doubaoSeedanceGateway()
	if gateway == nil {
		writeAPIError(c, http.StatusServiceUnavailable, "Doubao Seedance gateway is unavailable", "upstream_unavailable")
		return
	}
	gateway.status(c, spec, strings.TrimSpace(c.Param("video_id")))
}

func (g *doubaoSeedanceGateway) create(c *gin.Context, spec *apiKeySpec, rawJSON []byte) {
	var input doubaoSeedanceGenerationRequest
	if err := json.Unmarshal(rawJSON, &input); err != nil {
		writeAPIError(c, http.StatusBadRequest, "invalid JSON request body", "invalid_request")
		return
	}
	publicModel, upstreamModel, ok := doubaoSeedanceModel(input.Model)
	if !ok {
		writeAPIError(c, http.StatusBadRequest, "unsupported Doubao Seedance model", "model_not_supported")
		return
	}
	input.Prompt = strings.TrimSpace(input.Prompt)
	if input.Prompt == "" {
		writeAPIError(c, http.StatusBadRequest, "prompt is required", "invalid_request")
		return
	}
	duration := input.Duration
	if duration == 0 {
		duration = input.Seconds
	}
	if duration == 0 {
		duration = 5
	}
	if duration < 1 || duration > 12 {
		writeAPIError(c, http.StatusBadRequest, "duration/seconds must be between 1 and 12", "invalid_request")
		return
	}
	ratio, err := normalizeDoubaoSeedanceRatio(input.Radio, input.Ratio, input.Size)
	if err != nil {
		writeAPIError(c, http.StatusBadRequest, err.Error(), "invalid_request")
		return
	}
	image := firstNonEmptyString(input.Image, input.InputImage, input.InputReference)
	if image != "" {
		if parsed, parseErr := url.Parse(image); parseErr != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			writeAPIError(c, http.StatusBadRequest, "image/input_image/input_reference must be an http(s) URL", "invalid_request")
			return
		}
	}

	account, err := g.selectAccount(spec, publicModel, upstreamModel, "")
	if err != nil {
		writeAPIError(c, http.StatusServiceUnavailable, err.Error(), "auth_unavailable")
		return
	}
	payload := map[string]any{
		"model":    upstreamModel,
		"prompt":   input.Prompt,
		"duration": duration,
		"radio":    ratio,
	}
	if image != "" {
		payload["image"] = image
	}
	requestBody, _ := json.Marshal(payload)
	response, responseBody, err := g.doRequest(c.Request.Context(), account, http.MethodPost, "/api/video/create", requestBody)
	if err != nil {
		g.markFailure(account.ID, 0, err)
		writeAPIError(c, http.StatusBadGateway, "Doubao Seedance upstream connection failed; the generation request was not retried to avoid duplicate charges", "upstream_connection_error")
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 || isLoginRedirect(response) || looksLikeDoubaoLoginBody(responseBody) {
		if looksLikeDoubaoLoginBody(responseBody) && response.StatusCode >= 200 && response.StatusCode < 300 {
			response.StatusCode = http.StatusUnauthorized
		}
		g.markFailure(account.ID, response.StatusCode, errors.New(safeUpstreamMessage(responseBody)))
		status, code := mapDoubaoSeedanceUpstreamError(response.StatusCode)
		writeAPIError(c, status, fmt.Sprintf("Doubao Seedance upstream rejected the request (HTTP %d): %s; not retried to avoid duplicate charges", response.StatusCode, safeUpstreamMessage(responseBody)), code)
		return
	}

	var upstream any
	if err := json.Unmarshal(responseBody, &upstream); err != nil {
		g.markFailure(account.ID, 0, err)
		writeAPIError(c, http.StatusBadGateway, "Doubao Seedance upstream returned an invalid response; the request may have been submitted and was not retried", "invalid_upstream_response")
		return
	}
	if message, failed := doubaoSeedanceResponseFailure(upstream); failed {
		g.markFailure(account.ID, 0, errors.New(message))
		writeAPIError(c, http.StatusBadGateway, "Doubao Seedance upstream rejected the request: "+message+"; not retried to avoid duplicate charges", "upstream_error")
		return
	}
	taskID := findStringFieldRecursive(upstream, "taskId", "task_id", "id")
	if taskID == "" {
		g.markFailure(account.ID, 0, errors.New("missing task ID"))
		writeAPIError(c, http.StatusBadGateway, "Doubao Seedance task may have been submitted but no task ID was returned; not retried to avoid duplicate charges", "missing_task_id")
		return
	}
	g.markSuccess(account.ID)
	g.rememberTask(taskID, account.ID, publicModel)
	c.JSON(http.StatusOK, gin.H{
		"id":         taskID,
		"object":     "video.generation",
		"created":    time.Now().Unix(),
		"status":     "queued",
		"model":      publicModel,
		"seconds":    duration,
		"size":       ratio,
		"provider":   doubaoSeedanceProvider,
		"account_id": account.ID,
		"upstream":   upstream,
	})
}

func (g *doubaoSeedanceGateway) status(c *gin.Context, spec *apiKeySpec, taskID string) {
	if taskID == "" {
		writeAPIError(c, http.StatusBadRequest, "video_id is required", "invalid_request")
		return
	}
	owner, ownerKnown := g.taskOwner(taskID)
	ownerID := ""
	model := ""
	if ownerKnown {
		ownerID = owner.AccountID
		model = owner.Model
	}
	accounts := g.accounts(spec, model, "", ownerID, true)
	if len(accounts) == 0 {
		writeAPIError(c, http.StatusServiceUnavailable, "no available Doubao Seedance account can query this task", "auth_unavailable")
		return
	}

	var lastErr string
	for _, account := range accounts {
		response, responseBody, err := g.doRequest(c.Request.Context(), account, http.MethodGet, "/api/videos", nil)
		if err != nil {
			g.markFailure(account.ID, 0, err)
			lastErr = "upstream connection failed"
			continue
		}
		response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 || isLoginRedirect(response) || looksLikeDoubaoLoginBody(responseBody) {
			if looksLikeDoubaoLoginBody(responseBody) && response.StatusCode >= 200 && response.StatusCode < 300 {
				response.StatusCode = http.StatusUnauthorized
			}
			g.markFailure(account.ID, response.StatusCode, errors.New(safeUpstreamMessage(responseBody)))
			lastErr = fmt.Sprintf("upstream returned HTTP %d", response.StatusCode)
			continue
		}
		var upstream any
		if err := json.Unmarshal(responseBody, &upstream); err != nil {
			g.markFailure(account.ID, 0, err)
			lastErr = "upstream returned invalid JSON"
			continue
		}
		g.markSuccess(account.ID)
		video := findDoubaoSeedanceVideo(upstream, taskID)
		if video == nil {
			if ownerKnown {
				writeAPIError(c, http.StatusNotFound, "Doubao Seedance video task was not found in its owning account", "video_not_found")
				return
			}
			continue
		}
		if model == "" {
			if upstreamModel := findStringFieldRecursive(video, "model"); upstreamModel != "" {
				model = doubaoSeedancePublicModels[strings.ToLower(upstreamModel)]
			}
		}
		status := normalizeDoubaoSeedanceStatus(findStringFieldRecursive(video, "status", "state"))
		videoURL := findStringFieldRecursive(video, "videoUrl", "video_url", "url")
		result := gin.H{
			"id":         taskID,
			"object":     "video.generation",
			"status":     status,
			"provider":   doubaoSeedanceProvider,
			"account_id": account.ID,
			"data":       video,
		}
		if model != "" {
			result["model"] = model
		}
		if videoURL != "" {
			result["url"] = videoURL
			result["video_url"] = videoURL
		}
		c.JSON(http.StatusOK, result)
		return
	}
	if lastErr != "" {
		writeAPIError(c, http.StatusBadGateway, "Doubao Seedance status query failed: "+lastErr, "upstream_unavailable")
		return
	}
	writeAPIError(c, http.StatusNotFound, "Doubao Seedance video task was not found", "video_not_found")
}

func (g *doubaoSeedanceGateway) selectAccount(spec *apiKeySpec, publicModel, upstreamModel, ownerID string) (*accountSpec, error) {
	accounts := g.accounts(spec, publicModel, upstreamModel, ownerID, false)
	if len(accounts) == 0 {
		return nil, errors.New("no usable Doubao Seedance account is configured; add a connect.sid credential in the multi-model account pool")
	}
	g.mu.Lock()
	index := g.cursor % len(accounts)
	g.cursor = (g.cursor + 1) % len(accounts)
	g.mu.Unlock()
	return accounts[index], nil
}

func (g *doubaoSeedanceGateway) accounts(spec *apiKeySpec, publicModel, upstreamModel, ownerID string, includeCoolingOwner bool) []*accountSpec {
	if g == nil || g.manifest == nil {
		return nil
	}
	allowed := scopedAccountIDs(spec)
	now := time.Now()
	accounts := make([]*accountSpec, 0)
	for i := range g.manifest.Accounts {
		account := &g.manifest.Accounts[i]
		if !strings.EqualFold(strings.TrimSpace(account.Provider), doubaoSeedanceProvider) || normalizeConnectSID(account.UpstreamAPIKey) == "" {
			continue
		}
		if ownerID != "" && !strings.EqualFold(account.ID, ownerID) {
			continue
		}
		if len(allowed) > 0 && !accountAllowedByScope(account, allowed) {
			continue
		}
		if len(account.Models) > 0 && publicModel != "" && !stringSliceContainsFold(account.Models, publicModel) && !stringSliceContainsFold(account.Models, upstreamModel) {
			continue
		}
		g.mu.Lock()
		health := g.health[account.ID]
		g.mu.Unlock()
		if now.Before(health.Until) && !(includeCoolingOwner && ownerID != "") {
			continue
		}
		accounts = append(accounts, account)
	}
	sort.SliceStable(accounts, func(i, j int) bool {
		return accounts[i].Priority > accounts[j].Priority
	})
	return accounts
}

func scopedAccountIDs(spec *apiKeySpec) map[string]struct{} {
	if spec == nil || len(spec.AccountIDs) == 0 {
		return nil
	}
	allowed := make(map[string]struct{}, len(spec.AccountIDs))
	for _, id := range spec.AccountIDs {
		if id = strings.ToLower(strings.TrimSpace(id)); id != "" {
			allowed[id] = struct{}{}
		}
	}
	return allowed
}

func accountAllowedByScope(account *accountSpec, allowed map[string]struct{}) bool {
	if account == nil || len(allowed) == 0 {
		return true
	}
	_, idAllowed := allowed[strings.ToLower(strings.TrimSpace(account.ID))]
	_, authAllowed := allowed[strings.ToLower(strings.TrimSpace(account.AuthID))]
	return idAllowed || authAllowed
}

func (g *doubaoSeedanceGateway) clientFor(account *accountSpec) (*http.Client, error) {
	proxyURL := ""
	if account != nil {
		proxyURL = strings.TrimSpace(account.ProxyURL)
	}
	g.mu.Lock()
	if client := g.clients[proxyURL]; client != nil {
		g.mu.Unlock()
		return client, nil
	}
	g.mu.Unlock()

	var transport http.RoundTripper = http.DefaultTransport
	if proxyURL != "" {
		built, _, err := proxyutil.BuildHTTPTransport(proxyURL)
		if err != nil {
			return nil, fmt.Errorf("invalid account proxy: %w", err)
		}
		if built != nil {
			transport = built
		}
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   120 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	g.mu.Lock()
	if existing := g.clients[proxyURL]; existing != nil {
		g.mu.Unlock()
		return existing, nil
	}
	g.clients[proxyURL] = client
	g.mu.Unlock()
	return client, nil
}

func (g *doubaoSeedanceGateway) doRequest(ctx context.Context, account *accountSpec, method, path string, body []byte) (*http.Response, []byte, error) {
	if account == nil {
		return nil, nil, errors.New("missing account")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(account.BaseURL), "/")
	if baseURL == "" {
		baseURL = doubaoSeedanceDefaultBaseURL
	}
	parsedBase, err := url.Parse(baseURL)
	if err != nil || (parsedBase.Scheme != "http" && parsedBase.Scheme != "https") || parsedBase.Host == "" {
		return nil, nil, errors.New("invalid Doubao Seedance Base URL")
	}
	request, err := http.NewRequestWithContext(ctx, method, baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	request.Header.Set("Accept", "application/json, text/plain, */*")
	request.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.7")
	request.Header.Set("Cache-Control", "no-cache")
	request.Header.Set("Origin", baseURL)
	request.Header.Set("Pragma", "no-cache")
	request.Header.Set("Referer", baseURL+"/")
	request.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36")
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, value := range account.Headers {
		if doubaoSeedanceCustomHeaderAllowed(name) {
			request.Header.Set(name, value)
		}
	}
	request.Header.Set("Cookie", "connect.sid="+normalizeConnectSID(account.UpstreamAPIKey))
	client, err := g.clientFor(account)
	if err != nil {
		return nil, nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, nil, err
	}
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024))
	if err != nil {
		response.Body.Close()
		return nil, nil, err
	}
	response.Body.Close()
	response.Body = io.NopCloser(bytes.NewReader(responseBody))
	return response, responseBody, nil
}

func doubaoSeedanceCustomHeaderAllowed(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "accept", "accept-language", "cache-control", "origin", "pragma", "referer", "user-agent", "x-requested-with":
		return true
	default:
		return false
	}
}

func normalizeConnectSID(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(strings.ToLower(raw), "cookie:") {
		raw = strings.TrimSpace(raw[len("cookie:"):])
	}
	for _, part := range strings.Split(raw, ";") {
		part = strings.TrimSpace(part)
		if name, value, ok := strings.Cut(part, "="); ok && strings.EqualFold(strings.TrimSpace(name), "connect.sid") {
			return strings.TrimSpace(value)
		}
	}
	if strings.HasPrefix(strings.ToLower(raw), "connect.sid=") {
		return strings.TrimSpace(raw[len("connect.sid="):])
	}
	return raw
}

func normalizeDoubaoSeedanceRatio(values ...string) (string, error) {
	ratio := ""
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			ratio = value
			break
		}
	}
	if ratio == "" {
		return "16:9", nil
	}
	sizeRatios := map[string]string{
		"1792x768":  "21:9",
		"1920x1080": "16:9",
		"1280x720":  "16:9",
		"1024x768":  "4:3",
		"1024x1024": "1:1",
		"768x1024":  "3:4",
		"1080x1920": "9:16",
		"720x1280":  "9:16",
	}
	if mapped := sizeRatios[strings.ToLower(ratio)]; mapped != "" {
		ratio = mapped
	}
	switch ratio {
	case "21:9", "16:9", "4:3", "1:1", "3:4", "9:16":
		return ratio, nil
	default:
		return "", errors.New("ratio/radio/size must be one of 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 or a supported pixel size")
	}
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func isLoginRedirect(response *http.Response) bool {
	if response == nil {
		return false
	}
	location := strings.ToLower(response.Header.Get("Location"))
	return strings.Contains(location, "/login") || (response.Request != nil && response.Request.URL != nil && strings.Contains(strings.ToLower(response.Request.URL.Path), "/login"))
}

func looksLikeDoubaoLoginBody(body []byte) bool {
	text := strings.ToLower(strings.TrimSpace(string(body)))
	if text == "" {
		return false
	}
	return strings.Contains(text, "<html") && (strings.Contains(text, "/login") || strings.Contains(text, "sign in") || strings.Contains(text, "登录"))
}

func doubaoSeedanceResponseFailure(value any) (string, bool) {
	payload, ok := value.(map[string]any)
	if !ok {
		return "", false
	}
	for _, key := range []string{"success", "ok"} {
		if flag, exists := payload[key]; exists {
			if value, isBool := flag.(bool); isBool && !value {
				message := findStringFieldRecursive(payload, "message", "error", "detail")
				if message == "" {
					message = "upstream reported failure"
				}
				return message, true
			}
		}
	}
	return "", false
}

func mapDoubaoSeedanceUpstreamError(status int) (int, string) {
	switch status {
	case http.StatusTooManyRequests:
		return http.StatusTooManyRequests, "rate_limit_exceeded"
	case http.StatusUnauthorized, http.StatusForbidden:
		return http.StatusBadGateway, "upstream_auth_error"
	default:
		return http.StatusBadGateway, "upstream_error"
	}
}

func safeUpstreamMessage(body []byte) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return "empty response"
	}
	if len(text) > 1024 {
		text = text[:1024]
	}
	return strings.ReplaceAll(strings.ReplaceAll(text, "\r", " "), "\n", " ")
}

func (g *doubaoSeedanceGateway) markFailure(accountID string, status int, cause error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	health := g.health[accountID]
	health.Failures++
	delay := time.Duration(1<<minInt(health.Failures-1, 5)) * 2 * time.Second
	if delay > time.Minute {
		delay = time.Minute
	}
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		delay = 10 * time.Minute
	case http.StatusTooManyRequests:
		delay = 2 * time.Minute
	}
	health.Until = time.Now().Add(delay)
	if cause != nil {
		health.Reason = cause.Error()
	}
	g.health[accountID] = health
}

func (g *doubaoSeedanceGateway) markSuccess(accountID string) {
	g.mu.Lock()
	delete(g.health, accountID)
	g.mu.Unlock()
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (g *doubaoSeedanceGateway) rememberTask(taskID, accountID, model string) {
	g.mu.Lock()
	g.taskOwners[strings.TrimSpace(taskID)] = doubaoSeedanceTaskOwner{AccountID: accountID, Model: model}
	g.mu.Unlock()
}

func (g *doubaoSeedanceGateway) taskOwner(taskID string) (doubaoSeedanceTaskOwner, bool) {
	g.mu.Lock()
	owner, ok := g.taskOwners[strings.TrimSpace(taskID)]
	g.mu.Unlock()
	return owner, ok
}

func (g *doubaoSeedanceGateway) taskKnown(taskID string) bool {
	_, ok := g.taskOwner(taskID)
	return ok
}

func findStringFieldRecursive(value any, keys ...string) string {
	keySet := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		keySet[strings.ToLower(key)] = struct{}{}
	}
	var walk func(any) string
	walk = func(current any) string {
		switch typed := current.(type) {
		case map[string]any:
			for key, item := range typed {
				if _, ok := keySet[strings.ToLower(key)]; ok {
					switch value := item.(type) {
					case string:
						if value = strings.TrimSpace(value); value != "" {
							return value
						}
					case json.Number:
						return value.String()
					case float64:
						return strconv.FormatFloat(value, 'f', -1, 64)
					}
				}
			}
			for _, item := range typed {
				if value := walk(item); value != "" {
					return value
				}
			}
		case []any:
			for _, item := range typed {
				if value := walk(item); value != "" {
					return value
				}
			}
		}
		return ""
	}
	return walk(value)
}

func findDoubaoSeedanceVideo(value any, taskID string) map[string]any {
	taskID = strings.TrimSpace(taskID)
	var walk func(any) map[string]any
	walk = func(current any) map[string]any {
		switch typed := current.(type) {
		case map[string]any:
			for _, key := range []string{"taskId", "task_id", "id"} {
				if candidate, ok := typed[key]; ok && strings.EqualFold(strings.TrimSpace(fmt.Sprint(candidate)), taskID) {
					return typed
				}
			}
			for _, key := range []string{"items", "data", "videos", "results", "result"} {
				if nested, ok := typed[key]; ok {
					if match := walk(nested); match != nil {
						return match
					}
				}
			}
		case []any:
			for _, item := range typed {
				if match := walk(item); match != nil {
					return match
				}
			}
		}
		return nil
	}
	return walk(value)
}

func normalizeDoubaoSeedanceStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed", "complete", "success", "succeeded", "done", "finished":
		return "completed"
	case "failed", "error", "cancelled", "canceled":
		return "failed"
	case "processing", "running", "generating", "in_progress", "in-progress":
		return "in_progress"
	case "pending", "queued", "waiting", "created", "":
		return "queued"
	default:
		return strings.ToLower(strings.TrimSpace(status))
	}
}
