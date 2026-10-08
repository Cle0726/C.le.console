package executor

// Compatibility for the pinned MIT CLIProxyAPIPlus adapters on the v7 SDK.
import (
	"context"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/usage"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
)

func plusTranslateStream(ctx context.Context, from, to sdktranslator.Format, model string, original, request, response []byte, param *any) []string {
	chunks := sdktranslator.TranslateStream(ctx, from, to, model, original, request, response, param)
	result := make([]string, len(chunks))
	for i, chunk := range chunks {
		result[i] = string(chunk)
	}
	return result
}

func plusTranslateNonStream(ctx context.Context, from, to sdktranslator.Format, model string, original, request, response []byte, param *any) string {
	return string(sdktranslator.TranslateNonStream(ctx, from, to, model, original, request, response, param))
}

func plusResponsesUsage(payload []byte) usage.Detail {
	value, _ := helps.ParseCodexUsage(payload)
	return value
}
