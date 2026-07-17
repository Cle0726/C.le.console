package claudeweb

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"claude-web-gateway-sidecar/internal/config"
)

func TestSchedulerRoundRobinSkipsCoolingInvalidAndExhaustedAccounts(t *testing.T) {
	runtimePath := filepath.Join(t.TempDir(), "runtime.json")
	cfg := &config.GatewayConfig{ClaudeDailyLimit: 1, Accounts: []config.ClaudeSessionAccount{{ID: "a1", Label: "A1", SessionKey: "sk-a1", Enabled: true}, {ID: "a2", Label: "A2", SessionKey: "sk-a2", Enabled: true}, {ID: "a3", Label: "A3", SessionKey: "sk-a3", Enabled: true, DailyLimit: 2}}}
	scheduler := NewScheduler(cfg, runtimePath)
	first, err := scheduler.NextEligible()
	if err != nil || first.ID != "a1" {
		t.Fatalf("first=%#v err=%v", first, err)
	}
	scheduler.MarkSuccess("a1", "direct_http")
	second, err := scheduler.NextEligible()
	if err != nil || second.ID != "a2" {
		t.Fatalf("second=%#v err=%v", second, err)
	}
	scheduler.MarkCooldown("a2", "rate limited", "rate_limited", 429, "direct_http", time.Hour, "")
	third, err := scheduler.NextEligible()
	if err != nil || third.ID != "a3" {
		t.Fatalf("third=%#v err=%v", third, err)
	}
	scheduler.MarkInvalid("a3", "invalid", "invalid_session", 401, "direct_http")
	if _, err := scheduler.NextEligible(); err == nil {
		t.Fatal("expected no eligible account")
	}
}

func TestSchedulerRestoresExpiredCooldownAsHealthy(t *testing.T) {
	dir := t.TempDir()
	runtimePath := filepath.Join(dir, "runtime.json")
	past := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339)
	if err := os.WriteFile(runtimePath, []byte(`[{"accountId":"a1","status":"cooling_down","todayCalls":0,"cooldownUntil":"`+past+`"}]`), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := &config.GatewayConfig{ClaudeDailyLimit: 10, Accounts: []config.ClaudeSessionAccount{{ID: "a1", Label: "A1", SessionKey: "sk-a1", Enabled: true}}}
	scheduler := NewScheduler(cfg, runtimePath)
	account, err := scheduler.NextEligible()
	if err != nil || account.ID != "a1" {
		t.Fatalf("account=%#v err=%v", account, err)
	}
}
