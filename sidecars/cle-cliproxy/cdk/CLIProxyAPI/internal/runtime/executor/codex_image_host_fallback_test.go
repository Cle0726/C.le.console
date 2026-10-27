package executor

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	"github.com/tidwall/gjson"
)

func TestImageHostFallsBackOnSameAccountThroughRealHTTP(t *testing.T) {
	var models, authorizations []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		models = append(models, gjson.GetBytes(body, "model").String())
		authorizations = append(authorizations, r.Header.Get("Authorization"))
		if len(models) < 3 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"code":"model_not_found"}}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: " + `{"type":"response.done","response":{"id":"test","output":[{"type":"image_generation_call","result":"AA==","output_format":"png"}]}}` + "\n\n"))
	}))
	defer server.Close()
	e := NewCodexExecutor(&config.Config{})
	auth := &cliproxyauth.Auth{Attributes: map[string]string{"base_url": server.URL, "api_key": "test-key"}}
	response, err := e.Execute(context.Background(), auth, cliproxyexecutor.Request{
		Model: "gpt-image-2", Payload: []byte(`{"model":"gpt-image-2","prompt":"draw"}`),
	}, codexOpenAIImageTestOptions(false))
	if err != nil {
		t.Fatal(err)
	}
	if got := gjson.GetBytes(response.Payload, "data.0.b64_json").String(); got != "AA==" {
		t.Fatalf("image missing: %s", response.Payload)
	}
	if !reflect.DeepEqual(models, []string{"gpt-6-luna", "gpt-5.6-terra", "gpt-6-sol"}) {
		t.Fatalf("wrong fallback order: %v", models)
	}
	if len(authorizations) != 3 || authorizations[0] == "" || authorizations[0] != authorizations[1] || authorizations[1] != authorizations[2] {
		t.Fatal("host retries did not preserve the selected account")
	}
}

func TestImageHostFallbackHonorsConfiguredHostAndOnlyRetriesModelErrors(t *testing.T) {
	e := NewCodexExecutor(&config.Config{})
	e.cfg.GPTImage2BaseModel = "gpt-custom"
	req := cliproxyexecutor.Request{Model: "gpt-image-2", Payload: []byte(`{"model":"gpt-image-2","prompt":"draw"}`)}
	opts := codexOpenAIImageTestOptions(false)
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
