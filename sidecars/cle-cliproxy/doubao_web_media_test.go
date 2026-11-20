package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

func TestDoubaoWebRatioPicksNearestOffered(t *testing.T) {
	cases := map[string]string{"": "1:1", "auto": "1:1", "1024x1024": "1:1", "1536x1024": "3:2", "1024x1536": "2:3",
		"1792x1024": "16:9", "720x1280": "9:16", "16:9": "16:9", "2048x1152": "16:9", "bad": "1:1"}
	for in, want := range cases {
		if got := doubaoWebRatio(in, doubaoWebImageRatios, "1:1"); got != want {
			t.Fatalf("image %q -> %q, want %q", in, got, want)
		}
	}
	for in, want := range map[string]string{"": "16:9", "720x1280": "9:16", "1024x1792": "9:16", "1280x720": "16:9", "1024x1024": "1:1", "4:3": "1:1"} {
		if got := doubaoWebRatio(in, doubaoWebVideoRatios, "16:9"); got != want {
			t.Fatalf("video %q -> %q, want %q", in, got, want)
		}
	}
}

func doubaoWebCreationChunk(status int, raw, marked string) string {
	image := map[string]any{"status": status, "placeholder": map[string]any{"width": 1728, "height": 2304}}
	if raw != "" {
		image["image_ori_raw"] = map[string]any{"url": raw, "width": 1728, "height": 2304}
		image["image_ori"] = map[string]any{"url": marked, "width": 1728, "height": 2304}
	}
	body, _ := json.Marshal(map[string]any{"patch_op": []any{map[string]any{"patch_value": map[string]any{"content_block": []any{
		map[string]any{"block_type": 2074, "content": map[string]any{"creation_block": map[string]any{"creations": []any{
			map[string]any{"type": 1, "id": "c1", "image": image}}}}},
	}}}}})
	return "event: STREAM_CHUNK\ndata: " + string(body) + "\n\n"
}

// As seen live: a drawing reply has no text, and the creation arrives first as a
// placeholder (status 1) and then finished (status 2) under the same ID.
func TestDoubaoWebCompleteCollectsDrawnImages(t *testing.T) {
	rt := doubaoWebSSE(200, doubaoWebAck+doubaoWebCreationChunk(1, "", "")+doubaoWebCreationChunk(2, "https://img/raw.png", "https://img/mark.png")+
		"event: SSE_REPLY_END\ndata: {\"end_type\":3}\n\n")
	reply, err := newDoubaoWebClient(doubaoWebTestCookie, rt).Complete(context.Background(), doubaoWebImagePrompt("cat", 1, "1:1"))
	if err != nil {
		t.Fatal(err)
	}
	images := reply.FinishedImages()
	if len(reply.Images) != 1 || len(images) != 1 || images[0].URL != "https://img/raw.png" || images[0].Mark != "https://img/mark.png" || images[0].Width != 1728 {
		t.Fatalf("images %+v", reply.Images)
	}
	unfinished := doubaoWebSSE(200, doubaoWebAck+doubaoWebCreationChunk(1, "", ""))
	reply, err = newDoubaoWebClient(doubaoWebTestCookie, unfinished).Complete(context.Background(), "x")
	if err != nil || len(reply.FinishedImages()) != 0 {
		t.Fatalf("a placeholder is not a picture: %+v %v", reply, err)
	}
	if !strings.Contains(doubaoWebImagePrompt("cat", 3, "16:9"), "画3张图") {
		t.Fatal("several pictures must be asked for")
	}
}

func TestDoubaoWebFixedLevelsAreTheirOwnModels(t *testing.T) {
	for model, want := range map[string]int{"doubao-web/fast": 0, "doubao-web/think": 1, "Doubao-Web/Expert": 3} {
		level, ok := doubaoWebFixedThink(model)
		if !ok || level != want || doubaoWebModelKey(model) != "" {
			t.Fatalf("%s -> %d %v key %q", model, level, ok, doubaoWebModelKey(model))
		}
	}
	for _, model := range []string{"doubao-web/auto", "doubao-web/seed-lite-7b", "fast", "workbuddy/fast"} {
		if _, ok := doubaoWebFixedThink(model); ok {
			t.Fatalf("%s is not a fixed level", model)
		}
	}
	body := doubaoWebChatBody("hi", doubaoWebModelKey("doubao-web/think"), 1)
	if body["option"].(map[string]any)["need_deep_think"] != 1 || body["ext"].(map[string]any)["use_deep_think"] != "1" || body["option"].(map[string]any)["model_config"] != nil {
		t.Fatalf("think body %v", body["option"])
	}
}

func newDoubaoWebMediaTestRouter(accounts []accountSpec) *gin.Engine {
	spec := apiKeySpec{ID: "client-key-id", Label: "Client key", Key: "client-key", Enabled: true}
	m := &manifest{
		APIKeys: []apiKeySpec{spec}, Accounts: accounts,
		ModelIDs:  []string{doubaoWebImageModel, doubaoWebVideoModel, "doubao-web/auto"},
		Providers: []string{doubaoWebProvider}, apiKeyByValue: map[string]*apiKeySpec{"client-key": &spec},
	}
	return (&relayServer{cfg: &config.Config{}, manifest: m, policy: &requestPolicy{manifest: m}}).router()
}

func doubaoWebMediaCall(router *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer client-key")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

// The OpenAI video contract OpenClaw's video_generate uses: create, poll, download.
// C.le's bridge makes the video in its Doubao window; the gateway only relays.
func TestDoubaoWebVideoRunsThroughCleBridge(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var polls atomic.Int32
	var started map[string]any
	var bridge *httptest.Server
	bridge = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer bridge-key" {
			http.Error(w, `{"error":"auth"}`, http.StatusUnauthorized)
			return
		}
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/video/doubao-web~acc":
			_ = json.NewDecoder(r.Body).Decode(&started)
			_, _ = io.WriteString(w, `{"task":"job1"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/video/doubao-web~acc" && r.URL.Query().Get("task") == "job1":
			if polls.Add(1) == 1 {
				_, _ = io.WriteString(w, `{"status":"running"}`)
				return
			}
			_, _ = io.WriteString(w, `{"status":"success","result":{"data":[{"url":"`+bridge.URL+`/clip.mp4"}]}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer bridge.Close()
	videoBytes := "\x00\x00\x00\x18ftypmp42video"
	mux := bridge.Config.Handler
	bridge.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/clip.mp4" {
			_, _ = io.WriteString(w, videoBytes)
			return
		}
		mux.ServeHTTP(w, r)
	})
	router := newDoubaoWebMediaTestRouter([]accountSpec{{ID: "cle-doubao-web-acc", Provider: doubaoWebProvider, UpstreamAPIKey: "bridge-key",
		Models: []string{doubaoWebVideoModel}, Headers: map[string]string{doubaoWebCredentialHdr: bridge.URL + "/credentials/doubao-web~acc"}}})

	w := doubaoWebMediaCall(router, http.MethodPost, videosCreatePath, `{"model":"doubao-web/video","prompt":"小猫跳舞","size":"720x1280","seconds":"8"}`)
	var created map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	if w.Code != http.StatusOK || created["id"] != "video_dbw_job1" || created["status"] != "queued" {
		t.Fatalf("create %d %s", w.Code, w.Body.String())
	}
	if started["prompt"] != "小猫跳舞" || started["ratio"] != "9:16" {
		t.Fatalf("bridge got %v", started)
	}
	if w = doubaoWebMediaCall(router, http.MethodGet, "/v1/videos/video_dbw_job1/content", ""); w.Code != http.StatusConflict {
		t.Fatalf("content before done %d", w.Code)
	}
	w = doubaoWebMediaCall(router, http.MethodGet, "/v1/videos/video_dbw_job1", "")
	if !strings.Contains(w.Body.String(), `"status":"completed"`) {
		t.Fatalf("poll %d %s", w.Code, w.Body.String())
	}
	w = doubaoWebMediaCall(router, http.MethodGet, "/v1/videos/video_dbw_job1/content?variant=video", "")
	if w.Code != http.StatusOK || w.Body.String() != videoBytes || w.Header().Get("Content-Type") != "video/mp4" {
		t.Fatalf("content %d %q", w.Code, w.Body.String())
	}
	if w = doubaoWebMediaCall(router, http.MethodGet, "/v1/videos/video_dbw_nope", ""); w.Code != http.StatusNotFound {
		t.Fatalf("unknown job %d", w.Code)
	}
	if w = doubaoWebMediaCall(router, http.MethodPost, videosCreatePath, `{"model":"doubao-web/video","prompt":"x","input_reference":{"image_url":"data:"}}`); w.Code != http.StatusBadRequest {
		t.Fatalf("reference image must be refused clearly: %d", w.Code)
	}
}

func TestDoubaoWebVideoFailureIsReported(t *testing.T) {
	gin.SetMode(gin.TestMode)
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			_, _ = io.WriteString(w, `{"task":"job2"}`)
			return
		}
		_, _ = io.WriteString(w, `{"status":"error","error":"豆包账号池尝试失败：验证码"}`)
	}))
	defer bridge.Close()
	router := newDoubaoWebMediaTestRouter([]accountSpec{{ID: "a", Provider: doubaoWebProvider, UpstreamAPIKey: "k",
		Models: []string{doubaoWebVideoModel}, Headers: map[string]string{doubaoWebCredentialHdr: bridge.URL + "/credentials/doubao-web~a"}}})
	if w := doubaoWebMediaCall(router, http.MethodPost, videosCreatePath, `{"model":"doubao-web/video","prompt":"x"}`); w.Code != http.StatusOK {
		t.Fatalf("create %d %s", w.Code, w.Body.String())
	}
	w := doubaoWebMediaCall(router, http.MethodGet, "/v1/videos/video_dbw_job2", "")
	if !strings.Contains(w.Body.String(), `"status":"failed"`) || !strings.Contains(w.Body.String(), "验证码") {
		t.Fatalf("poll %s", w.Body.String())
	}
}

func TestDoubaoWebImageNeedsSignedInAccount(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := newDoubaoWebMediaTestRouter(nil)
	w := doubaoWebMediaCall(router, http.MethodPost, imagesGenerationsPath, `{"model":"doubao-web/image","prompt":"cat"}`)
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "豆包") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if w = doubaoWebMediaCall(router, http.MethodPost, imagesGenerationsPath, `{"model":"doubao-web/image","prompt":""}`); w.Code != http.StatusBadRequest {
		t.Fatalf("empty prompt %d", w.Code)
	}
}
