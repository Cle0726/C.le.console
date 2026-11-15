package main

// Doubao web chat, driven with the cookies of a Doubao account the user signed
// in to through C.le's own browser window. The request shape and stream events
// are ported from doubao-cli's headless backend (MIT, Copyright (c) 2026
// Fullstop000, https://github.com/Fullstop000/doubao-cli); see
// DOUBAO-CLI-NOTICE.md. Only the plain chat mode is used: it runs Doubao's
// default model in Doubao's cloud and never executes anything on this machine.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	doubaoWebProvider        = "doubao-web"
	doubaoWebModelPrefix     = "doubao-web/"
	doubaoWebOrigin          = "https://www.doubao.com"
	doubaoWebProtocolVersion = "2.32.10"
	doubaoWebBotID           = "7338286299411103781"
	doubaoWebCredentialHdr   = "X-Cle-Doubao-Credential-URL"
	doubaoWebMaxFrame        = 4 << 20
)

var (
	errDoubaoWebLoginRequired = errors.New("豆包登录已失效，请在 C.le 的豆包账号页重新登录")
	errDoubaoWebQuotaExceeded = errors.New("豆包账号额度已用完")
	errDoubaoWebRateLimited   = errors.New("豆包账号访问过于频繁")
)

func isDoubaoWebModel(model string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(model)), doubaoWebModelPrefix)
}

type doubaoWebClient struct {
	http     *http.Client
	cookie   string
	model    string // Doubao model_item_key; empty lets Doubao pick (auto)
	webID    string
	deviceID string
}

func doubaoWebRandomID() string {
	limit := new(big.Int).Lsh(big.NewInt(1), 53)
	for {
		n, err := rand.Int(rand.Reader, limit)
		if err == nil && n.Sign() > 0 {
			return n.String()
		}
	}
}

func doubaoWebUUID() string {
	var raw [16]byte
	_, _ = rand.Read(raw[:])
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	h := hex.EncodeToString(raw[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func newDoubaoWebClient(cookie string, transport http.RoundTripper) *doubaoWebClient {
	if transport == nil {
		transport = http.DefaultTransport
	}
	return &doubaoWebClient{http: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}, cookie: strings.TrimSpace(cookie), webID: doubaoWebRandomID(), deviceID: doubaoWebRandomID()}
}

func (c *doubaoWebClient) endpoint(path string) string {
	query := url.Values{}
	for key, value := range map[string]string{
		"aid": "1044603", "device_platform": "web", "samantha_web": "1",
		"pc_version": doubaoWebProtocolVersion, "doubao_pc_version": doubaoWebProtocolVersion,
		"version_code": "20800", "language": "zh", "region": "CN", "sys_region": "CN",
		"web_id": c.webID, "device_id": c.deviceID,
	} {
		query.Set(key, value)
	}
	return doubaoWebOrigin + path + "?" + query.Encode()
}

func doubaoWebCookieValue(header, name string) string {
	for _, part := range strings.Split(header, ";") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok && key == name {
			return value
		}
	}
	return ""
}

// doubaoWebChatBody builds a new single-turn chat conversation (agent_mode 2).
// doubaoWebModelKey maps a pool model ID (doubao-web/<model_item_key>) to Doubao's key; auto is empty.
func doubaoWebModelKey(model string) string {
	key := strings.TrimSpace(model)
	if len(key) >= len(doubaoWebModelPrefix) && strings.EqualFold(key[:len(doubaoWebModelPrefix)], doubaoWebModelPrefix) {
		key = key[len(doubaoWebModelPrefix):]
	}
	if strings.EqualFold(key, "auto") {
		return ""
	}
	return key
}

// withModel returns the client set to answer with one Doubao model (empty: auto).
func (c *doubaoWebClient) withModel(key string) *doubaoWebClient {
	c.model = key
	return c
}

func doubaoWebChatBody(message, model string) map[string]any {
	localMessageID := doubaoWebUUID()
	generalTask := map[string]any{
		"action": 0, "thread_local_message_id": []string{localMessageID}, "runtime_type": 1,
		"agent_task_param":         map[string]any{"runtime_type": 1},
		"agent_task_param_change":  map[string]any{"runtime_changed": false, "device_changed": false, "sandbox_auth_type_changed": false},
		"need_modify_conversation": false,
		"task_input_json":          `{"schema_version":1,"project_context":{}}`,
	}
	generalTaskJSON, _ := json.Marshal(generalTask)
	initOption := map[string]any{"need_ack_conversation": true}
	initJSON, _ := json.Marshal(initOption)
	now := time.Now()
	deepThink := 0
	initExt := map[string]any{"mode_id": "1"}
	body := map[string]any{
		"client_meta": map[string]any{
			"local_conversation_id": fmt.Sprintf("local_%d_%s", now.UnixMilli(), doubaoWebUUID()),
			"conversation_id":       "", "bot_id": doubaoWebBotID, "last_section_id": "", "last_message_index": nil,
		},
		"messages": []any{map[string]any{
			"local_message_id": localMessageID,
			"content_block": []any{map[string]any{
				"block_type": 10000, "content": map[string]any{"text_block": map[string]any{"text": message}}, "block_id": doubaoWebUUID(),
			}},
			"message_status": 0,
		}},
		"option": map[string]any{
			"create_time_ms": now.UnixMilli(), "agent_mode": 2, "need_deep_think": 0, "unique_key": doubaoWebUUID(),
			"recovery_option":          map[string]any{"is_recovery": false, "req_create_time_sec": now.Unix(), "append_sse_event_scene": 0},
			"need_create_conversation": true, "is_old_user": true, "message_from": 0,
			"sse_recv_event_options":   map[string]any{"support_chunk_delta": true},
			"general_task_param":       generalTask,
			"conversation_init_option": initOption,
			"conversation_init_ext":    initExt,
		},
		"ext": map[string]any{
			"general_task_param": string(generalTaskJSON), "use_deep_think": "0", "agent_mode": "2",
			"sub_conv_firstmet_type": "1", "collection_id": "", "is_finish": "1",
			"conversation_init_option": string(initJSON), "commerce_credit_config_enable": "0",
		},
		"user_context": []any{},
	}
	if model != "" {
		// Same rule as the Doubao web client: numeric keys are their own deep-think mode, named models use 10001.
		deepThink = 10001
		if n, err := strconv.Atoi(model); err == nil {
			deepThink = n
		}
		option := body["option"].(map[string]any)
		initExt["model_item_key"] = model
		option["model_config"] = map[string]any{"model_item_key": model}
		option["aggregate_params"] = map[string]any{"provider_id": ""}
	}
	body["option"].(map[string]any)["need_deep_think"] = deepThink
	body["ext"].(map[string]any)["use_deep_think"] = strconv.Itoa(deepThink)
	return body
}

type doubaoWebReply struct {
	ConversationID string
	Answer         string
	Thinking       string
}

// addBlocks appends the answer text (10000) and thinking (10040) pieces of a stream event.
func (r *doubaoWebReply) addBlocks(blocks []any) {
	for _, item := range blocks {
		block, _ := item.(map[string]any)
		content, _ := block["content"].(map[string]any)
		switch fmt.Sprint(block["block_type"]) {
		case "10000":
			if text, ok := content["text_block"].(map[string]any); ok {
				r.Answer += stringFieldFromAny(text["text"])
			}
		case "10040":
			if thinking, ok := content["thinking_block"].(map[string]any); ok {
				r.Thinking += stringFieldFromAny(thinking["content"])
			}
		}
	}
}

// Complete sends one message in a new conversation and collects the whole answer.
func (c *doubaoWebClient) Complete(ctx context.Context, message string) (*doubaoWebReply, error) {
	if c.cookie == "" || (doubaoWebCookieValue(c.cookie, "sessionid") == "" && doubaoWebCookieValue(c.cookie, "sessionid_ss") == "" && doubaoWebCookieValue(c.cookie, "sid_tt") == "") {
		return nil, errDoubaoWebLoginRequired
	}
	payload, err := json.Marshal(doubaoWebChatBody(message, c.model))
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint("/chat/completion"), bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cookie", c.cookie)
	req.Header.Set("Origin", doubaoWebOrigin)
	req.Header.Set("Referer", doubaoWebOrigin+"/chat/")
	if csrf := doubaoWebCookieValue(c.cookie, "passport_csrf_token"); csrf != "" {
		req.Header.Set("X-Tt-Passport-Csrf-Token", csrf)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, errDoubaoWebLoginRequired
	}
	if resp.StatusCode != http.StatusOK || !strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		if bytes.Contains(snippet, []byte("login")) || bytes.Contains(snippet, []byte("登录")) {
			return nil, errDoubaoWebLoginRequired
		}
		return nil, fmt.Errorf("豆包没有返回对话流（HTTP %d）", resp.StatusCode)
	}
	reply := &doubaoWebReply{}
	accepted, completed := false, false
	var streamErr error
	err = doubaoWebReadSSE(resp.Body, func(event string, data map[string]any) bool {
		switch event {
		case "SSE_ACK":
			accepted = true
			if meta, ok := data["ack_client_meta"].(map[string]any); ok {
				reply.ConversationID = stringFieldFromAny(meta["conversation_id"])
			}
		case "STREAM_MSG_NOTIFY":
			// Opens the reply message and carries its first chunk (often the opening ``` of a code block).
			content, _ := data["content"].(map[string]any)
			blocks, _ := content["content_block"].([]any)
			reply.addBlocks(blocks)
		case "STREAM_CHUNK":
			ops, _ := data["patch_op"].([]any)
			for _, op := range ops {
				value, _ := op.(map[string]any)
				patch, _ := value["patch_value"].(map[string]any)
				blocks, _ := patch["content_block"].([]any)
				reply.addBlocks(blocks)
			}
		case "SSE_REPLY_END":
			endType := fmt.Sprint(data["end_type"])
			if endType == "1" && strings.TrimSpace(reply.Answer) == "" {
				// brief is the conversation-list preview: code blocks become "[代码]", so only use it
				// when nothing was streamed.
				if attr, ok := data["msg_finish_attr"].(map[string]any); ok {
					reply.Answer = stringFieldFromAny(attr["brief"])
				}
			}
			if endType == "3" {
				completed = true
				return false
			}
		case "STREAM_ERROR", "gateway-error":
			code := fmt.Sprint(data["error_code"])
			if n, ok := data["error_code"].(float64); ok {
				code = strconv.FormatInt(int64(n), 10)
			}
			streamErr = fmt.Errorf("豆包对话出错：%s %s", code, stringFieldFromAny(data["error_msg"]))
			if code == "710022002" { // 当前服务访问频繁: per-account rate limit, another account may answer
				streamErr = fmt.Errorf("%w：%s", errDoubaoWebRateLimited, stringFieldFromAny(data["error_msg"]))
			}
			return false
		}
		return true
	})
	if err == nil {
		err = streamErr
	}
	if err != nil {
		return nil, err
	}
	if !accepted {
		return nil, fmt.Errorf("豆包没有确认收到这条消息")
	}
	_ = completed // a chat stream may simply close after the answer; the answer itself is the check
	if strings.TrimSpace(reply.Answer) == "" {
		return nil, fmt.Errorf("豆包对话已结束，但没有返回文字")
	}
	if doubaoWebQuotaReply(reply.Answer) {
		return nil, fmt.Errorf("%w：%s", errDoubaoWebQuotaExceeded, strings.TrimSpace(reply.Answer))
	}
	return reply, nil
}

func doubaoWebQuotaReply(answer string) bool {
	text := strings.TrimSpace(answer)
	return len([]rune(text)) < 120 && (strings.Contains(text, "额度已用完") || strings.Contains(text, "开通订阅畅享"))
}

// doubaoWebReadSSE parses event/data frames; onEvent returns false to stop.
func doubaoWebReadSSE(body io.Reader, onEvent func(string, map[string]any) bool) error {
	reader := bufio.NewReaderSize(body, 64<<10)
	var event string
	var data strings.Builder
	flush := func() (bool, error) {
		defer func() { event = ""; data.Reset() }()
		if event == "" || data.Len() == 0 {
			return true, nil
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(data.String()), &payload); err != nil {
			return false, fmt.Errorf("豆包对话流里有无效数据")
		}
		return onEvent(event, payload), nil
	}
	for {
		line, err := reader.ReadString('\n')
		trimmed := strings.TrimRight(line, "\r\n")
		switch {
		case trimmed == "":
			if more, ferr := flush(); ferr != nil || !more {
				return ferr
			}
		case strings.HasPrefix(trimmed, "event:"):
			event = strings.TrimSpace(trimmed[len("event:"):])
		case strings.HasPrefix(trimmed, "data:"):
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimLeft(trimmed[len("data:"):], " "))
			if data.Len() > doubaoWebMaxFrame {
				return fmt.Errorf("豆包对话流单帧过大")
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				_, ferr := flush()
				return ferr
			}
			return err
		}
	}
}

// doubaoWebCredential asks C.le's local credential bridge for the account's cookie header.
func doubaoWebCredential(ctx context.Context, endpoint, key string) (string, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || !strings.HasPrefix(parsed.Path, "/credentials/") {
		return "", fmt.Errorf("invalid Doubao credential bridge")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(key, "Bearer ") {
		key = "Bearer " + key
	}
	req.Header.Set("Authorization", key)
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 20 * time.Second}
	defer client.CloseIdleConnections()
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("豆包凭证管理连接失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", errDoubaoWebLoginRequired
	}
	var credential struct {
		Cookie string `json:"cookie"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 256<<10)).Decode(&credential); err != nil || strings.TrimSpace(credential.Cookie) == "" {
		return "", errDoubaoWebLoginRequired
	}
	return credential.Cookie, nil
}
