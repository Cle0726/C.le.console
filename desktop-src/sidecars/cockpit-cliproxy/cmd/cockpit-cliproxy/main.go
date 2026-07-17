package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"

	"claude-web-gateway-sidecar/internal/claudeweb"
	"claude-web-gateway-sidecar/internal/config"
	httpapi "claude-web-gateway-sidecar/internal/http"
)

func main() {
	configPath := flag.String("config", "", "path to sidecar config json")
	runtimePath := flag.String("runtime-state", "", "path to runtime state json")
	flag.Parse()
	if *configPath == "" {
		log.Fatal("missing --config")
	}
	if *runtimePath == "" {
		log.Fatal("missing --runtime-state")
	}
	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	scheduler := claudeweb.NewScheduler(cfg, *runtimePath)
	service := httpapi.NewService(cfg, scheduler, *runtimePath)
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", service.HandleHealth)
	mux.HandleFunc("/v1/models", service.HandleModels)
	mux.HandleFunc("/v1/chat/completions", service.HandleChatCompletions)
	mux.HandleFunc("/_gateway/runtime", service.HandleRuntime)
	server := &http.Server{Addr: fmt.Sprintf("%s:%d", cfg.ListenHost, cfg.ListenPort), Handler: withMiddleware(cfg, mux)}
	log.Printf("cockpit-cliproxy claude-web gateway listening on http://%s:%d", cfg.ListenHost, cfg.ListenPort)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("listen and serve: %v", err)
	}
}

func withMiddleware(cfg *config.GatewayConfig, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackRequest(r.RemoteAddr) {
			http.Error(w, "localhost only", http.StatusForbidden)
			return
		}
		if cfg.RequireAPIKey {
			authorization := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer"))
			xAPIKey := strings.TrimSpace(r.Header.Get("x-api-key"))
			if authorization != cfg.LocalAPIKey && xAPIKey != cfg.LocalAPIKey {
				http.Error(w, "invalid api key", http.StatusUnauthorized)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func isLoopbackRequest(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
