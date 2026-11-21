package cliproxy

// C.le embedded runtime: the cle-cliproxy sidecar serves its own HTTP surface
// and drives the execution runtime directly. StartRuntime mirrors Run's startup
// order without the API server, file watcher, Home mode, pprof or discovery.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
	log "github.com/sirupsen/logrus"
)

// StartRuntime starts only the embedded execution runtime without exposing the
// CLIProxyAPI HTTP server. It blocks until ctx is cancelled.
func (s *Service) StartRuntime(ctx context.Context) error {
	if s == nil {
		return fmt.Errorf("cliproxy: service is nil")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, runCancel := context.WithCancel(ctx)
	s.cfgMu.Lock()
	s.antigravityContext = ctx
	s.cfgMu.Unlock()
	s.homeMu.Lock()
	s.runCancel = runCancel
	s.homeMu.Unlock()
	defer func() {
		runCancel()
		s.homeMu.Lock()
		s.runCancel = nil
		s.homeMu.Unlock()
	}()

	s.startModelCatalogUpdaters(ctx)
	usage.StartDefault(ctx)
	cfg := s.currentConfig()

	defer func() {
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer shutdownCancel()
		if errShutdown := s.Shutdown(shutdownCtx); errShutdown != nil {
			log.Errorf("service shutdown returned error: %v", errShutdown)
		}
	}()

	if errEnsureAuthDir := s.ensureAuthDir(); errEnsureAuthDir != nil {
		return errEnsureAuthDir
	}
	s.applyKVStoreConfig(cfg)
	s.applyRetryConfig(cfg)
	s.configureCooldownStateStore(cfg)
	s.registerPluginAuthParser()

	if s.coreManager != nil {
		if errLoad := s.coreManager.Load(ctx); errLoad != nil {
			log.Warnf("failed to load auth store: %v", errLoad)
		}
		s.registerConfigAPIKeyAuths(coreauth.WithSkipPersist(ctx), cfg)
		if cfg != nil && cfg.SaveCooldownStatus {
			if errRestoreCooldown := s.coreManager.RestoreCooldownStates(ctx); errRestoreCooldown != nil {
				log.Warnf("failed to restore cooldown state: %v", errRestoreCooldown)
			}
		}
		s.registerAvailableExecutors(ctx, executorRegistrationOptions{
			includeBaseline: true,
			auths:           s.coreManager.List(),
		})
		if cfg == nil || !cfg.DisableAuthAutoRefresh {
			interval := 15 * time.Minute
			s.coreManager.StartAutoRefresh(ctx, interval)
			log.Infof("core auth auto-refresh started (interval=%s)", interval)
		}
	}

	if s.tokenProvider != nil {
		if _, err := s.tokenProvider.Load(ctx, cfg); err != nil && !errors.Is(err, context.Canceled) {
			return err
		}
	}
	if s.apiKeyProvider != nil {
		if _, err := s.apiKeyProvider.Load(ctx, cfg); err != nil && !errors.Is(err, context.Canceled) {
			return err
		}
	}

	s.ensureWebsocketGateway()
	s.syncPluginRuntimeConfig(ctx)
	s.configRuntimeMu.Lock()
	s.syncPluginModelRuntime(ctx)
	s.configRuntimeMu.Unlock()

	if s.authManager == nil {
		s.authManager = newDefaultAuthManager()
	}
	if s.hooks.OnBeforeStart != nil {
		s.hooks.OnBeforeStart(s.currentConfig())
	}
	if s.hooks.OnAfterStart != nil {
		s.hooks.OnAfterStart(s)
	}

	s.registerModelRefreshCallback()
	go s.runAntigravityModelRefresh(ctx)

	<-ctx.Done()
	return ctx.Err()
}

// RebindRuntimeExecutors refreshes provider executors for the current configuration.
func (s *Service) RebindRuntimeExecutors() {
	if s == nil {
		return
	}
	opts := executorRegistrationOptions{includeBaseline: true, includePlugins: true}
	if s.coreManager != nil {
		opts.auths = s.coreManager.List()
	}
	s.registerAvailableExecutors(context.Background(), opts)
}

// UpsertRuntimeAuth registers or updates an auth entry in the embedded runtime
// and registers its models.
func (s *Service) UpsertRuntimeAuth(ctx context.Context, auth *coreauth.Auth) (*coreauth.Auth, error) {
	if s == nil || s.coreManager == nil {
		return nil, fmt.Errorf("cliproxy: core auth manager is not configured")
	}
	if auth == nil || strings.TrimSpace(auth.ID) == "" {
		return nil, fmt.Errorf("cliproxy: auth id is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	registered := s.prepareCoreAuthForModelRegistration(ctx, auth)
	if registered == nil {
		return nil, fmt.Errorf("cliproxy: failed to register auth %s", auth.ID)
	}
	s.completeModelRegistrationForAuth(ctx, registered)
	s.coreManager.ReconcileRegistryModelStates(ctx, registered.ID)
	s.coreManager.RefreshSchedulerEntry(registered.ID)
	if current, ok := s.coreManager.GetByID(registered.ID); ok && current != nil {
		return current, nil
	}
	return registered, nil
}

// Execute performs a non-streaming request through the embedded runtime manager.
func (s *Service) Execute(ctx context.Context, providers []string, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	if s == nil || s.coreManager == nil {
		return cliproxyexecutor.Response{}, fmt.Errorf("cliproxy: core auth manager is not configured")
	}
	return s.coreManager.Execute(ctx, providers, req, opts)
}

// ExecuteStream performs a streaming request through the embedded runtime manager.
func (s *Service) ExecuteStream(ctx context.Context, providers []string, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	if s == nil || s.coreManager == nil {
		return nil, fmt.Errorf("cliproxy: core auth manager is not configured")
	}
	return s.coreManager.ExecuteStream(ctx, providers, req, opts)
}
