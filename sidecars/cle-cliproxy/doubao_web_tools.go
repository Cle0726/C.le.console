package main

// OpenAI Chat Completions on top of Doubao web chat, including tool calls.
// Doubao's web chat has no function-calling API, so the tool list goes into the
// prompt with a strict reply format, and calls written in that format are
// turned back into OpenAI tool_calls. Tool results in the history are rendered
// as text. This is C.le's own implementation.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	internallogging "github.com/router-for-me/CLIProxyAPI/v8/internal/logging"
)

const (
	doubaoWebPromptMaxSize = 400 * 1024
	doubaoWebTimeout       = 8 * time.Minute
	// Doubao's web page drops unknown HTML-like tags such as <tool_call>, so calls
	// are written as fenced code blocks tagged tool_call, which survive as text.
	doubaoWebCallFence = "```tool_call"
	doubaoWebTagOpen   = "<tool_call>"
	doubaoWebTagClose  = "</tool_call>"
)

var doubaoWebCursor atomic.Uint64

type doubaoWebTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
}

type doubaoWebToolCall struct {
	ID        string
	Name      string
	Arguments string
}

func doubaoWebTools(payload map[string]any) ([]doubaoWebTool, error) {
	items, _ := payload["tools"].([]any)
	tools := make([]doubaoWebTool, 0, len(items))
	for _, item := range items {
		entry, _ := item.(map[string]any)
		if entry == nil || stringField(entry, "type") != "function" {
			continue
		}
		fn, _ := entry["function"].(map[string]any)
		name := strings.TrimSpace(stringField(fn, "name"))
		if name == "" {
			return nil, fmt.Errorf("tools 中有没有名字的函数")
		}
		params, _ := json.Marshal(fn["parameters"])
		tools = append(tools, doubaoWebTool{Name: name, Description: stringField(fn, "description"), Parameters: params})
	}
	if choice, ok := payload["tool_choice"].(string); ok && choice == "none" {
		return nil, nil
	}
	return tools, nil
}

func doubaoWebToolInstructions(tools []doubaoWebTool) string {
	list, _ := json.MarshalIndent(tools, "", "  ")
	return "## 可用工具\n你可以调用下面这些工具（JSON Schema 描述参数）：\n" + string(list) + `

## 调用工具的格式（必须严格遵守）
需要调用工具时，回复里只写一个或多个 Markdown 代码块，代码块的语言标记必须是 tool_call，块里是一个 JSON 对象，块外不要写任何别的文字：
` + doubaoWebCallFence + `
{"name": "工具名", "arguments": {参数 JSON 对象}}
` + "```" + `
- 互不依赖的调用可以一次写多个代码块，会一起执行。
- 参数必须是合法 JSON，名字和参数名照上面的定义原样写，不要改大小写或连字符。
- 写完调用块就停下，等工具结果；绝不能自己编造工具结果。
- 不需要工具时，正常用文字回答，不要写调用块。
- 对话记录里【工具结果】是工具真实返回的内容。`
}

// doubaoWebPrompt flattens an OpenAI chat request into one message for a fresh Doubao conversation.
func doubaoWebPrompt(payload map[string]any, tools []doubaoWebTool) (string, error) {
	messages, ok := payload["messages"].([]any)
	if !ok || len(messages) == 0 {
		return "", fmt.Errorf("Chat Completions 请求缺少 messages")
	}
	var system []string
	var turns []string
	for _, item := range messages {
		message, ok := item.(map[string]any)
		if !ok {
			return "", fmt.Errorf("messages 中包含无效项")
		}
		role := strings.ToLower(strings.TrimSpace(stringField(message, "role")))
		content, err := doubaoWorkContentText(message["content"])
		if err != nil {
			return "", err
		}
		switch role {
		case "system", "developer":
			if content != "" {
				system = append(system, content)
			}
		case "user":
			turns = append(turns, "【用户】\n"+content)
		case "assistant":
			block := content
			calls, _ := message["tool_calls"].([]any)
			for _, raw := range calls {
				call, _ := raw.(map[string]any)
				fn, _ := call["function"].(map[string]any)
				args := strings.TrimSpace(stringField(fn, "arguments"))
				if args == "" {
					args = "{}"
				}
				line := fmt.Sprintf("%s\n{\"name\": %q, \"arguments\": %s}\n```", doubaoWebCallFence, stringField(fn, "name"), args)
				if id := stringField(call, "id"); id != "" {
					line += "\n（调用编号 " + id + "）"
				}
				block = strings.TrimSpace(block + "\n" + line)
			}
			if block != "" {
				turns = append(turns, "【助手】\n"+block)
			}
		case "tool", "function":
			label := "【工具结果】"
			if id := stringField(message, "tool_call_id"); id != "" {
				label = "【工具结果（调用编号 " + id + "）】"
			} else if name := stringField(message, "name"); name != "" {
				label = "【工具结果（" + name + "）】"
			}
			turns = append(turns, label+"\n"+content)
		default:
			if content != "" {
				turns = append(turns, "【"+role+"】\n"+content)
			}
		}
	}
	var out strings.Builder
	if len(system) > 0 {
		out.WriteString("【系统指令】\n")
		out.WriteString(strings.Join(system, "\n\n"))
		out.WriteString("\n\n")
	}
	if len(tools) > 0 {
		out.WriteString(doubaoWebToolInstructions(tools))
		out.WriteString("\n\n")
	}
	out.WriteString("## 对话记录\n")
	out.WriteString(strings.Join(turns, "\n\n"))
	out.WriteString("\n\n【助手】\n（请直接写出助手的下一条回复：要用工具就只写调用块，否则写回答。不要复述上面的内容。）")
	return out.String(), nil
}

var (
	doubaoWebFence      = regexp.MustCompile("(?s)```([A-Za-z_-]*)[ \t]*\r?\n(.*?)```")
	doubaoWebTag        = regexp.MustCompile("(?s)" + regexp.QuoteMeta(doubaoWebTagOpen) + "(.*?)" + regexp.QuoteMeta(doubaoWebTagClose))
	doubaoWebCallNumber = regexp.MustCompile(`（调用编号[^）]*）`)
	doubaoWebEmptyFence = regexp.MustCompile("```[A-Za-z_-]*\\s*```")
)

// doubaoWebDecodeCalls reads one JSON object, a JSON array of objects, or several
// objects in a row, and returns them only if every one is a call to a known tool.
func doubaoWebDecodeCalls(body string, known map[string]bool) ([]doubaoWebToolCall, bool) {
	body = strings.TrimSpace(body)
	if body == "" || (body[0] != '{' && body[0] != '[') {
		return nil, false
	}
	var items []json.RawMessage
	if body[0] == '[' {
		if json.Unmarshal([]byte(body), &items) != nil {
			return nil, false
		}
	} else {
		dec := json.NewDecoder(strings.NewReader(body))
		for {
			var item json.RawMessage
			err := dec.Decode(&item)
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return nil, false
			}
			items = append(items, item)
		}
	}
	if len(items) == 0 {
		return nil, false
	}
	calls := make([]doubaoWebToolCall, 0, len(items))
	for _, item := range items {
		var parsed struct {
			Name       string          `json:"name"`
			Arguments  json.RawMessage `json:"arguments"`
			Parameters json.RawMessage `json:"parameters"`
		}
		if json.Unmarshal(item, &parsed) != nil || !known[parsed.Name] {
			return nil, false
		}
		raw := parsed.Arguments
		if len(raw) == 0 {
			raw = parsed.Parameters
		}
		args := strings.TrimSpace(string(raw))
		if args == "" || args == "null" {
			args = "{}"
		}
		if strings.HasPrefix(args, "\"") { // arguments sent as a JSON string
			var unquoted string
			if json.Unmarshal([]byte(args), &unquoted) == nil {
				args = strings.TrimSpace(unquoted)
			}
		}
		if !strings.HasPrefix(args, "{") || !json.Valid([]byte(args)) {
			return nil, false
		}
		calls = append(calls, doubaoWebToolCall{ID: doubaoWorkResponseID("call_")[:29], Name: parsed.Name, Arguments: args})
	}
	return calls, true
}

// doubaoWebParseToolCalls pulls calls out of the reply: fenced code blocks whose
// body is call JSON (asked for as ```tool_call, but the model sometimes tags them
// json or nothing), legacy <tool_call> tags, and, as a fallback, a reply that is
// nothing but call JSON. Calls to unknown tools or with invalid JSON stay in the text.
func doubaoWebParseToolCalls(reply string, tools []doubaoWebTool) (string, []doubaoWebToolCall) {
	if len(tools) == 0 {
		return reply, nil
	}
	known := make(map[string]bool, len(tools))
	for _, tool := range tools {
		known[tool.Name] = true
	}
	var calls []doubaoWebToolCall
	extract := func(re *regexp.Regexp, group int) {
		reply = re.ReplaceAllStringFunc(reply, func(block string) string {
			found, ok := doubaoWebDecodeCalls(re.FindStringSubmatch(block)[group], known)
			if !ok {
				return block
			}
			calls = append(calls, found...)
			return ""
		})
	}
	extract(doubaoWebFence, 2)
	extract(doubaoWebTag, 1)
	if len(calls) == 0 {
		if found, ok := doubaoWebDecodeCalls(reply, known); ok {
			return "", found
		}
		return reply, nil
	}
	// Text around calls is narration ("let me look"), not an answer.
	return strings.TrimSpace(doubaoWebEmptyFence.ReplaceAllString(doubaoWebCallNumber.ReplaceAllString(reply, ""), "")), calls
}

func (s *relayServer) handleDoubaoWebIfRequested(c *gin.Context) bool {
	body, err := readAndRestoreBody(c.Request)
	if err != nil {
		writeAPIError(c, http.StatusBadRequest, "failed to read request body", "invalid_request")
		return true
	}
	if !isDoubaoWebModel(requestBodyModel(body)) {
		return false
	}
	spec, ok := s.requireAPIKey(c)
	if !ok {
		return true
	}
	s.handleDoubaoWebChat(c, spec, body)
	return true
}

func (s *relayServer) doubaoWebAccounts(spec *apiKeySpec, model string) []*accountSpec {
	if s == nil || s.manifest == nil {
		return nil
	}
	var out []*accountSpec
	for i := range s.manifest.Accounts {
		account := &s.manifest.Accounts[i]
		if !strings.EqualFold(strings.TrimSpace(account.Provider), doubaoWebProvider) || !stringSliceContainsFold(account.Models, model) {
			continue
		}
		if spec != nil && len(spec.AccountIDs) > 0 && !stringSliceContainsFold(spec.AccountIDs, account.ID) && !stringSliceContainsFold(spec.AccountIDs, account.AuthID) {
			continue
		}
		out = append(out, account)
	}
	return out
}

func (s *relayServer) handleDoubaoWebChat(c *gin.Context, spec *apiKeySpec, rawJSON []byte) {
	body, model, ok := s.bodyWithValidatedModel(c, spec, rawJSON, "", nil)
	if !ok {
		return
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil || payload == nil {
		writeAPIError(c, http.StatusBadRequest, "请求体必须是有效 JSON", "invalid_request")
		return
	}
	tools, err := doubaoWebTools(payload)
	if err != nil {
		writeAPIError(c, http.StatusBadRequest, err.Error(), "invalid_request")
		return
	}
	prompt, err := doubaoWebPrompt(payload, tools)
	if err != nil {
		writeAPIError(c, http.StatusBadRequest, err.Error(), "invalid_request")
		return
	}
	if len(prompt) > doubaoWebPromptMaxSize {
		writeAPIError(c, http.StatusRequestEntityTooLarge, "发给豆包的内容过长（上限 400 KiB）", "request_too_large")
		return
	}
	accounts := s.doubaoWebAccounts(spec, model)
	if len(accounts) == 0 {
		writeAPIError(c, http.StatusServiceUnavailable, "没有已登录的豆包账号；请先在 C.le 的豆包账号页用浏览器登录", "auth_unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), doubaoWebTimeout)
	defer cancel()
	startedAt := time.Now()
	first := int(doubaoWebCursor.Add(1)-1) % len(accounts)
	var reply *doubaoWebReply
	var lastErr error
	var used *accountSpec
	for i := range accounts {
		account := accounts[(first+i)%len(accounts)]
		cookie, err := doubaoWebCredential(ctx, account.Headers[doubaoWebCredentialHdr], account.UpstreamAPIKey)
		if err == nil {
			client := newDoubaoWebClient(cookie, s.doubaoWebTransport(account)).withModel(doubaoWebModelKey(model))
			if level, fixed := doubaoWebFixedThink(model); fixed {
				// A level the caller picked is kept: a used-up thinking quota moves to the next account.
				client.think = level
				reply, err = client.Complete(ctx, prompt)
			} else {
				reply, err = doubaoWebCompleteWithThinking(ctx, client, account.ID, doubaoWebRequestThink(payload), prompt)
			}
		}
		if err == nil {
			used = account
			break
		}
		lastErr = err
		if ctx.Err() != nil || !(errors.Is(err, errDoubaoWebLoginRequired) || errors.Is(err, errDoubaoWebQuotaExceeded) || errors.Is(err, errDoubaoWebRateLimited)) {
			break // a failed answer may already have been produced; only account problems move to the next one
		}
	}
	if reply == nil {
		status, code := http.StatusBadGateway, "doubao_web_failed"
		switch {
		case errors.Is(lastErr, context.DeadlineExceeded), errors.Is(lastErr, context.Canceled):
			status, code = http.StatusGatewayTimeout, "doubao_web_timeout"
		case errors.Is(lastErr, errDoubaoWebLoginRequired):
			status, code = http.StatusUnauthorized, "doubao_login_required"
		case errors.Is(lastErr, errDoubaoWebQuotaExceeded), errors.Is(lastErr, errDoubaoWebRateLimited):
			status, code = http.StatusTooManyRequests, "quota_exhausted"
		}
		writeAPIError(c, status, fmt.Sprint(lastErr), code)
		return
	}
	if s.emitter != nil {
		s.emitter.emit(requestDiagnosticPayload{
			Type: "executor_completed", RequestID: internallogging.GetRequestID(c.Request.Context()), RequestKind: "chat",
			Model: model, Provider: doubaoWebProvider, AccountID: used.ID, LatencyMS: time.Since(startedAt).Milliseconds(),
		})
	}
	text, calls := doubaoWebParseToolCalls(reply.Answer, tools)
	writeDoubaoWebChatCompletion(c, model, text, reply.Thinking, calls, requestBodyStream(body))
}

func (s *relayServer) doubaoWebTransport(account *accountSpec) http.RoundTripper {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if proxy := strings.TrimSpace(account.ProxyURL); proxy != "" {
		if parsed, err := url.Parse(proxy); err == nil {
			transport.Proxy = http.ProxyURL(parsed)
		}
	}
	return transport
}

func writeDoubaoWebChatCompletion(c *gin.Context, model, text, thinking string, calls []doubaoWebToolCall, stream bool) {
	id := doubaoWorkResponseID("chatcmpl-")
	created := time.Now().Unix()
	finish := "stop"
	toolCalls := make([]any, 0, len(calls))
	for i, call := range calls {
		toolCalls = append(toolCalls, gin.H{"index": i, "id": call.ID, "type": "function", "function": gin.H{"name": call.Name, "arguments": call.Arguments}})
	}
	if len(calls) > 0 {
		finish = "tool_calls"
	}
	if !stream {
		message := gin.H{"role": "assistant", "content": text}
		if len(calls) > 0 {
			message["tool_calls"] = toolCalls
			if text == "" {
				message["content"] = nil
			}
		}
		if thinking != "" {
			message["reasoning_content"] = thinking
		}
		c.JSON(http.StatusOK, gin.H{"id": id, "object": "chat.completion", "created": created, "model": model,
			"choices": []any{gin.H{"index": 0, "message": message, "finish_reason": finish}}})
		return
	}
	setEventStreamHeaders(c.Writer.Header())
	c.Status(http.StatusOK)
	chunk := func(delta gin.H, finishReason any) {
		doubaoWriteSSE(c, gin.H{"id": id, "object": "chat.completion.chunk", "created": created, "model": model,
			"choices": []any{gin.H{"index": 0, "delta": delta, "finish_reason": finishReason}}})
	}
	chunk(gin.H{"role": "assistant"}, nil)
	if thinking != "" {
		chunk(gin.H{"reasoning_content": thinking}, nil)
	}
	if text != "" {
		chunk(gin.H{"content": text}, nil)
	}
	if len(calls) > 0 {
		chunk(gin.H{"tool_calls": toolCalls}, nil)
	}
	chunk(gin.H{}, finish)
	_, _ = fmt.Fprint(c.Writer, "data: [DONE]\n\n")
	if flusher, ok := c.Writer.(http.Flusher); ok {
		flusher.Flush()
	}
}

// Chat-mode thinking levels, deepest first: 专家 (3), 思考 (1), 快速 (0).
var doubaoWebThinkLevels = []int{3, 1, 0}

// doubaoWebThinkExhausted remembers account+level pairs whose thinking quota ran out,
// so later requests start at a level that can still answer.
var doubaoWebThinkExhausted sync.Map // "account|level" -> time.Time (retry after)

const doubaoWebThinkRetryAfter = time.Hour

// doubaoWebRequestThink maps the caller's reasoning_effort to the deepest level to try.
// No effort given means the deepest one.
func doubaoWebRequestThink(payload map[string]any) int {
	effort := strings.ToLower(strings.TrimSpace(stringFieldFromAny(payload["reasoning_effort"])))
	if reasoning, ok := payload["reasoning"].(map[string]any); ok && effort == "" {
		effort = strings.ToLower(strings.TrimSpace(stringFieldFromAny(reasoning["effort"])))
	}
	switch effort {
	case "none", "minimal":
		return 0
	case "low", "medium":
		return 1
	}
	return doubaoWebThinkLevels[0]
}

// doubaoWebCompleteWithThinking answers with the deepest thinking level the account can still use.
// When a thinking level hits its quota (Doubao's free thinking quota is a 7-day window, while 快速
// keeps working), it steps down a level on the same account instead of failing the request.
// Named models carry their own mode, so only auto steps through levels.
func doubaoWebCompleteWithThinking(ctx context.Context, client *doubaoWebClient, accountID string, deepest int, prompt string) (*doubaoWebReply, error) {
	if client.model != "" {
		return client.Complete(ctx, prompt)
	}
	var lastErr error
	for _, level := range doubaoWebThinkLevels {
		if level > deepest {
			continue
		}
		key := accountID + "|" + strconv.Itoa(level)
		if level > 0 {
			if until, ok := doubaoWebThinkExhausted.Load(key); ok && time.Now().Before(until.(time.Time)) {
				continue
			}
		}
		client.think = level
		reply, err := client.Complete(ctx, prompt)
		if err == nil {
			return reply, nil
		}
		lastErr = err
		if level == 0 || ctx.Err() != nil || errors.Is(err, errDoubaoWebLoginRequired) || errors.Is(err, errDoubaoWebRateLimited) {
			return nil, err
		}
		if errors.Is(err, errDoubaoWebQuotaExceeded) {
			doubaoWebThinkExhausted.Store(key, time.Now().Add(doubaoWebThinkRetryAfter))
		}
	}
	return nil, lastErr
}
