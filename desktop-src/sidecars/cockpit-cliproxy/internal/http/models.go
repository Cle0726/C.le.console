package httpapi

import "claude-web-gateway-sidecar/internal/config"

type HealthResponse struct {
	Status        string `json:"status"`
	AccountsCount int    `json:"accountsCount"`
	ModelsCount   int    `json:"modelsCount"`
}

type ModelsResponse struct {
	Object string             `json:"object"`
	Data   []config.ModelInfo `json:"data"`
}
