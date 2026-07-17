package claudeweb

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"claude-web-gateway-sidecar/internal/config"
)

type Scheduler struct {
	cfg         *config.GatewayConfig
	runtimePath string
	mu          sync.Mutex
	cursor      int
	dayKey      string
	states      map[string]*config.ClaudeSessionRuntimeState
}

func NewScheduler(cfg *config.GatewayConfig, runtimePath string) *Scheduler {
	s := &Scheduler{cfg: cfg, runtimePath: runtimePath, states: map[string]*config.ClaudeSessionRuntimeState{}, dayKey: time.Now().UTC().Format("2006-01-02")}
	s.restore()
	return s
}

func (s *Scheduler) restore() {
	data, err := os.ReadFile(s.runtimePath)
	if err == nil {
		var states []config.ClaudeSessionRuntimeState
		if json.Unmarshal(data, &states) == nil {
			for _, state := range states {
				copy := state
				s.states[state.AccountID] = &copy
			}
		}
	}
	s.seedDefaultsLocked()
}

func (s *Scheduler) seedDefaultsLocked() {
	for _, account := range s.cfg.Accounts {
		if _, ok := s.states[account.ID]; !ok {
			s.states[account.ID] = &config.ClaudeSessionRuntimeState{AccountID: account.ID, Status: "healthy"}
		}
	}
	_ = s.persistLocked()
}

func (s *Scheduler) ensureDayLocked(now time.Time) {
	day := now.UTC().Format("2006-01-02")
	if day == s.dayKey {
		return
	}
	s.dayKey = day
	for _, state := range s.states {
		state.TodayCalls = 0
		if state.Status == "exhausted" {
			state.Status = "healthy"
		}
	}
}

func (s *Scheduler) persistLocked() error {
	if s.runtimePath == "" {
		return nil
	}
	states := s.snapshotLocked()
	data, err := json.MarshalIndent(states, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.runtimePath, data, 0o644)
}

func (s *Scheduler) snapshotLocked() []config.ClaudeSessionRuntimeState {
	now := time.Now().UTC()
	out := make([]config.ClaudeSessionRuntimeState, 0, len(s.cfg.Accounts))
	for _, account := range s.cfg.Accounts {
		state := s.states[account.ID]
		if state == nil {
			state = &config.ClaudeSessionRuntimeState{AccountID: account.ID, Status: "healthy"}
			s.states[account.ID] = state
		}
		copy := *state
		if !account.Enabled {
			copy.Status = "disabled"
			copy.CooldownUntil = ""
			copy.RetryAfterUntil = ""
			out = append(out, copy)
			continue
		}
		if copy.Status == "cooling_down" {
			copy = normalizeCooldownState(copy, now)
		}
		limit := account.DailyLimit
		if limit <= 0 {
			limit = s.cfg.ClaudeDailyLimit
		}
		if copy.Status != "invalid" && limit > 0 && copy.TodayCalls >= limit {
			copy.Status = "exhausted"
		}
		if copy.Status == "" {
			copy.Status = "healthy"
		}
		out = append(out, copy)
	}
	return out
}

func normalizeCooldownState(state config.ClaudeSessionRuntimeState, now time.Time) config.ClaudeSessionRuntimeState {
	deadline := state.CooldownUntil
	if state.RetryAfterUntil != "" {
		deadline = state.RetryAfterUntil
	}
	if deadline == "" {
		return state
	}
	if ts, err := time.Parse(time.RFC3339, deadline); err == nil && !ts.After(now) {
		state.Status = "healthy"
		state.CooldownUntil = ""
		state.RetryAfterUntil = ""
	}
	return state
}

func (s *Scheduler) Snapshot() []config.ClaudeSessionRuntimeState {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureDayLocked(time.Now().UTC())
	states := s.snapshotLocked()
	_ = s.persistLocked()
	return states
}

func (s *Scheduler) NextEligible() (*config.ClaudeSessionAccount, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureDayLocked(time.Now().UTC())
	count := len(s.cfg.Accounts)
	if count == 0 {
		return nil, fmt.Errorf("no configured accounts")
	}
	for offset := 0; offset < count; offset++ {
		idx := (s.cursor + offset) % count
		account := &s.cfg.Accounts[idx]
		state := s.states[account.ID]
		if state == nil {
			state = &config.ClaudeSessionRuntimeState{AccountID: account.ID, Status: "healthy"}
			s.states[account.ID] = state
		}
		if !account.Enabled {
			state.Status = "disabled"
			state.CooldownUntil = ""
			state.RetryAfterUntil = ""
			continue
		}
		if state.Status == "disabled" {
			state.Status = "healthy"
		}
		if state.Status == "invalid" {
			continue
		}
		if state.Status == "cooling_down" {
			normalized := normalizeCooldownState(*state, time.Now().UTC())
			*state = normalized
			if state.Status == "cooling_down" {
				continue
			}
		}
		limit := account.DailyLimit
		if limit <= 0 {
			limit = s.cfg.ClaudeDailyLimit
		}
		if limit > 0 && state.TodayCalls >= limit {
			state.Status = "exhausted"
			continue
		}
		s.cursor = (idx + 1) % count
		_ = s.persistLocked()
		return account, nil
	}
	_ = s.persistLocked()
	return nil, fmt.Errorf("no eligible sessionKey available")
}

func (s *Scheduler) MarkSuccess(accountID, transport string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.states[accountID]
	if state == nil {
		return
	}
	state.TodayCalls++
	state.Status = "healthy"
	state.LastError = ""
	state.LastSuccessAt = time.Now().UTC().Format(time.RFC3339)
	state.CooldownUntil = ""
	state.RetryAfterUntil = ""
	state.LastFailureKind = ""
	state.LastStatusCode = 0
	state.LastTransport = transport
	state.ConsecutiveFailures = 0
	limit := s.cfg.ClaudeDailyLimit
	for _, account := range s.cfg.Accounts {
		if account.ID == accountID && account.DailyLimit > 0 {
			limit = account.DailyLimit
			break
		}
	}
	if limit > 0 && state.TodayCalls >= limit {
		state.Status = "exhausted"
	}
	_ = s.persistLocked()
}

func (s *Scheduler) MarkCooldown(accountID, message, failureKind string, statusCode int, transport string, duration time.Duration, retryAfterUntil string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.states[accountID]
	if state == nil {
		return
	}
	state.Status = "cooling_down"
	state.LastError = message
	state.LastFailureKind = failureKind
	state.LastStatusCode = statusCode
	state.LastTransport = transport
	state.ConsecutiveFailures++
	state.CooldownUntil = time.Now().UTC().Add(duration).Format(time.RFC3339)
	state.RetryAfterUntil = retryAfterUntil
	_ = s.persistLocked()
}

func (s *Scheduler) MarkInvalid(accountID, message, failureKind string, statusCode int, transport string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.states[accountID]
	if state == nil {
		return
	}
	state.Status = "invalid"
	state.LastError = message
	state.LastFailureKind = failureKind
	state.LastStatusCode = statusCode
	state.LastTransport = transport
	state.CooldownUntil = ""
	state.RetryAfterUntil = ""
	state.ConsecutiveFailures++
	_ = s.persistLocked()
}
