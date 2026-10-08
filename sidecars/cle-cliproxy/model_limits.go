package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// These are account-authorized upstream limits, not client defaults or guesses.
type modelTokenLimits struct {
	MaxInputTokens  int `json:"maxInputTokens,omitempty"`
	MaxOutputTokens int `json:"maxOutputTokens,omitempty"`
}

func tokenLimitsForModel(m *manifest, spec *apiKeySpec, model string) modelTokenLimits {
	if m == nil || (spec != nil && spec.ProviderGateway != nil) {
		return modelTokenLimits{}
	}
	canonical := canonicalModelForClientModel(m, spec, model)
	var limits modelTokenLimits
	minimum := func(current, next int) int {
		if next > 0 && (current <= 0 || next < current) {
			return next
		}
		return current
	}
	for _, account := range m.Accounts {
		if spec != nil && len(spec.AccountIDs) > 0 &&
			!stringSliceContainsFold(spec.AccountIDs, account.ID) &&
			!stringSliceContainsFold(spec.AccountIDs, account.AuthID) {
			continue
		}
		for id, capacity := range account.ModelLimits {
			if !strings.EqualFold(id, canonical) || !stringSliceContainsFold(account.Models, id) {
				continue
			}
			// A rotating pool must not advertise a capacity that one of its
			// participating accounts explicitly cannot accept.
			limits.MaxInputTokens = minimum(limits.MaxInputTokens, capacity.MaxInputTokens)
			limits.MaxOutputTokens = minimum(limits.MaxOutputTokens, capacity.MaxOutputTokens)
		}
	}
	return limits
}

func setModelTokenLimits(model map[string]any, limits modelTokenLimits) {
	if limits.MaxInputTokens > 0 {
		model["context_length"] = limits.MaxInputTokens
		model["context_window"] = limits.MaxInputTokens
		model["max_input_tokens"] = limits.MaxInputTokens
		model["maxInputTokens"] = limits.MaxInputTokens
	}
	if limits.MaxOutputTokens > 0 {
		model["max_completion_tokens"] = limits.MaxOutputTokens
		model["max_output_tokens"] = limits.MaxOutputTokens
		model["maxOutputTokens"] = limits.MaxOutputTokens
	}
}

func modelsResponseWithTokenLimits(m *manifest, spec *apiKeySpec, models []string, codex bool) gin.H {
	if codex {
		response := buildCodexClientModelsResponse(models)
		entries, _ := response["models"].([]map[string]any)
		for _, entry := range entries {
			id, _ := entry["slug"].(string)
			limits := tokenLimitsForModel(m, spec, id)
			setModelTokenLimits(entry, limits)
			if limits.MaxInputTokens > 0 {
				entry["max_context_window"] = limits.MaxInputTokens
			}
		}
		return response
	}
	response := buildModelsResponse(models)
	entries, _ := response["data"].([]gin.H)
	for _, entry := range entries {
		id, _ := entry["id"].(string)
		limits := tokenLimitsForModel(m, spec, id)
		setModelTokenLimits(entry, limits)
		if strings.HasPrefix(canonicalModelForClientModel(m, spec, id), "workbuddy/") {
			entry["owned_by"] = "workbuddy"
		}
	}
	return response
}

func geminiModelsResponseWithTokenLimits(m *manifest, spec *apiKeySpec, models []string) gin.H {
	entries := make([]gin.H, 0, len(models))
	for _, model := range models {
		entries = append(entries, geminiModelEntryWithTokenLimits(m, spec, model))
	}
	return gin.H{"models": entries}
}

func geminiModelEntryWithTokenLimits(m *manifest, spec *apiKeySpec, model string) gin.H {
	entry := buildGeminiModelEntry(model)
	limits := tokenLimitsForModel(m, spec, model)
	if limits.MaxInputTokens > 0 {
		entry["inputTokenLimit"] = limits.MaxInputTokens
	}
	if limits.MaxOutputTokens > 0 {
		entry["outputTokenLimit"] = limits.MaxOutputTokens
	}
	return entry
}

func ollamaShowResponseWithTokenLimits(m *manifest, spec *apiKeySpec, model string, modifiedAt time.Time) gin.H {
	response := buildOllamaShowResponse(model, modifiedAt)
	limits := tokenLimitsForModel(m, spec, model)
	if limits.MaxInputTokens > 0 {
		response["parameters"] = fmt.Sprintf("num_ctx %d", limits.MaxInputTokens)
		info := response["model_info"].(gin.H)
		info["context_length"] = limits.MaxInputTokens
		info[ollamaModelFamily(model)+".context_length"] = limits.MaxInputTokens
	}
	return response
}
