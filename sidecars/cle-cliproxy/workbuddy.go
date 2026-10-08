package main

// WorkBuddy wire normalization is adapted from workbuddy2api-hub (MIT) and
// workbuddy-connect-api (MIT). See WORKBUDDY-NOTICE.md. CLIProxyAPI retains
// ownership of protocol translation, account selection, retries and usage.
import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	runtimeexecutor "github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

const workbuddyCredentialHeader = "X-Cle-Workbuddy-Credential-URL"

type workbuddyExecutor struct {
	*runtimeexecutor.OpenAICompatExecutor
	transports *sidecarRoundTripperProvider
	proxy      string
}

func newWorkbuddyExecutor(cfg *config.Config) *workbuddyExecutor {
	copy := *cfg
	copy.ProxyURL = "" // The adapter owns the remote transport; the credential hop is always direct.
	return &workbuddyExecutor{OpenAICompatExecutor: runtimeexecutor.NewOpenAICompatExecutor("workbuddy", &copy),
		transports: newSidecarRoundTripperProvider(), proxy: cfg.ProxyURL}
}

func (e *workbuddyExecutor) prepare(ctx context.Context, auth *coreauth.Auth) (context.Context, *coreauth.Auth) {
	copy := auth.Clone()
	if copy.ProxyURL == "" {
		copy.ProxyURL = e.proxy
	}
	base := e.transports.RoundTripperFor(copy)
	if base == nil {
		base = http.DefaultTransport
	}
	copy.ProxyURL = ""
	return context.WithValue(ctx, "cliproxy.roundtripper", &workbuddyRoundTripper{base: base}), copy
}

func (e *workbuddyExecutor) Execute(ctx context.Context, auth *coreauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	ctx, auth = e.prepare(ctx, auth)
	return e.OpenAICompatExecutor.Execute(ctx, auth, req, opts)
}

func (e *workbuddyExecutor) ExecuteStream(ctx context.Context, auth *coreauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	ctx, auth = e.prepare(ctx, auth)
	return e.OpenAICompatExecutor.ExecuteStream(ctx, auth, req, opts)
}

type workbuddyRoundTripper struct{ base http.RoundTripper }
type workbuddyCredential struct {
	Headers map[string]string `json:"headers"`
	BaseURL string            `json:"baseUrl"`
}

func workbuddyCurrentCredential(ctx context.Context, endpoint, key string, refresh bool) (*workbuddyCredential, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || !strings.HasPrefix(parsed.Path, "/credentials/") {
		return nil, fmt.Errorf("invalid WorkBuddy credential bridge")
	}
	if refresh {
		parsed.RawQuery = "refresh=1"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", key)
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 40 * time.Second}
	defer client.CloseIdleConnections()
	response, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("WorkBuddy 凭证管理连接失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("WorkBuddy 登录不可用，请在 C.le 账号页刷新或重新登录")
	}
	var credential workbuddyCredential
	err = json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&credential)
	if err != nil || credential.Headers["Authorization"] == "" {
		return nil, fmt.Errorf("WorkBuddy 缺少有效凭证")
	}
	return &credential, nil
}

func (t *workbuddyRoundTripper) RoundTrip(original *http.Request) (*http.Response, error) {
	if original.URL.Path != "/v2/chat/completions" {
		return workbuddyErrorResponse(original, http.StatusBadRequest, "WorkBuddy 当前只支持对话模型接口"), nil
	}
	raw, err := io.ReadAll(io.LimitReader(original.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	_ = original.Body.Close()
	body, streaming, err := prepareWorkbuddyBody(raw)
	if err != nil {
		return workbuddyErrorResponse(original, http.StatusBadRequest, err.Error()), nil
	}
	endpoint := original.Header.Get(workbuddyCredentialHeader)
	key := original.Header.Get("Authorization")
attempts:
	for attempt := 0; attempt < 2; attempt++ {
		credential, err := workbuddyCurrentCredential(original.Context(), endpoint, key, attempt > 0)
		if err != nil {
			return workbuddyErrorResponse(original, http.StatusUnauthorized, err.Error()), nil
		}
		request := original.Clone(original.Context())
		request.Header = make(http.Header)
		for name, value := range credential.Headers {
			request.Header.Set(name, value)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Request-ID", uuid.NewString())
		request.Body = io.NopCloser(bytes.NewReader(body))
		request.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
		request.ContentLength = int64(len(body))
		// The base URL comes from C.le's managed account, never from API clients.
		base, err := url.Parse(credential.BaseURL)
		if err != nil || base.Scheme != "https" || !(base.Host == "copilot.tencent.com" || base.Host == "www.workbuddy.ai") {
			return nil, fmt.Errorf("invalid WorkBuddy upstream")
		}
		request.URL.Scheme, request.URL.Host, request.Host = base.Scheme, base.Host, base.Host
		response, err := t.base.RoundTrip(request)
		if err != nil {
			return nil, err
		}
		if response.StatusCode == 401 && attempt == 0 {
			_ = response.Body.Close()
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return response, nil
		}
		if !strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
			payload, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
			_ = response.Body.Close()
			if readErr != nil {
				return nil, readErr
			}
			status, message := workbuddyBusinessError(payload)
			if status == 401 && attempt == 0 {
				continue
			}
			if status == 0 {
				status, message = http.StatusBadGateway, "WorkBuddy 未返回有效对话流"
			}
			return workbuddyErrorResponse(original, status, message), nil
		}
		reader := bufio.NewReader(response.Body)
		var prefix bytes.Buffer
		for prefix.Len() < 1<<20 {
			line, readErr := reader.ReadString('\n')
			prefix.WriteString(line)
			data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if strings.HasPrefix(line, "data:") && data != "[DONE]" {
				if status, message := workbuddyBusinessError([]byte(data)); status != 0 {
					_ = response.Body.Close()
					if status == 401 && attempt == 0 {
						continue attempts
					}
					return workbuddyErrorResponse(original, status, message), nil
				}
				break
			}
			if readErr != nil {
				break
			}
		}
		// A stream may begin with heartbeats or fail after its first valid chunk.
		// Do not let the native translator turn a truncated stream into success.
		response.Body = &workbuddyStreamBody{Reader: &workbuddyValidatedReader{reader: bufio.NewReader(io.MultiReader(bytes.NewReader(prefix.Bytes()), reader))}, closer: response.Body}
		if streaming {
			return response, nil
		}
		completion, err := aggregateWorkbuddyCompletion(response.Body)
		_ = response.Body.Close()
		if err != nil {
			return workbuddyErrorResponse(original, http.StatusBadGateway, err.Error()), nil
		}
		response.Body = io.NopCloser(bytes.NewReader(completion))
		response.ContentLength = int64(len(completion))
		response.Header.Set("Content-Type", "application/json")
		response.Header.Set("Content-Length", fmt.Sprint(len(completion)))
		return response, nil
	}
	return workbuddyErrorResponse(original, http.StatusUnauthorized, "WorkBuddy 登录已失效"), nil
}

type workbuddyStreamBody struct {
	io.Reader
	closer io.Closer
}

func (r *workbuddyStreamBody) Close() error { return r.closer.Close() }

type workbuddyValidatedReader struct {
	reader   *bufio.Reader
	pending  []byte
	terminal bool
	err      error
}

func (r *workbuddyValidatedReader) Read(dst []byte) (int, error) {
	if len(dst) == 0 {
		return 0, nil
	}
	if len(r.pending) == 0 && r.err == nil {
		line, err := r.reader.ReadString('\n')
		if strings.HasPrefix(strings.TrimSpace(line), "data:") {
			data := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "data:"))
			if data == "[DONE]" {
				if !r.terminal {
					return 0, fmt.Errorf("WorkBuddy 对话流未完整结束")
				}
			} else {
				if status, message := workbuddyBusinessError([]byte(data)); status != 0 {
					return 0, fmt.Errorf("WorkBuddy HTTP %d: %s", status, message)
				}
				var chunk struct {
					Choices []struct {
						FinishReason string `json:"finish_reason"`
					} `json:"choices"`
				}
				if json.Unmarshal([]byte(data), &chunk) == nil {
					for _, choice := range chunk.Choices {
						if choice.FinishReason != "" {
							r.terminal = true
						}
					}
				}
			}
		}
		r.pending = []byte(line)
		if err != nil {
			if err == io.EOF && !r.terminal {
				err = io.ErrUnexpectedEOF
			}
			r.err = err
		}
	}
	n := copy(dst, r.pending)
	r.pending = r.pending[n:]
	if len(r.pending) == 0 {
		return n, r.err
	}
	return n, nil
}

func prepareWorkbuddyBody(raw []byte) ([]byte, bool, error) {
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil || body == nil {
		return nil, false, fmt.Errorf("invalid chat body")
	}
	streaming, _ := body["stream"].(bool)
	if model, ok := body["model"].(string); ok {
		body["model"] = strings.TrimPrefix(model, "workbuddy/")
	}
	messages, _ := body["messages"].([]any)
	if len(messages) == 0 {
		return nil, false, fmt.Errorf("messages cannot be empty")
	}
	for _, item := range messages {
		if message, ok := item.(map[string]any); ok && message["role"] == "developer" {
			message["role"] = "system"
		}
	}
	first, _ := messages[0].(map[string]any)
	if first["role"] != "system" {
		messages = append([]any{map[string]any{"role": "system", "content": "You are a helpful assistant."}}, messages...)
	}
	body["messages"], body["stream"] = messages, true
	body["stream_options"] = map[string]any{"include_usage": true}
	if tokens, ok := body["max_completion_tokens"]; ok {
		if _, exists := body["max_tokens"]; !exists {
			body["max_tokens"] = tokens
		}
		delete(body, "max_completion_tokens")
	}
	if choice, ok := body["tool_choice"].(map[string]any); ok {
		if choice["type"] == "function" {
			function, _ := choice["function"].(map[string]any)
			body["tool_choice"] = function["name"]
		} else {
			body["tool_choice"] = choice["type"]
		}
	}
	if body["tool_choice"] == "none" {
		delete(body, "tools")
		delete(body, "functions")
		delete(body, "tool_choice")
	}
	for _, item := range messages {
		if message, ok := item.(map[string]any); ok && message["role"] == "assistant" && strings.HasPrefix(fmt.Sprint(body["model"]), "deepseek") {
			if _, exists := message["reasoning_content"]; !exists {
				message["reasoning_content"] = ""
			}
		}
	}
	encoded, err := json.Marshal(body)
	return encoded, streaming, err
}

func workbuddyBusinessError(raw []byte) (int, string) {
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		return 0, ""
	}
	code, exists := payload["code"]
	_, errorExists := payload["error"]
	if !errorExists && (!exists || fmt.Sprint(code) == "0" || fmt.Sprint(code) == "200") {
		return 0, ""
	}
	message := firstStringField(payload, "message", "msg")
	if errorExists {
		if e, ok := payload["error"].(map[string]any); ok {
			message = firstStringField(e, "message", "msg")
		}
	}
	if message == "" {
		message = fmt.Sprintf("WorkBuddy upstream error %v", code)
	}
	lower := strings.ToLower(message)
	status := http.StatusBadGateway
	if strings.Contains(lower, "credit") || strings.Contains(message, "积分不足") || strings.Contains(message, "额度不足") || strings.Contains(lower, "quota") {
		status = http.StatusPaymentRequired
	} else if strings.Contains(lower, "session") || strings.Contains(lower, "token") || fmt.Sprint(code) == "12153" {
		status = http.StatusUnauthorized
	} else if strings.Contains(lower, "rate") || fmt.Sprint(code) == "6004" {
		status = http.StatusTooManyRequests
	} else if fmt.Sprint(code) == "11128" || strings.Contains(lower, "unapproved channel") {
		status = http.StatusForbidden
	}
	return status, message
}

func workbuddyErrorResponse(req *http.Request, status int, message string) *http.Response {
	raw, _ := json.Marshal(map[string]any{"error": map[string]any{"message": message, "type": "workbuddy_error"}})
	return &http.Response{StatusCode: status, Status: http.StatusText(status), Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(bytes.NewReader(raw)), ContentLength: int64(len(raw)), Request: req}
}

// SSE aggregation follows workbuddy-connect-api/nonstream.ts; terminal chunks
// are required here so truncated streams are not reported as complete answers.
func aggregateWorkbuddyCompletion(source io.Reader) ([]byte, error) {
	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 4096), 4<<20)
	var content, reasoning strings.Builder
	metadata := map[string]any{}
	seen := false
	var usage any
	tools := map[int]map[string]any{}
	finish := ""
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk map[string]any
		if json.Unmarshal([]byte(data), &chunk) != nil {
			continue
		}
		if status, message := workbuddyBusinessError([]byte(data)); status != 0 {
			return nil, fmt.Errorf("%s", message)
		}
		seen = true
		for _, key := range []string{"id", "model", "created"} {
			if value := chunk[key]; value != nil {
				metadata[key] = value
			}
		}
		if value := chunk["usage"]; value != nil {
			usage = value
		}
		choices, _ := chunk["choices"].([]any)
		for _, raw := range choices {
			choice, _ := raw.(map[string]any)
			if value, ok := choice["finish_reason"].(string); ok && value != "" {
				finish = value
			}
			delta, _ := choice["delta"].(map[string]any)
			if text, ok := delta["content"].(string); ok {
				content.WriteString(text)
			}
			if text, ok := delta["reasoning_content"].(string); ok {
				reasoning.WriteString(text)
			}
			calls, _ := delta["tool_calls"].([]any)
			for position, raw := range calls {
				call, _ := raw.(map[string]any)
				index := position
				if n, ok := call["index"].(float64); ok {
					index = int(n)
				}
				merged := tools[index]
				if merged == nil {
					merged = map[string]any{"type": "function", "function": map[string]any{"name": "", "arguments": ""}}
					tools[index] = merged
				}
				if id, ok := call["id"].(string); ok && id != "" {
					merged["id"] = id
				}
				function, _ := call["function"].(map[string]any)
				target := merged["function"].(map[string]any)
				if name, ok := function["name"].(string); ok && name != "" {
					target["name"] = name
				}
				if args, ok := function["arguments"].(string); ok {
					target["arguments"] = target["arguments"].(string) + args
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if finish == "" || !seen {
		return nil, fmt.Errorf("WorkBuddy 对话流未完整结束，请检查调用记录")
	}
	message := map[string]any{"role": "assistant", "content": content.String()}
	if reasoning.Len() > 0 {
		message["reasoning_content"] = reasoning.String()
	}
	if len(tools) > 0 {
		indices := make([]int, 0, len(tools))
		for i := range tools {
			indices = append(indices, i)
		}
		sort.Ints(indices)
		calls := make([]any, 0, len(tools))
		for _, i := range indices {
			calls = append(calls, tools[i])
		}
		message["tool_calls"] = calls
	}
	result := map[string]any{"id": metadata["id"], "model": metadata["model"], "created": metadata["created"], "object": "chat.completion", "choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}}}
	if usage != nil {
		result["usage"] = usage
	}
	return json.Marshal(result)
}
