package executor

// C.le: native Gemini/Veo video generation. The sidecar builds the
// predictLongRunning payload itself, so the executor forwards it unchanged and
// returns the raw long-running operation.

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

func geminiExecutorAction(req cliproxyexecutor.Request) string {
	if req.Metadata != nil {
		if action, _ := req.Metadata["action"].(string); action != "" {
			switch action {
			case "countTokens", "predictLongRunning":
				return action
			}
		}
	}
	return "generateContent"
}

func (e *GeminiExecutor) executePredictLongRunning(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (resp cliproxyexecutor.Response, err error) {
	baseModel := thinking.ParseSuffix(req.Model).ModelName
	reporter := helps.NewExecutorUsageReporter(ctx, e, baseModel, auth)
	defer reporter.TrackFailure(ctx, &err)

	url := fmt.Sprintf("%s/%s/models/%s:predictLongRunning", resolveGeminiBaseURL(auth), glAPIVersion, baseModel)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(req.Payload))
	if err != nil {
		return resp, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if apiKey := geminiAPIKey(auth); apiKey != "" {
		httpReq.Header.Set("x-goog-api-key", apiKey)
	}
	applyGeminiHeaders(httpReq, auth, opts.Headers)
	helps.RecordAPIRequest(ctx, e.cfg, helps.UpstreamRequestLog{
		URL:      url,
		Method:   http.MethodPost,
		Headers:  httpReq.Header.Clone(),
		Body:     req.Payload,
		Provider: e.Identifier(),
	})

	httpClient := reporter.TrackHTTPClient(helps.NewProxyAwareHTTPClient(ctx, e.cfg, auth, 0))
	httpResp, err := httpClient.Do(httpReq)
	if err != nil {
		helps.RecordAPIResponseError(ctx, e.cfg, err)
		return resp, err
	}
	defer func() { _ = httpResp.Body.Close() }()
	helps.RecordAPIResponseMetadata(ctx, e.cfg, httpResp.StatusCode, httpResp.Header.Clone())
	data, err := io.ReadAll(httpResp.Body)
	helps.AppendAPIResponseChunk(ctx, e.cfg, data)
	if err != nil {
		helps.RecordAPIResponseError(ctx, e.cfg, err)
		return resp, err
	}
	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		return resp, newGeminiStatusErr(httpResp.StatusCode, httpResp.Header, data)
	}
	return cliproxyexecutor.Response{Payload: data, Headers: httpResp.Header.Clone()}, nil
}
