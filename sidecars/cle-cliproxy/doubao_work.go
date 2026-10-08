package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	internallogging "github.com/router-for-me/CLIProxyAPI/v7/internal/logging"
)

const (
	doubaoWorkProvider      = "doubao-work"
	doubaoWorkModelPrefix   = "doubao-work/"
	doubaoWorkTaskTimeout   = 10 * time.Minute
	doubaoWorkPromptMaxSize = 128 * 1024
)

var errDoubaoWorkQuotaExceeded = errors.New("豆包工作账号订阅额度已用完")

func isDoubaoWorkModel(model string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(model)), doubaoWorkModelPrefix)
}

func (s *relayServer) handleDoubaoWorkChat(c *gin.Context, spec *apiKeySpec, rawJSON []byte, responsesAPI bool) {
	body, model, ok := s.bodyWithValidatedModel(c, spec, rawJSON, "", nil)
	if !ok {
		return
	}
	model = strings.TrimSpace(model)
	if !isDoubaoWorkModel(model) {
		writeAPIError(c, http.StatusBadRequest, "Doubao Work model must use the doubao-work/<model> ID", "model_not_supported")
		return
	}
	cliModel := strings.TrimSpace(model[len(doubaoWorkModelPrefix):])
	if cliModel == "" {
		writeAPIError(c, http.StatusBadRequest, "Doubao Work model ID is empty", "model_not_supported")
		return
	}
	account := s.findDoubaoWorkAccount(c.Request.Context(), spec, model)
	if account == nil {
		writeAPIError(c, http.StatusServiceUnavailable, "没有当前已激活且包含此模型的豆包工作账号；请先在豆包客户端切换账号", "auth_unavailable")
		return
	}
	prompt, err := doubaoWorkPrompt(body, responsesAPI)
	if err != nil {
		writeAPIError(c, http.StatusBadRequest, err.Error(), "invalid_request")
		return
	}
	if len(prompt) > doubaoWorkPromptMaxSize {
		writeAPIError(c, http.StatusRequestEntityTooLarge, "豆包工作单次提示内容过长（上限 128 KiB）", "request_too_large")
		return
	}

	cliPath, err := resolveDoubaoCLI(account.CLIPath)
	if err != nil {
		writeAPIError(c, http.StatusServiceUnavailable, err.Error(), "doubao_cli_unavailable")
		return
	}
	startedAt := time.Now()
	requestKind := "chat"
	if responsesAPI {
		requestKind = "responses"
	}
	if s.emitter != nil {
		s.emitter.emit(requestDiagnosticPayload{
			Type:         "auth_selected",
			RequestID:    internallogging.GetRequestID(c.Request.Context()),
			RequestKind:  requestKind,
			Model:        model,
			Provider:     doubaoWorkProvider,
			AccountID:    account.ID,
			AccountEmail: account.Email,
		})
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), doubaoWorkTaskTimeout+30*time.Second)
	defer cancel()
	reply, err := runDoubaoWorkTask(ctx, cliPath, account.CLIApp, account.CLIProfile, cliModel, prompt)
	if err != nil {
		status := http.StatusBadGateway
		code := "doubao_work_failed"
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
			code = "doubao_work_timeout"
		} else if errors.Is(err, errDoubaoWorkQuotaExceeded) {
			status = http.StatusTooManyRequests
			code = "quota_exhausted"
		}
		writeAPIError(c, status, err.Error(), code)
		if s.emitter != nil {
			s.emitter.emit(requestDiagnosticPayload{
				Type: "executor_failed", RequestID: internallogging.GetRequestID(c.Request.Context()),
				RequestKind: requestKind, Model: model, Provider: doubaoWorkProvider, AccountID: account.ID,
				ErrorMessage: err.Error(), Status: status, LatencyMS: time.Since(startedAt).Milliseconds(),
			})
		}
		return
	}
	if strings.TrimSpace(reply) == "" {
		writeAPIError(c, http.StatusBadGateway, "豆包工作任务已结束，但 CLI 没有返回文本结果", "empty_response")
		return
	}
	if doubaoWorkQuotaExceeded(reply) {
		writeAPIError(c, http.StatusTooManyRequests, reply, "quota_exhausted")
		return
	}
	if s.emitter != nil {
		s.emitter.emit(requestDiagnosticPayload{
			Type: "executor_completed", RequestID: internallogging.GetRequestID(c.Request.Context()),
			RequestKind: requestKind, Model: model, Provider: doubaoWorkProvider, AccountID: account.ID,
			LatencyMS: time.Since(startedAt).Milliseconds(),
		})
	}

	stream := requestBodyStream(body)
	if responsesAPI {
		writeDoubaoWorkResponses(c, model, reply, stream)
	} else {
		writeDoubaoWorkChatCompletion(c, model, reply, stream)
	}
}

func (s *relayServer) findDoubaoWorkAccount(ctx context.Context, spec *apiKeySpec, model string) *accountSpec {
	if s == nil || s.manifest == nil {
		return nil
	}
	var candidates []*accountSpec
	for i := range s.manifest.Accounts {
		account := &s.manifest.Accounts[i]
		if !strings.EqualFold(strings.TrimSpace(account.Provider), doubaoWorkProvider) {
			continue
		}
		if !stringSliceContainsFold(account.Models, model) {
			continue
		}
		if spec != nil && len(spec.AccountIDs) > 0 && !stringSliceContainsFold(spec.AccountIDs, account.ID) {
			continue
		}
		candidates = append(candidates, account)
	}
	if len(candidates) == 1 {
		return candidates[0]
	}
	for _, account := range candidates {
		cliPath, err := resolveDoubaoCLI(account.CLIPath)
		if err != nil {
			continue
		}
		app := account.CLIApp
		if app == "" {
			app = "work"
		}
		status, err := runDoubaoCLI(ctx, cliPath, "--app", app, "status", "--json")
		if err != nil || status["running"] != true {
			continue
		}
		profile, _ := status["profile"].(map[string]any)
		active, _ := profile["directory"].(string)
		if active != "" && active == account.CLIProfile {
			return account
		}
	}
	return nil
}

func doubaoWorkPrompt(body []byte, responsesAPI bool) (string, error) {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil || payload == nil {
		return "", fmt.Errorf("请求体必须是有效 JSON")
	}
	for _, key := range []string{"tools", "tool_choice", "functions", "function_call"} {
		if value, exists := payload[key]; exists && value != nil {
			if items, ok := value.([]any); ok && len(items) == 0 {
				continue
			}
			return "", fmt.Errorf("豆包工作 Agent 当前不支持 OpenAI 工具调用（%s）", key)
		}
	}
	if responsesAPI && strings.TrimSpace(stringField(payload, "previous_response_id")) != "" {
		return "", fmt.Errorf("豆包工作 Agent 每次请求会新建任务，暂不支持 previous_response_id")
	}
	parts := make([]string, 0)
	if instructions := strings.TrimSpace(stringField(payload, "instructions")); instructions != "" {
		parts = append(parts, "System instructions:\n"+instructions)
	}
	if responsesAPI {
		input := payload["input"]
		switch value := input.(type) {
		case string:
			if text := strings.TrimSpace(value); text != "" {
				parts = append(parts, "User:\n"+text)
			}
		case []any:
			for _, item := range value {
				message, ok := item.(map[string]any)
				if !ok {
					return "", fmt.Errorf("豆包工作 Agent 暂不支持此 Responses input 项")
				}
				typeName := strings.ToLower(strings.TrimSpace(stringField(message, "type")))
				if typeName == "input_text" {
					if text := strings.TrimSpace(stringField(message, "text")); text != "" {
						parts = append(parts, doubaoWorkRoleBlock("user", text))
					}
					continue
				}
				if typeName != "" && typeName != "message" {
					return "", fmt.Errorf("豆包工作 Agent 暂不支持 Responses input 类型 %s", typeName)
				}
				role := strings.TrimSpace(stringField(message, "role"))
				if role == "" {
					role = strings.TrimSpace(stringField(message, "type"))
				}
				content, err := doubaoWorkContentText(message["content"])
				if err != nil {
					return "", err
				}
				if content != "" {
					parts = append(parts, doubaoWorkRoleBlock(role, content))
				}
			}
		case nil:
			return "", fmt.Errorf("Responses 请求缺少 input")
		default:
			return "", fmt.Errorf("豆包工作暂不支持此 Responses input 格式")
		}
	} else {
		messages, ok := payload["messages"].([]any)
		if !ok || len(messages) == 0 {
			return "", fmt.Errorf("Chat Completions 请求缺少 messages")
		}
		for _, item := range messages {
			message, ok := item.(map[string]any)
			if !ok {
				return "", fmt.Errorf("messages 中包含无效项")
			}
			if message["tool_calls"] != nil || message["function_call"] != nil {
				return "", fmt.Errorf("豆包工作 Agent 当前不支持 OpenAI 工具调用")
			}
			role := strings.TrimSpace(stringField(message, "role"))
			content, err := doubaoWorkContentText(message["content"])
			if err != nil {
				return "", err
			}
			if content != "" {
				parts = append(parts, doubaoWorkRoleBlock(role, content))
			}
		}
	}
	if len(parts) == 0 {
		return "", fmt.Errorf("请求没有可发送的文本内容")
	}
	return strings.Join(parts, "\n\n"), nil
}

func doubaoWorkRoleBlock(role, content string) string {
	label := strings.TrimSpace(role)
	if label == "" {
		label = "user"
	}
	return strings.ToUpper(label) + ":\n" + content
}

func doubaoWorkContentText(content any) (string, error) {
	switch value := content.(type) {
	case string:
		return strings.TrimSpace(value), nil
	case []any:
		parts := make([]string, 0, len(value))
		for _, item := range value {
			block, ok := item.(map[string]any)
			if !ok {
				continue
			}
			typeName := strings.ToLower(strings.TrimSpace(stringField(block, "type")))
			if strings.Contains(typeName, "image") || strings.Contains(typeName, "file") || strings.Contains(typeName, "audio") || strings.Contains(typeName, "video") {
				return "", fmt.Errorf("豆包工作 Agent 当前只接受文本；请勿通过此 API 发送图片、文件或音视频块")
			}
			text := stringField(block, "text")
			if text == "" {
				text = stringField(block, "content")
			}
			if text = strings.TrimSpace(text); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n"), nil
	case nil:
		return "", nil
	default:
		return "", fmt.Errorf("豆包工作 Agent 当前只接受文本消息")
	}
}

func runDoubaoWorkTask(ctx context.Context, cliPath, app, profile, model, prompt string) (string, error) {
	if app == "" {
		app = "work" // Existing accounts were imported from the standalone Work app.
	}
	if app != "work" && app != "doubao" {
		return "", fmt.Errorf("无效的豆包客户端类型 %q", app)
	}
	globalArgs := []string{"--app", app}
	if profile = strings.TrimSpace(profile); profile != "" {
		globalArgs = append([]string{"--profile", profile}, globalArgs...)
	}
	createArgs := append(append([]string(nil), globalArgs...), "sessions", "create", prompt)
	if model != "auto" {
		createArgs = append(createArgs, "--model", model)
	}
	createArgs = append(createArgs, "--runtime", "local", "--permission", "AskOnRisk", "--json")
	create, createErr := runDoubaoCLI(ctx, cliPath, createArgs...)
	conversationID := doubaoJSONScalar(create, "conversationId", "conversation_id")
	runID := doubaoJSONScalar(create, "runId", "run_id")
	if createErr != nil && (conversationID == "" || runID == "") {
		return "", fmt.Errorf("启动豆包工作 Agent 失败: %w", createErr)
	}
	if doubaoJSONStatus(create) == "completed" {
		if reply := doubaoJSONScalar(create, "reply", "text"); reply != "" {
			if doubaoWorkQuotaExceeded(reply) {
				return "", fmt.Errorf("%w: %s", errDoubaoWorkQuotaExceeded, reply)
			}
			return reply, nil
		}
	}
	if conversationID == "" || runID == "" {
		return "", fmt.Errorf("豆包工作 CLI 没有返回任务编号；请不要直接重复请求，先检查豆包工作中的任务状态")
	}

	waitArgs := append(append([]string(nil), globalArgs...), "sessions", "wait", conversationID,
		"--run", runID, "--timeout", strconvItoa(int(doubaoWorkTaskTimeout.Seconds())), "--json")
	wait, waitErr := runDoubaoCLI(ctx, cliPath, waitArgs...)
	status := doubaoJSONStatus(wait)
	if status == "waiting_input" {
		return "", fmt.Errorf("豆包工作 Agent 正在等待你在豆包工作窗口中回答问题或确认操作")
	}
	if waitErr != nil || status != "completed" {
		if waitErr != nil {
			return "", fmt.Errorf("等待豆包工作 Agent 结束失败（conversation %s，run %s）: %w", conversationID, runID, waitErr)
		}
		return "", fmt.Errorf("豆包工作 Agent 当前状态为 %q（conversation %s，run %s）", status, conversationID, runID)
	}
	reply := doubaoJSONScalar(wait, "reply", "text")
	if reply == "" {
		return "", fmt.Errorf("豆包工作任务已完成，但 CLI 没有返回最终答复")
	}
	if doubaoWorkQuotaExceeded(reply) {
		return "", fmt.Errorf("%w: %s", errDoubaoWorkQuotaExceeded, reply)
	}
	return reply, nil
}

func doubaoWorkQuotaExceeded(reply string) bool {
	if len(reply) > 600 {
		return false
	}
	quota := strings.Contains(reply, "额度用完") || strings.Contains(reply, "额度已用尽") ||
		strings.Contains(reply, "额度不足") || strings.Contains(strings.ToLower(reply), "quota exhausted")
	return quota && (strings.Contains(reply, "恢复为你服务") || strings.Contains(reply, "升级你的订阅套餐") ||
		strings.Contains(strings.ToLower(reply), "try again later"))
}

func runDoubaoCLI(ctx context.Context, cliPath string, args ...string) (map[string]any, error) {
	commandArgs := args
	commandName := cliPath
	if runtime.GOOS == "windows" && strings.HasSuffix(strings.ToLower(cliPath), ".cmd") {
		commandName = "cmd.exe"
		commandArgs = append([]string{"/C", cliPath}, args...)
	}
	cmd := exec.CommandContext(ctx, commandName, commandArgs...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.Env = doubaoCLIEnvironment(cliPath)
	output, err := cmd.Output()
	if len(output) > 16*1024*1024 {
		return nil, fmt.Errorf("豆包工作 CLI 返回内容超过 16 MiB")
	}
	var parsed map[string]any
	parseErr := json.Unmarshal(bytes.TrimSpace(output), &parsed)
	if err != nil {
		detail := strings.TrimSpace(stderr.String())
		if len(detail) > 500 {
			detail = detail[:500]
		}
		if parseErr == nil {
			return parsed, fmt.Errorf("CLI 退出码非零: %w", err)
		}
		if detail == "" {
			detail = strings.TrimSpace(string(output))
		}
		if len(detail) > 500 {
			detail = detail[:500]
		}
		if detail == "" {
			detail = err.Error()
		}
		return nil, fmt.Errorf("%s", detail)
	}
	if parseErr != nil {
		return nil, fmt.Errorf("CLI 没有返回 JSON 结果: %s", strings.TrimSpace(string(output)))
	}
	return parsed, nil
}

func doubaoCLIEnvironment(cliPath string) []string {
	pathValue := os.Getenv("PATH")
	if directory := filepath.Dir(cliPath); directory != "." && directory != "" {
		pathValue = directory + string(os.PathListSeparator) + pathValue
	}
	env := make([]string, 0, len(os.Environ())+2)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "PATH=") && !strings.HasPrefix(entry, "DOUBAO_CLI_DISABLE_AUTO_UPDATE=") {
			env = append(env, entry)
		}
	}
	return append(env, "PATH="+pathValue, "DOUBAO_CLI_DISABLE_AUTO_UPDATE=1")
}

func resolveDoubaoCLI(configured string) (string, error) {
	candidates := make([]string, 0, 8)
	if strings.TrimSpace(configured) != "" {
		candidates = append(candidates, strings.TrimSpace(configured))
	}
	if envPath := strings.TrimSpace(os.Getenv("DOUBAO_CLI_PATH")); envPath != "" {
		candidates = append(candidates, envPath)
	}
	if found, err := exec.LookPath("doubao"); err == nil {
		candidates = append(candidates, found)
	}
	if home, err := os.UserHomeDir(); err == nil {
		for _, directory := range []string{".volta/bin", ".local/share/pnpm", "Library/pnpm", ".npm-global/bin"} {
			candidates = append(candidates, filepath.Join(home, directory, "doubao"))
		}
		matches, _ := filepath.Glob(filepath.Join(home, ".nvm", "versions", "node", "*", "bin", "doubao"))
		sort.Sort(sort.Reverse(sort.StringSlice(matches)))
		candidates = append(candidates, matches...)
	}
	candidates = append(candidates, "/opt/homebrew/bin/doubao", "/usr/local/bin/doubao")
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("找不到 doubao-cli。请安装 `doubao-cli` 并登录豆包工作；首次使用前运行 `doubao --app work cdp launch`")
}

func doubaoJSONScalar(value map[string]any, keys ...string) string {
	if value == nil {
		return ""
	}
	for _, key := range keys {
		if item, ok := value[key]; ok {
			switch typed := item.(type) {
			case string:
				return strings.TrimSpace(typed)
			case float64:
				return strconvItoa(int(typed))
			case json.Number:
				return typed.String()
			}
		}
	}
	for _, child := range value {
		if nested, ok := child.(map[string]any); ok {
			if found := doubaoJSONScalar(nested, keys...); found != "" {
				return found
			}
		}
	}
	return ""
}

func doubaoJSONStatus(value map[string]any) string {
	return strings.ToLower(doubaoJSONScalar(value, "status", "state"))
}

func writeDoubaoWorkChatCompletion(c *gin.Context, model, reply string, stream bool) {
	id := doubaoWorkResponseID("chatcmpl-")
	created := time.Now().Unix()
	if !stream {
		c.JSON(http.StatusOK, gin.H{
			"id": id, "object": "chat.completion", "created": created, "model": model,
			"choices": []any{gin.H{"index": 0, "message": gin.H{"role": "assistant", "content": reply}, "finish_reason": "stop"}},
		})
		return
	}
	setEventStreamHeaders(c.Writer.Header())
	c.Status(http.StatusOK)
	doubaoWriteSSE(c, gin.H{
		"id": id, "object": "chat.completion.chunk", "created": created, "model": model,
		"choices": []any{gin.H{"index": 0, "delta": gin.H{"role": "assistant", "content": reply}, "finish_reason": nil}},
	})
	doubaoWriteSSE(c, gin.H{
		"id": id, "object": "chat.completion.chunk", "created": created, "model": model,
		"choices": []any{gin.H{"index": 0, "delta": gin.H{}, "finish_reason": "stop"}},
	})
	_, _ = fmt.Fprint(c.Writer, "data: [DONE]\n\n")
	if flusher, ok := c.Writer.(http.Flusher); ok {
		flusher.Flush()
	}
}

func writeDoubaoWorkResponses(c *gin.Context, model, reply string, stream bool) {
	responseID := doubaoWorkResponseID("resp_")
	itemID := doubaoWorkResponseID("msg_")
	created := time.Now().Unix()
	response := gin.H{
		"id": responseID, "object": "response", "created_at": created, "status": "completed",
		"error": nil, "model": model, "output": []any{gin.H{
			"id": itemID, "type": "message", "status": "completed", "role": "assistant",
			"content": []any{gin.H{"type": "output_text", "text": reply, "annotations": []any{}}},
		}},
	}
	if !stream {
		c.JSON(http.StatusOK, response)
		return
	}
	setEventStreamHeaders(c.Writer.Header())
	c.Status(http.StatusOK)
	writeEvent := func(name string, payload any) {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return
		}
		_, _ = fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", name, encoded)
		if flusher, ok := c.Writer.(http.Flusher); ok {
			flusher.Flush()
		}
	}
	responseInProgress := gin.H{"id": responseID, "object": "response", "created_at": created, "status": "in_progress", "model": model, "output": []any{}}
	writeEvent("response.created", gin.H{"type": "response.created", "response": responseInProgress})
	writeEvent("response.in_progress", gin.H{"type": "response.in_progress", "response": responseInProgress})
	itemInProgress := gin.H{"id": itemID, "type": "message", "status": "in_progress", "role": "assistant", "content": []any{}}
	writeEvent("response.output_item.added", gin.H{"type": "response.output_item.added", "output_index": 0, "item": itemInProgress})
	writeEvent("response.content_part.added", gin.H{"type": "response.content_part.added", "item_id": itemID, "output_index": 0, "content_index": 0, "part": gin.H{"type": "output_text", "text": "", "annotations": []any{}}})
	writeEvent("response.output_text.delta", gin.H{"type": "response.output_text.delta", "item_id": itemID, "output_index": 0, "content_index": 0, "delta": reply})
	writeEvent("response.output_text.done", gin.H{"type": "response.output_text.done", "item_id": itemID, "output_index": 0, "content_index": 0, "text": reply})
	writeEvent("response.content_part.done", gin.H{"type": "response.content_part.done", "item_id": itemID, "output_index": 0, "content_index": 0, "part": gin.H{"type": "output_text", "text": reply, "annotations": []any{}}})
	writeEvent("response.output_item.done", gin.H{"type": "response.output_item.done", "output_index": 0, "item": response["output"].([]any)[0]})
	writeEvent("response.completed", gin.H{"type": "response.completed", "response": response})
	_, _ = io.WriteString(c.Writer, "data: [DONE]\n\n")
	if flusher, ok := c.Writer.(http.Flusher); ok {
		flusher.Flush()
	}
}

func doubaoWriteSSE(c *gin.Context, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(c.Writer, "data: %s\n\n", encoded)
	if flusher, ok := c.Writer.(http.Flusher); ok {
		flusher.Flush()
	}
}

func doubaoWorkResponseID(prefix string) string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return prefix + strconvItoa(int(time.Now().UnixNano()))
	}
	return prefix + hex.EncodeToString(raw[:])
}

func strconvItoa(value int) string {
	return fmt.Sprintf("%d", value)
}
