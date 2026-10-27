package main

import (
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestWorkbuddyTokenLimitsReachEveryClientCatalogWithoutInflatingSmallerModels(t *testing.T) {
	m := &manifest{
		Accounts: []accountSpec{{ID: "first", Provider: "workbuddy", Models: []string{"workbuddy/large", "workbuddy/small"}, ModelLimits: map[string]modelTokenLimits{
			"workbuddy/large": {MaxInputTokens: 1000000, MaxOutputTokens: 128000},
			"workbuddy/small": {MaxInputTokens: 192000, MaxOutputTokens: 64000},
		}}},
	}
	models := []string{"workbuddy/large", "workbuddy/small", "unknown"}
	openAI := modelsResponseWithTokenLimits(m, nil, models, false)["data"].([]gin.H)
	if openAI[0]["context_length"] != 1000000 || openAI[0]["max_output_tokens"] != 128000 || openAI[1]["context_window"] != 192000 {
		t.Fatalf("OpenAI lost real limits: %#v", openAI)
	}
	if _, exists := openAI[2]["context_length"]; exists {
		t.Fatal("invented a capacity for an unknown model")
	}
	codex := modelsResponseWithTokenLimits(m, nil, models[:2], true)["models"].([]map[string]any)
	if codex[0]["context_window"] != 1000000 || codex[1]["context_window"] != 192000 || codex[1]["max_context_window"] != 192000 {
		t.Fatalf("Codex retained generic defaults: %#v", codex)
	}
	gemini := geminiModelsResponseWithTokenLimits(m, nil, models[:2])["models"].([]gin.H)
	if gemini[1]["inputTokenLimit"] != 192000 || gemini[1]["outputTokenLimit"] != 64000 {
		t.Fatalf("Gemini retained generic defaults: %#v", gemini)
	}
	if geminiModelEntryWithTokenLimits(m, nil, models[1])["inputTokenLimit"] != 192000 {
		t.Fatal("single-model Gemini endpoint retained generic defaults")
	}
	ollama := ollamaShowResponseWithTokenLimits(m, nil, models[0], time.Now())
	if ollama["parameters"] != "num_ctx 1000000" || ollama["model_info"].(gin.H)["context_length"] != 1000000 {
		t.Fatalf("Ollama retained 131072 fallback: %#v", ollama)
	}
	registered := manifestRegistryModelsForAccount(m, &m.Accounts[0], "workbuddy")
	if registered[0].ContextLength != 1000000 || registered[1].MaxCompletionTokens != 64000 {
		t.Fatal("native registry lost limits")
	}
}

func TestWorkbuddyTokenLimitsRespectAliasesPrefixesAndKeyAccountScope(t *testing.T) {
	m := &manifest{
		Accounts: []accountSpec{
			{ID: "large", Models: []string{"workbuddy/model"}, ModelLimits: map[string]modelTokenLimits{"workbuddy/model": {MaxInputTokens: 1000000, MaxOutputTokens: 128000}}},
			{ID: "small", AuthID: "small-auth", Models: []string{"workbuddy/model"}, ModelLimits: map[string]modelTokenLimits{"workbuddy/model": {MaxInputTokens: 200000, MaxOutputTokens: 32000}}},
		},
		aliasToSource: map[string]string{"my-model": "workbuddy/model"},
	}
	if tokenLimitsForModel(m, nil, "my-model").MaxInputTokens != 200000 {
		t.Fatal("pool advertised more than its smallest explicit account limit")
	}
	spec := &apiKeySpec{ModelPrefix: "team", AccountIDs: []string{"large"}}
	if tokenLimitsForModel(m, spec, "team/my-model").MaxInputTokens != 1000000 {
		t.Fatal("key-specific prefix, alias or account scope lost")
	}
	spec = &apiKeySpec{AccountIDs: []string{"small-auth"}}
	if tokenLimitsForModel(m, spec, "workbuddy/model").MaxOutputTokens != 32000 {
		t.Fatal("auth-ID account restriction ignored")
	}
	spec.ProviderGateway = &providerGatewaySpec{}
	if tokenLimitsForModel(m, spec, "workbuddy/model").MaxInputTokens != 0 {
		t.Fatal("borrowed capacities from an unrelated provider gateway")
	}
}

func TestKnownProviderMaximaReplaceGenericDefaultsWithoutErasingThemWithNull(t *testing.T) {
	m := &manifest{Accounts: []accountSpec{
		{ID: "claude", Provider: "claude", Models: []string{"claude-sonnet-4-6", "claude-opus-5-5"},
			ModelLimits: map[string]modelTokenLimits{"claude-sonnet-4-6": {}}},
	}}
	for _, id := range m.Accounts[0].Models {
		if got := tokenLimitsForModel(m, nil, id); got.MaxInputTokens != 1000000 || got.MaxOutputTokens != 128000 {
			t.Fatalf("%s retained a generic default: %#v", id, got)
		}
		catalog := modelsResponseWithTokenLimits(m, nil, []string{id}, true)["models"].([]map[string]any)[0]
		if catalog["context_window"] != 1000000 || catalog["max_context_window"] != 1000000 {
			t.Fatalf("client catalog lost real maximum: %#v", catalog)
		}
	}
	registered := manifestRegistryModelsForAccount(m, &m.Accounts[0], "claude")
	if registered[0].ContextLength != 1000000 || registered[0].MaxCompletionTokens != 128000 {
		t.Fatal("empty manifest capacity erased the provider metadata")
	}
	if got := staticTokenLimits("antigravity", "claude-sonnet-4-6"); got.MaxInputTokens == 1000000 {
		t.Fatal("borrowed the direct Anthropic allowance for a different channel")
	}
	if got := staticTokenLimits("custom", "claude-opus-5-5"); got.MaxInputTokens != 0 {
		t.Fatal("invented a capacity for an unknown compatible gateway")
	}
}

func TestAntigravityDiscoveredCapacityUpdatesAllCatalogsAndKeepsPoolSafe(t *testing.T) {
	model := "claude-opus-5-5-medium"
	m := &manifest{Accounts: []accountSpec{
		{ID: "large", Provider: "antigravity", Models: []string{model}, ModelLimits: map[string]modelTokenLimits{
			model: {MaxInputTokens: 1000000, MaxOutputTokens: 128000},
		}},
	}}
	entry := modelsResponseWithTokenLimits(m, nil, []string{model}, false)["data"].([]gin.H)[0]
	if entry["context_window"] != 1000000 || entry["max_output_tokens"] != 128000 {
		t.Fatalf("Antigravity upstream limits lost: %#v", entry)
	}
	codex := modelsResponseWithTokenLimits(m, nil, []string{model}, true)["models"].([]map[string]any)[0]
	if codex["max_context_window"] != 1000000 || codex["context_window"] != 1000000 {
		t.Fatalf("Codex client still sees a generic window: %#v", codex)
	}
	gemini := geminiModelEntryWithTokenLimits(m, nil, model)
	if gemini["inputTokenLimit"] != 1000000 || gemini["outputTokenLimit"] != 128000 {
		t.Fatalf("Gemini client lost discovered limits: %#v", gemini)
	}
	ollama := ollamaShowResponseWithTokenLimits(m, nil, model, time.Now())
	if ollama["parameters"] != "num_ctx 1000000" {
		t.Fatalf("Ollama client lost discovered limits: %#v", ollama)
	}
	registered := manifestRegistryModelsForAccount(m, &m.Accounts[0], "antigravity")
	if registered[0].ContextLength != 1000000 || registered[0].MaxCompletionTokens != 128000 {
		t.Fatal("native registry lost discovered Antigravity capacity")
	}
	// A changed upstream maximum replaces the old metadata without rebuilding.
	m.Accounts[0].ModelLimits[model] = modelTokenLimits{MaxInputTokens: 2000000, MaxOutputTokens: 256000}
	if tokenLimitsForModel(m, nil, model).MaxInputTokens != 2000000 {
		t.Fatal("updated upstream limit did not reach catalog")
	}
	m.Accounts = append(m.Accounts, accountSpec{ID: "smaller", Provider: "antigravity", Models: []string{model},
		ModelLimits: map[string]modelTokenLimits{model: {MaxInputTokens: 250000, MaxOutputTokens: 64000}}})
	if tokenLimitsForModel(m, nil, model).MaxInputTokens != 250000 {
		t.Fatal("mixed pool overstates the smallest known allowance")
	}
	if tokenLimitsForModel(m, &apiKeySpec{AccountIDs: []string{"large"}}, model).MaxInputTokens != 2000000 {
		t.Fatal("account-scoped key did not use that account's maximum")
	}
}

func TestGeminiNativeLimitFieldsReachClientCatalogs(t *testing.T) {
	model := "gemini-2.5-pro"
	limits := staticTokenLimits("gemini", model)
	if limits.MaxInputTokens != 1048576 || limits.MaxOutputTokens <= 0 {
		t.Fatalf("Gemini native input/output fields ignored: %#v", limits)
	}
	m := &manifest{Accounts: []accountSpec{{ID: "gemini", Provider: "gemini", Models: []string{model}}}}
	entry := modelsResponseWithTokenLimits(m, nil, []string{model}, true)["models"].([]map[string]any)[0]
	if entry["context_window"] != 1048576 || entry["max_context_window"] != 1048576 {
		t.Fatalf("Gemini received a generic client context size: %#v", entry)
	}
}
