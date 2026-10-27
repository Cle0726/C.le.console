package executor

import (
	"context"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/util"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

func isForcedImageHostRequest(req cliproxyexecutor.Request, opts cliproxyexecutor.Options) bool {
	if isCodexOpenAIImageRequest(opts) {
		return true
	}
	if gjson.GetBytes(req.Payload, "tool_choice.type").String() != "image_generation" {
		return false
	}
	for _, tool := range gjson.GetBytes(req.Payload, "tools").Array() {
		if tool.Get("type").String() == "image_generation" {
			return true
		}
	}
	return false
}

// This retry happens inside the provider executor, after account selection and
// before the auth manager can rotate credentials. Every candidate uses the
// same auth, and ordinary text calls and non-model errors are untouched.
func imageHostFallback[T any](e *CodexExecutor, req cliproxyexecutor.Request, opts cliproxyexecutor.Options, call func(cliproxyexecutor.Request, cliproxyexecutor.Options) (T, error)) (T, error) {
	if !isForcedImageHostRequest(req, opts) {
		return call(req, opts)
	}
	directImages := isCodexOpenAIImageRequest(opts)
	configured := ""
	if e != nil && e.cfg != nil {
		configured = e.cfg.GPTImage2BaseModel
	}
	prefix := ""
	if !directImages {
		// The auth manager selects by gpt-image-2, which is registered for
		// Codex even when the configured host is absent from its model catalog.
		model := strings.TrimSpace(gjson.GetBytes(req.Payload, "model").String())
		if model == "" {
			model = strings.TrimSpace(req.Model)
		}
		if i := strings.LastIndex(model, "/"); i > 0 {
			prefix, model = model[:i+1], model[i+1:]
		}
		if strings.HasPrefix(strings.ToLower(model), "gpt-") {
			configured = model
		}
	}
	candidates := util.GPTImageHostCandidates(configured)
	var result T
	var err error
	for i, model := range candidates {
		nextReq, nextOpts := req, opts
		if directImages {
			nextOpts.Metadata = make(map[string]any, len(opts.Metadata)+1)
			for key, value := range opts.Metadata {
				nextOpts.Metadata[key] = value
			}
			nextOpts.Metadata["cle_image_host"] = model
		} else {
			nextReq.Model = prefix + model
			nextReq.Payload, err = sjson.SetBytes(req.Payload, "model", nextReq.Model)
			if err != nil {
				return result, err
			}
			if gjson.GetBytes(opts.OriginalRequest, "tool_choice.type").String() == "image_generation" {
				nextOpts.OriginalRequest, err = sjson.SetBytes(opts.OriginalRequest, "model", nextReq.Model)
				if err != nil {
					return result, err
				}
			}
		}
		result, err = call(nextReq, nextOpts)
		if err == nil || i+1 == len(candidates) || !util.UnsupportedGPTImageHost(err) {
			return result, err
		}
	}
	return result, err
}

func (e *CodexExecutor) Execute(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return imageHostFallback(e, req, opts, func(next cliproxyexecutor.Request, nextOpts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
		return e.executeOnce(ctx, auth, next, nextOpts)
	})
}

func (e *CodexExecutor) ExecuteStream(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	return imageHostFallback(e, req, opts, func(next cliproxyexecutor.Request, nextOpts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
		return e.executeStreamOnce(ctx, auth, next, nextOpts)
	})
}
