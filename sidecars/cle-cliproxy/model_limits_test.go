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
