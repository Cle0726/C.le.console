package misc

import "testing"

func TestClientVersionUsesFallbackBeforeRefresh(t *testing.T) {
	if got := ClientVersion(ClientCodex); got != "0.167.0" {
		t.Fatalf("ClientVersion(codex) = %q", got)
	}
	if ClientVersionsActive() {
		t.Fatal("updater should not be active in a unit test")
	}
}

func TestCopilotChatVersionFromMarketplace(t *testing.T) {
	body := []byte(`{"results":[{"extensions":[{"versions":[{"version":"0.48.1"}]}]}]}`)
	got, err := copilotChatVersionFromMarketplace(body)
	if err != nil {
		t.Fatal(err)
	}
	if got != "0.48.1" {
		t.Fatalf("version = %q", got)
	}
}

func TestVersionFromUpdaterManifest(t *testing.T) {
	got := versionFromUpdaterManifest([]byte("version: 0.9.2\npath: Kiro.zip\n"))
	if got != "0.9.2" {
		t.Fatalf("version = %q", got)
	}
}

func TestIsValidClientVersion(t *testing.T) {
	if !isValidClientVersion("2.1.319") || !isValidClientVersion("0.158.0-alpha.2") {
		t.Fatal("expected dotted versions to pass")
	}
	if isValidClientVersion("") || isValidClientVersion("latest") || isValidClientVersion("1") {
		t.Fatal("expected malformed versions to fail")
	}
}
