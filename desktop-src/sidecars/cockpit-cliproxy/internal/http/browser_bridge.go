package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"claude-web-gateway-sidecar/internal/claudeweb"
	"claude-web-gateway-sidecar/internal/config"
)

type browserBridgeClient struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

type browserBridgeCompletionRequest struct {
	OrganizationID       string                 `json:"organizationId"`
	ConversationID       string                 `json:"conversationId"`
	Payload              map[string]interface{} `json:"payload"`
	AppendMessagePayload map[string]interface{} `json:"appendMessagePayload,omitempty"`
}

type browserBridgeResponseHeaders struct {
	ContentType string `json:"contentType,omitempty"`
	RetryAfter  string `json:"retryAfter,omitempty"`
}

type browserBridgeCompletionResponse struct {
	Status  int                          `json:"status"`
	Headers browserBridgeResponseHeaders `json:"headers"`
	Body    string                       `json:"body"`
}

func newBrowserBridgeClient(cfg *config.GatewayConfig) *browserBridgeClient {
	if cfg == nil {
		return nil
	}
	baseURL := strings.TrimRight(strings.TrimSpace(cfg.BrowserBridgeURL), "/")
	token := strings.TrimSpace(cfg.BrowserBridgeToken)
	if baseURL == "" || token == "" {
		return nil
	}
	client, err := claudeweb.NewHTTPClient("")
	if err != nil {
		return nil
	}
	return &browserBridgeClient{
		baseURL:    baseURL,
		token:      token,
		httpClient: client,
	}
}

func (c *browserBridgeClient) available() bool {
	return c != nil && c.baseURL != "" && c.token != "" && c.httpClient != nil
}

func (c *browserBridgeClient) executeCompletion(request claudeweb.ChatCompletionRequest, organizationID string) (*browserBridgeCompletionResponse, error) {
	if !c.available() {
		return nil, fmt.Errorf("browser bridge is not available")
	}
	conversationID, payload := claudeweb.BuildClaudeCompletionPayload(request, organizationID)
	_, appendPayload := claudeweb.BuildClaudeAppendMessagePayload(request, organizationID)
	route := "/append-message"
	requestBody := browserBridgeCompletionRequest{
		OrganizationID:       organizationID,
		ConversationID:       conversationID,
		Payload:              payload,
		AppendMessagePayload: appendPayload,
	}
	if requestContainsCJK(request) || looksLikeEncodingSensitiveRequest(request) {
		route = "/composer-chat"
		requestBody = browserBridgeCompletionRequest{OrganizationID: organizationID, ConversationID: conversationID}
		requestBody.Payload = map[string]interface{}{"text": claudeweb.BuildPrompt(request.Messages)}
	}
	body, err := json.Marshal(requestBody)
	if err != nil {
		return nil, err
	}
	httpRequest, err := http.NewRequest(http.MethodPost, c.baseURL+route, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpRequest.Header.Set("content-type", "application/json")
	httpRequest.Header.Set("accept", "application/json")
	httpRequest.Header.Set("authorization", "Bearer "+c.token)
	response, err := c.httpClient.Do(httpRequest)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var decoded browserBridgeCompletionResponse
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		return nil, err
	}
	if decoded.Status == 0 {
		decoded.Status = http.StatusBadGateway
	}
	return &decoded, nil
}

func (r *browserBridgeCompletionResponse) httpHeader() http.Header {
	header := http.Header{}
	if r == nil {
		return header
	}
	if strings.TrimSpace(r.Headers.ContentType) != "" {
		header.Set("Content-Type", strings.TrimSpace(r.Headers.ContentType))
	}
	if strings.TrimSpace(r.Headers.RetryAfter) != "" {
		header.Set("Retry-After", strings.TrimSpace(r.Headers.RetryAfter))
	}
	return header
}

func helperUnavailableFailure(message string) UpstreamFailure {
	message = strings.TrimSpace(message)
	if message == "" {
		message = "browser bridge is not available"
	}
	return UpstreamFailure{
		StatusCode: http.StatusServiceUnavailable,
		Kind:       "helper_unavailable",
		Message:    message,
		Transport:  transportBrowserBridge,
	}
}

func browserBridgeSuccessRetryAfter() time.Duration {
	return 0
}
