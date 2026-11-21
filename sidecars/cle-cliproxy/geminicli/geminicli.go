// Package geminicli embeds the official CLIProxyAPI Gemini CLI provider plugin
// (github.com/router-for-me/cpa-plugin-gemini-cli @ 19d9868, MIT) so the
// sidecar can serve gemini-cli OAuth accounts in-process. Upstream v8 removed
// the built-in Gemini CLI provider and ships it only as a native plugin.
package geminicli

import (
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/cle-cliproxy/geminicli/internal/plugin"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

// ID is the plugin identifier registered on the plugin host.
const ID = "gemini-cli"

// refreshLead matches the plugin's own authRefreshLead. v8 core has no
// refresh lead for plugin-owned providers, so without it the auto-refresh loop
// never renews gemini-cli tokens and an expired access token blocks selection.
const refreshLead = 5 * time.Minute

func init() {
	cliproxyauth.RegisterRefreshLeadProvider(ID, func() *time.Duration {
		lead := refreshLead
		return &lead
	})
}

// Build returns the plugin with its default configuration.
func Build() pluginapi.Plugin {
	return plugin.Build(nil)
}
