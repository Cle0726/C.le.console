package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	runtimeexecutor "github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	executor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

const managedCredentialHeader = "X-Cle-Managed-Credential-URL"

// Selection/retries/translation stay in CLIProxyAPI; C.le owns account tokens.
type managedNativeExecutor struct{ coreauth.ProviderExecutor }

func newManagedNativeExecutor(provider string, cfg *config.Config) coreauth.ProviderExecutor {
	var native coreauth.ProviderExecutor
	switch provider {
	case "kiro":
		kiro := runtimeexecutor.NewKiroExecutor(cfg)
		kiro.ManagedRefresh = func(ctx context.Context, auth *coreauth.Auth) (*coreauth.Auth, error) {
			return prepareManagedNativeAuth(ctx, auth, true)
		}
		native = kiro
	case "github-copilot":
		native = runtimeexecutor.NewGitHubCopilotExecutor(cfg)
	default:
		panic("unsupported native provider")
	}
	return &managedNativeExecutor{ProviderExecutor: native}
}

func prepareManagedNativeAuth(ctx context.Context, auth *coreauth.Auth, refresh bool) (*coreauth.Auth, error) {
	if auth == nil {
		return nil, fmt.Errorf("missing managed account")
	}
	endpoint := auth.Attributes["cle_managed_credential_url"]
	if endpoint == "" {
		endpoint = auth.Attributes["header:"+managedCredentialHeader]
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || (auth.Provider != "kiro" && auth.Provider != "github-copilot") || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || !strings.HasPrefix(parsed.Path, "/credentials/"+auth.Provider+"~") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("invalid managed credential bridge")
	}
	id := strings.TrimPrefix(parsed.Path, "/credentials/"+auth.Provider+"~")
	if id == "" || strings.ContainsAny(id, "/%\\") {
		return nil, fmt.Errorf("invalid managed account ID")
	}
	if refresh {
		parsed.RawQuery = "refresh=1"
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+auth.Attributes["api_key"])
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 40 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("C.le 凭证管理连接失败")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s 登录不可用，请刷新账号或重新登录", auth.Provider)
	}
	var payload struct {
		Metadata map[string]any `json:"metadata"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&payload) != nil {
		return nil, fmt.Errorf("missing managed credential")
	}
	if token, ok := payload.Metadata["access_token"].(string); !ok || strings.TrimSpace(token) == "" {
		return nil, fmt.Errorf("missing managed credential")
	}
	copy := auth.Clone()
	copy.Metadata = payload.Metadata
	copy.Attributes["cle_managed_credential_url"] = endpoint
	// Never forward the loopback capability URL to the remote provider.
	delete(copy.Attributes, "header:"+managedCredentialHeader)
	return copy, nil
}

func (e *managedNativeExecutor) Execute(ctx context.Context, auth *coreauth.Auth, req executor.Request, opts executor.Options) (executor.Response, error) {
	fresh, err := prepareManagedNativeAuth(ctx, auth, false)
	if err != nil {
		return executor.Response{}, err
	}
	return e.ProviderExecutor.Execute(ctx, fresh, req, opts)
}
func (e *managedNativeExecutor) ExecuteStream(ctx context.Context, auth *coreauth.Auth, req executor.Request, opts executor.Options) (*executor.StreamResult, error) {
	fresh, err := prepareManagedNativeAuth(ctx, auth, false)
	if err != nil {
		return nil, err
	}
	return e.ProviderExecutor.ExecuteStream(ctx, fresh, req, opts)
}
func (e *managedNativeExecutor) Refresh(ctx context.Context, auth *coreauth.Auth) (*coreauth.Auth, error) {
	_, err := prepareManagedNativeAuth(ctx, auth, true)
	if err != nil {
		return nil, err
	}
	// The manager may persist Refresh results. Persist only the bridge capability,
	// not a second copy of C.le's rotating OAuth access token.
	return auth.Clone(), nil
}
func (e *managedNativeExecutor) HttpRequest(ctx context.Context, auth *coreauth.Auth, req *http.Request) (*http.Response, error) {
	fresh, err := prepareManagedNativeAuth(ctx, auth, false)
	if err != nil {
		return nil, err
	}
	return e.ProviderExecutor.HttpRequest(ctx, fresh, req)
}
