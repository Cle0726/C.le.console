package main

// Pictures and videos made by Doubao web chat, served as the OpenAI media endpoints so
// callers such as OpenClaw's image_generate (POST /v1/images/generations) and
// video_generate (POST /v1/videos, GET /v1/videos/{id}, GET /v1/videos/{id}/content)
// can use a Doubao account the user signed in to in C.le.
//
// Pictures go over plain HTTP chat: Doubao draws in the reply (block 2074).
// Videos need the signed requests of Doubao's own page, so C.le's browser window
// makes them; the gateway starts and polls that job through C.le's credential bridge.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	doubaoWebImageModel     = "doubao-web/image"
	doubaoWebVideoModel     = "doubao-web/video"
	doubaoWebImageMaxCount  = 4
	doubaoWebImageMaxBytes  = 40 << 20
	doubaoWebImageKeepBytes = 5 << 20 // larger pictures are re-encoded as JPEG (OpenClaw keeps at most 6 MB)
	doubaoWebVideoMaxBytes  = 200 << 20
	doubaoWebVideoIDPrefix  = "video_dbw_"
	doubaoWebVideoTaskTTL   = 2 * time.Hour
)

func isDoubaoWebImageModel(model string) bool {
	return strings.EqualFold(strings.TrimSpace(model), doubaoWebImageModel)
}

func isDoubaoWebVideoModel(model string) bool {
	return strings.EqualFold(strings.TrimSpace(model), doubaoWebVideoModel)
}

// doubaoWebRatio turns an OpenAI size ("1536x1024") or a ratio ("16:9") into the
// nearest ratio Doubao offers.
func doubaoWebRatio(value string, allowed []string, fallback string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" || value == "auto" {
		return fallback
	}
	for _, ratio := range allowed {
		if value == ratio {
			return ratio
		}
	}
	sep := "x"
	if strings.Contains(value, ":") {
		sep = ":"
	}
	left, right, ok := strings.Cut(value, sep)
	w, errW := strconv.ParseFloat(strings.TrimSpace(left), 64)
	h, errH := strconv.ParseFloat(strings.TrimSpace(right), 64)
	if !ok || errW != nil || errH != nil || w <= 0 || h <= 0 {
		return fallback
	}
	best, bestDiff := fallback, 1e9
	for _, ratio := range allowed {
		a, b, _ := strings.Cut(ratio, ":")
		x, _ := strconv.ParseFloat(a, 64)
		y, _ := strconv.ParseFloat(b, 64)
		diff := w/h - x/y
		if diff < 0 {
			diff = -diff
		}
		if diff < bestDiff {
			best, bestDiff = ratio, diff
		}
	}
	return best
}

var doubaoWebImageRatios = []string{"1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "21:9"}
var doubaoWebVideoRatios = []string{"1:1", "16:9", "9:16"}

func doubaoWebImagePrompt(prompt string, count int, ratio string) string {
	head := "画一张图"
	if count > 1 {
		head = fmt.Sprintf("画%d张图（每张都是完整的单独一张）", count)
	}
	return fmt.Sprintf("%s，画面比例 %s：\n%s", head, ratio, strings.TrimSpace(prompt))
}

func (s *relayServer) handleDoubaoWebImage(c *gin.Context, spec *apiKeySpec, rawJSON []byte) {
	body, model, ok := s.bodyWithValidatedModel(c, spec, rawJSON, "", nil)
	if !ok {
		return
	}
	var req struct {
		Prompt         string `json:"prompt"`
		N              int    `json:"n"`
		Size           string `json:"size"`
		AspectRatio    string `json:"aspect_ratio"`
		ResponseFormat string `json:"response_format"`
		Image          any    `json:"image"`
		Images         any    `json:"images"`
	}
	if err := json.Unmarshal(body, &req); err != nil || strings.TrimSpace(req.Prompt) == "" {
		writeAPIError(c, http.StatusBadRequest, "请填写图片提示词（prompt）", "invalid_request")
		return
	}
	if req.Image != nil || req.Images != nil {
		writeAPIError(c, http.StatusBadRequest, "豆包出图暂不支持参考图，请只用文字描述", "invalid_request")
		return
	}
	count := req.N
	if count <= 0 {
		count = 1
	}
	if count > doubaoWebImageMaxCount {
		count = doubaoWebImageMaxCount
	}
	ratio := doubaoWebRatio(firstNonEmptyString(req.AspectRatio, req.Size), doubaoWebImageRatios, "1:1")
	accounts := s.doubaoWebAccounts(spec, model)
	if len(accounts) == 0 {
		writeAPIError(c, http.StatusServiceUnavailable, "没有已登录的豆包账号；请先在 C.le 的豆包账号页用浏览器登录", "auth_unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), doubaoWebTimeout)
	defer cancel()
	first := int(doubaoWebCursor.Add(1)-1) % len(accounts)
	var lastErr error
	for i := range accounts {
		account := accounts[(first+i)%len(accounts)]
		cookie, err := doubaoWebCredential(ctx, account.Headers[doubaoWebCredentialHdr], account.UpstreamAPIKey)
		var reply *doubaoWebReply
		if err == nil {
			reply, err = newDoubaoWebClient(cookie, s.doubaoWebTransport(account)).Complete(ctx, doubaoWebImagePrompt(req.Prompt, count, ratio))
		}
		if err == nil {
			images := reply.FinishedImages()
			if len(images) == 0 {
				// Doubao answered in words: usually a refusal or a question back. Another account would say the same.
				lastErr = fmt.Errorf("豆包没有画出图片：%s", doubaoWebShort(reply.Answer))
				break
			}
			if len(images) > count {
				images = images[:count]
			}
			data := make([]any, 0, len(images))
			for _, picture := range images {
				if strings.EqualFold(req.ResponseFormat, "url") {
					data = append(data, gin.H{"url": firstNonEmptyString(picture.URL, picture.Mark), "revised_prompt": req.Prompt})
					continue
				}
				encoded, err := s.doubaoWebDownloadImage(ctx, account, picture)
				if err != nil {
					lastErr = err
					break
				}
				data = append(data, gin.H{"b64_json": encoded, "revised_prompt": req.Prompt})
			}
			if len(data) == len(images) {
				c.JSON(http.StatusOK, gin.H{"created": time.Now().Unix(), "data": data})
				return
			}
			break
		}
		lastErr = err
		if ctx.Err() != nil || !(errors.Is(err, errDoubaoWebLoginRequired) || errors.Is(err, errDoubaoWebQuotaExceeded) || errors.Is(err, errDoubaoWebRateLimited)) {
			break
		}
	}
	status, code := doubaoWebErrorStatus(lastErr)
	writeAPIError(c, status, fmt.Sprint(lastErr), code)
}

func doubaoWebShort(text string) string {
	text = strings.TrimSpace(text)
	if runes := []rune(text); len(runes) > 200 {
		return string(runes[:200]) + "…"
	}
	if text == "" {
		return "没有返回内容"
	}
	return text
}

func doubaoWebErrorStatus(err error) (int, string) {
	switch {
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return http.StatusGatewayTimeout, "doubao_web_timeout"
	case errors.Is(err, errDoubaoWebLoginRequired):
		return http.StatusUnauthorized, "doubao_login_required"
	case errors.Is(err, errDoubaoWebQuotaExceeded), errors.Is(err, errDoubaoWebRateLimited):
		return http.StatusTooManyRequests, "quota_exhausted"
	}
	return http.StatusBadGateway, "doubao_web_failed"
}

// doubaoWebDownloadImage fetches the picture and returns it base64-encoded; big
// pictures become a high-quality JPEG so callers with a size cap can keep them.
func (s *relayServer) doubaoWebDownloadImage(ctx context.Context, account *accountSpec, picture doubaoWebImage) (string, error) {
	var raw []byte
	var lastErr error
	for _, link := range []string{picture.URL, picture.Mark} {
		if link == "" {
			continue
		}
		raw, lastErr = doubaoWebFetch(ctx, s.doubaoWebTransport(account), link, doubaoWebImageMaxBytes)
		if lastErr == nil {
			break
		}
	}
	if raw == nil {
		return "", fmt.Errorf("豆包图片下载失败：%v", lastErr)
	}
	if len(raw) > doubaoWebImageKeepBytes {
		if decoded, _, err := image.Decode(bytes.NewReader(raw)); err == nil {
			var out bytes.Buffer
			if err := jpeg.Encode(&out, decoded, &jpeg.Options{Quality: 92}); err == nil && out.Len() < len(raw) {
				raw = out.Bytes()
			}
		}
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

func doubaoWebFetch(ctx context.Context, transport http.RoundTripper, link string, limit int64) ([]byte, error) {
	parsed, err := url.Parse(link)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return nil, fmt.Errorf("豆包返回的地址无效")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Referer", doubaoWebOrigin+"/")
	resp, err := (&http.Client{Transport: transport, Timeout: 3 * time.Minute}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, fmt.Errorf("文件超过 %d MB", limit>>20)
	}
	return raw, nil
}

// ---- video ----

type doubaoWebVideoTask struct {
	mu        sync.Mutex
	ID        string
	Model     string
	Ratio     string
	Created   int64
	Endpoint  string // C.le bridge job URL
	Key       string
	Transport http.RoundTripper
	Status    string // queued, in_progress, completed, failed
	VideoURL  string
	Error     string
	Touched   time.Time
}

var doubaoWebVideoTasks sync.Map // id -> *doubaoWebVideoTask

// doubaoWebVideoEndpoint turns an account's credential URL into its bridge video URL.
func doubaoWebVideoEndpoint(credentialURL string) (string, error) {
	parsed, err := url.Parse(credentialURL)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || !strings.HasPrefix(parsed.Path, "/credentials/") {
		return "", fmt.Errorf("C.le 没有提供豆包视频通道，请更新 C.le 控制台")
	}
	parsed.Path = "/video/" + strings.TrimPrefix(parsed.Path, "/credentials/")
	parsed.RawQuery = ""
	return parsed.String(), nil
}

func doubaoWebBridgeJSON(ctx context.Context, method, endpoint, key string, body any) (map[string]any, int, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, 0, err
	}
	if !strings.HasPrefix(key, "Bearer ") {
		key = "Bearer " + key
	}
	req.Header.Set("Authorization", key)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 30 * time.Second}
	defer client.CloseIdleConnections()
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("C.le 豆包视频通道连接失败：%w", err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out)
	return out, resp.StatusCode, nil
}

func (s *relayServer) handleDoubaoWebVideoCreate(c *gin.Context, spec *apiKeySpec, rawJSON []byte) {
	body, model, ok := s.bodyWithValidatedModel(c, spec, rawJSON, "", nil)
	if !ok {
		return
	}
	var req struct {
		Prompt         string `json:"prompt"`
		Size           string `json:"size"`
		AspectRatio    string `json:"aspect_ratio"`
		Ratio          string `json:"ratio"`
		InputReference any    `json:"input_reference"`
		Image          any    `json:"image"`
	}
	if err := json.Unmarshal(body, &req); err != nil || strings.TrimSpace(req.Prompt) == "" {
		writeAPIError(c, http.StatusBadRequest, "请填写视频提示词（prompt）", "invalid_request")
		return
	}
	if req.InputReference != nil || req.Image != nil {
		writeAPIError(c, http.StatusBadRequest, "豆包视频暂不支持参考图或参考视频，请只用文字描述", "invalid_request")
		return
	}
	ratio := doubaoWebRatio(firstNonEmptyString(req.Ratio, req.AspectRatio, req.Size), doubaoWebVideoRatios, "16:9")
	accounts := s.doubaoWebAccounts(spec, model)
	if len(accounts) == 0 {
		writeAPIError(c, http.StatusServiceUnavailable, "没有已登录的豆包账号；请先在 C.le 的豆包账号页用浏览器登录", "auth_unavailable")
		return
	}
	// C.le walks its own signed-in Doubao windows for videos, so one bridge call is enough.
	account := accounts[int(doubaoWebCursor.Add(1)-1)%len(accounts)]
	endpoint, err := doubaoWebVideoEndpoint(account.Headers[doubaoWebCredentialHdr])
	if err != nil {
		writeAPIError(c, http.StatusServiceUnavailable, err.Error(), "auth_unavailable")
		return
	}
	out, status, err := doubaoWebBridgeJSON(c.Request.Context(), http.MethodPost, endpoint, account.UpstreamAPIKey, gin.H{"prompt": strings.TrimSpace(req.Prompt), "ratio": ratio})
	if err == nil && status == http.StatusNotFound {
		err = fmt.Errorf("C.le 没有提供豆包视频通道，请更新 C.le 控制台")
	}
	job := stringFieldFromAny(out["task"])
	if err == nil && (status != http.StatusOK || job == "") {
		err = fmt.Errorf("C.le 没能开始豆包视频任务：%s", firstNonEmptyString(stringFieldFromAny(out["error"]), fmt.Sprintf("HTTP %d", status)))
	}
	if err != nil {
		writeAPIError(c, http.StatusBadGateway, err.Error(), "doubao_web_failed")
		return
	}
	task := &doubaoWebVideoTask{ID: doubaoWebVideoIDPrefix + job, Model: model, Ratio: ratio, Created: time.Now().Unix(),
		Endpoint: endpoint + "?task=" + url.QueryEscape(job), Key: account.UpstreamAPIKey, Transport: s.doubaoWebTransport(account),
		Status: "queued", Touched: time.Now()}
	doubaoWebVideoTasks.Store(task.ID, task)
	doubaoWebForgetOldVideos()
	c.JSON(http.StatusOK, task.object())
}

func doubaoWebForgetOldVideos() {
	doubaoWebVideoTasks.Range(func(key, value any) bool {
		task := value.(*doubaoWebVideoTask)
		task.mu.Lock()
		old := time.Since(task.Touched) > doubaoWebVideoTaskTTL
		task.mu.Unlock()
		if old {
			doubaoWebVideoTasks.Delete(key)
		}
		return true
	})
}

func (t *doubaoWebVideoTask) object() gin.H {
	out := gin.H{"id": t.ID, "object": "video", "model": t.Model, "status": t.Status, "created_at": t.Created, "aspect_ratio": t.Ratio,
		"progress": map[string]int{"queued": 0, "in_progress": 50, "completed": 100, "failed": 100}[t.Status]}
	if t.Status == "failed" {
		out["error"] = gin.H{"code": "doubao_web_failed", "message": t.Error}
	}
	return out
}

// refresh asks C.le how the job is going; a finished job is not asked again.
func (t *doubaoWebVideoTask) refresh(ctx context.Context) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.Touched = time.Now()
	if t.Status == "completed" || t.Status == "failed" {
		return
	}
	out, status, err := doubaoWebBridgeJSON(ctx, http.MethodGet, t.Endpoint, t.Key, nil)
	switch {
	case err != nil:
		return // C.le may be restarting; keep the job running and let the caller poll again
	case status == http.StatusNotFound:
		t.Status, t.Error = "failed", "C.le 已经没有这个视频任务（可能重启过），请重新生成"
		return
	case status != http.StatusOK:
		return
	}
	switch stringFieldFromAny(out["status"]) {
	case "success":
		if link := doubaoWebVideoLink(out["result"]); link != "" {
			t.Status, t.VideoURL = "completed", link
		} else {
			t.Status, t.Error = "failed", "豆包视频任务完成但没有返回视频地址"
		}
	case "error":
		t.Status, t.Error = "failed", doubaoWebVideoError(firstNonEmptyString(stringFieldFromAny(out["error"]), "豆包视频生成失败"))
	default:
		t.Status = "in_progress"
	}
}

// doubaoWebVideoError turns Doubao's raw rejections into what the user can act on.
func doubaoWebVideoError(message string) string {
	switch {
	case strings.Contains(message, "710022004") || strings.Contains(message, `\"type\":\"verify\"`) || strings.Contains(message, `"type":"verify"`):
		return "豆包要求人机验证（验证码），自动生成视频被拦下。请在 C.le 打开该豆包账号的网页窗口，手动生成一次视频并完成验证后再试。"
	case strings.Contains(message, "710022002") || strings.Contains(message, "访问频繁"):
		return "豆包账号访问过于频繁，请稍后再试。"
	}
	if runes := []rune(message); len(runes) > 400 {
		return string(runes[:400]) + "…"
	}
	return message
}

func doubaoWebVideoLink(result any) string {
	object, _ := result.(map[string]any)
	list, _ := object["data"].([]any)
	for _, item := range list {
		entry, _ := item.(map[string]any)
		if link := firstNonEmptyString(stringFieldFromAny(entry["video_url"]), stringFieldFromAny(entry["url"])); strings.HasPrefix(link, "https://") || strings.HasPrefix(link, "http://") {
			return link
		}
	}
	return ""
}

func doubaoWebVideoTaskFor(c *gin.Context) (*doubaoWebVideoTask, bool) {
	value, ok := doubaoWebVideoTasks.Load(strings.TrimSpace(c.Param("video_id")))
	if !ok {
		writeAPIError(c, http.StatusNotFound, "没有这个豆包视频任务（网关重启后旧任务会丢失）", "not_found")
		return nil, false
	}
	return value.(*doubaoWebVideoTask), true
}

func (s *relayServer) handleDoubaoWebVideoRetrieve(c *gin.Context) {
	if _, ok := s.requireAPIKey(c); !ok {
		return
	}
	task, ok := doubaoWebVideoTaskFor(c)
	if !ok {
		return
	}
	task.refresh(c.Request.Context())
	task.mu.Lock()
	defer task.mu.Unlock()
	c.JSON(http.StatusOK, task.object())
}

func (s *relayServer) handleVideosContent(c *gin.Context) {
	if _, ok := s.requireAPIKey(c); !ok {
		return
	}
	if !strings.HasPrefix(c.Param("video_id"), doubaoWebVideoIDPrefix) {
		writeAPIError(c, http.StatusNotFound, "endpoint not supported", "not_found")
		return
	}
	task, ok := doubaoWebVideoTaskFor(c)
	if !ok {
		return
	}
	task.refresh(c.Request.Context())
	task.mu.Lock()
	link, status, transport := task.VideoURL, task.Status, task.Transport
	task.mu.Unlock()
	if status != "completed" || link == "" {
		writeAPIError(c, http.StatusConflict, "豆包视频还没有生成完成", "video_not_ready")
		return
	}
	raw, err := doubaoWebFetch(c.Request.Context(), transport, link, doubaoWebVideoMaxBytes)
	if err != nil {
		writeAPIError(c, http.StatusBadGateway, "豆包视频下载失败："+err.Error(), "doubao_web_failed")
		return
	}
	c.Data(http.StatusOK, "video/mp4", raw)
}
