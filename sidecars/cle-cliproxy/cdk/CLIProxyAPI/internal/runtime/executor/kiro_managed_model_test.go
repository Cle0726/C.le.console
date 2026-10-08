package executor

import "testing"

func TestCleLiveKiroModelNeverFallsBackToOldModel(t *testing.T) {
	e := &KiroExecutor{}
	for _, id := range []string{"upstream-next", "claude-sonnet-9.0", "new-haiku-2030"} {
		if got := e.mapModelToKiro(id); got != id {
			t.Fatalf("silently downgraded %s to %s", id, got)
		}
	}
	if got := e.mapModelToKiro("kiro-claude-sonnet-4-6"); got != "claude-sonnet-4.6" {
		t.Fatal("lost known alias")
	}
}
