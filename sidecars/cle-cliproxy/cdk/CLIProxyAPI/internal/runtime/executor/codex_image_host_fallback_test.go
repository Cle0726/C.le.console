package executor

import (
	"reflect"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

func TestImageHostFallbackHonorsConfiguredHostAndOnlyRetriesModelErrors(t *testing.T) {
	e := NewCodexExecutor(&config.Config{})
	e.cfg.GPTImage2BaseModel = "gpt-custom"
	req := cliproxyexecutor.Request{Model: "gpt-image-2", Payload: []byte(`{"model":"gpt-image-2","prompt":"draw"}`)}
	opts := codexOpenAIImageTestOptions(codexImagesGenerationsPath, false)
	var models []string
	_, err := imageHostFallback(e, req, opts, func(_ cliproxyexecutor.Request, o cliproxyexecutor.Options) (string, error) {
		models = append(models, o.Metadata["cle_image_host"].(string))
		if len(models) == 1 {
			return "", statusErr{code: 400, msg: `{"code":"model_not_found"}`}
		}
		return "ok", nil
	})
	if err != nil || !reflect.DeepEqual(models, []string{"gpt-custom", "gpt-6-luna"}) {
		t.Fatalf("custom fallback: %v %v", models, err)
	}
	models = nil
	_, err = imageHostFallback(e, req, opts, func(_ cliproxyexecutor.Request, o cliproxyexecutor.Options) (string, error) {
		models = append(models, o.Metadata["cle_image_host"].(string))
		return "", statusErr{code: 400, msg: "image_generation_not_enabled"}
	})
	if err == nil || len(models) != 1 {
		t.Fatalf("non-model error was retried: %v %v", models, err)
	}
}

func TestImageHostFallbackUsesPayloadHostAfterImageAccountSelection(t *testing.T) {
	e := NewCodexExecutor(&config.Config{})
	req := cliproxyexecutor.Request{Model: "team/gpt-image-2", Payload: []byte(`{"model":"team/gpt-custom","tool_choice":{"type":"image_generation"},"tools":[{"type":"image_generation"}]}`)}
	var models []string
	_, err := imageHostFallback(e, req, cliproxyexecutor.Options{}, func(r cliproxyexecutor.Request, _ cliproxyexecutor.Options) (string, error) {
		models = append(models, r.Model)
		if len(models) == 1 {
			return "", statusErr{code: 400, msg: "model_not_found"}
		}
		return "ok", nil
	})
	if err != nil || !reflect.DeepEqual(models, []string{"team/gpt-custom", "team/gpt-6-luna"}) {
		t.Fatalf("routing model displaced configured host: %v %v", models, err)
	}
}
