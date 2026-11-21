package executor

// C.le: keep the video endpoint selected by the public gateway for
// OpenAI-compatible (xAI) accounts instead of sending video payloads to
// /chat/completions.

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/util"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"github.com/tidwall/gjson"
)

const (
	openAICompatVideoHandlerType      = "openai-video"
	openAICompatVideosGenerationsPath = "/videos/generations"
	openAICompatVideosEditsPath       = "/videos/edits"
	openAICompatVideosExtensionsPath  = "/videos/extensions"
	openAICompatVideosPath            = "/videos"
)

func (e *OpenAICompatExecutor) executeVideos(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (resp cliproxyexecutor.Response, err error) {
	baseURL, apiKey := e.resolveCredentials(auth)
	if baseURL == "" {
		return resp, statusErr{code: http.StatusUnauthorized, msg: "missing provider baseURL"}
	}
	method := http.MethodPost
	endpointPath := openAICompatVideosGenerationsPath
	var body io.Reader = bytes.NewReader(req.Payload)
	switch path := openAICompatVideoEndpointPath(opts); path {
	case openAICompatVideosGenerationsPath, openAICompatVideosEditsPath, openAICompatVideosExtensionsPath:
		endpointPath = path
	default:
		if requestID := strings.TrimSpace(gjson.GetBytes(req.Payload, "request_id").String()); requestID != "" {
			method = http.MethodGet
			endpointPath = openAICompatVideosPath + "/" + url.PathEscape(requestID)
			body = nil
		}
	}
	requestURL := strings.TrimSuffix(baseURL, "/") + endpointPath
	httpReq, err := http.NewRequestWithContext(ctx, method, requestURL, body)
	if err != nil {
		return resp, err
	}
	httpReq.Header.Set("Accept", "application/json")
	if method == http.MethodPost {
		httpReq.Header.Set("Content-Type", "application/json")
	}
	if apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	}
	var attrs map[string]string
	if auth != nil {
		attrs = auth.Attributes
	}
	util.ApplyCustomHeadersFromAttrs(httpReq, attrs)
	httpResp, err := helps.NewProxyAwareHTTPClient(ctx, e.cfg, auth, 0).Do(httpReq)
	if err != nil {
		return resp, err
	}
	defer func() { _ = httpResp.Body.Close() }()
	payload, err := io.ReadAll(httpResp.Body)
	if err != nil {
		return resp, err
	}
	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		return resp, statusErr{code: httpResp.StatusCode, msg: string(payload)}
	}
	return cliproxyexecutor.Response{Payload: payload, Headers: httpResp.Header.Clone()}, nil
}

func openAICompatIsVideoRequest(opts cliproxyexecutor.Options) bool {
	return opts.SourceFormat.String() == openAICompatVideoHandlerType
}

func openAICompatVideoEndpointPath(opts cliproxyexecutor.Options) string {
	if !openAICompatIsVideoRequest(opts) {
		return ""
	}
	path := strings.TrimSpace(fmt.Sprint(opts.Metadata[cliproxyexecutor.RequestPathMetadataKey]))
	switch {
	case strings.HasSuffix(path, "/videos/edits"):
		return openAICompatVideosEditsPath
	case strings.HasSuffix(path, "/videos/extensions"):
		return openAICompatVideosExtensionsPath
	case strings.HasSuffix(path, "/videos/generations"):
		return openAICompatVideosGenerationsPath
	}
	return ""
}
