package util

import (
	"errors"
	"strings"
)

const DefaultGPTImageHost = "gpt-6-luna"

// GPTImageHostCandidates preserves a configured valid host while retaining
// account-local fallbacks for hosts removed by the upstream provider.
func GPTImageHostCandidates(configured string) []string {
	var models []string
	configured = strings.TrimSpace(configured)
	if strings.HasPrefix(strings.ToLower(configured), "gpt-") {
		models = append(models, configured)
	}
	for _, model := range []string{DefaultGPTImageHost, "gpt-5.6-terra", "gpt-6-sol"} {
		exists := false
		for _, old := range models {
			if strings.EqualFold(old, model) {
				exists = true
				break
			}
		}
		if !exists {
			models = append(models, model)
		}
	}
	return models
}

func UnsupportedGPTImageHost(err error) bool {
	if err == nil {
		return false
	}
	var status interface{ StatusCode() int }
	if !errors.As(err, &status) || status.StatusCode() != 400 {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "model_not_found") || strings.Contains(message, "is not supported when using codex")
}
