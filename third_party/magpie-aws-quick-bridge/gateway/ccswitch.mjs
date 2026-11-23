// CC Switch (https://github.com/farion1231/cc-switch) import links: opening
// one adds "Amazon Quick" to CC Switch as a provider for one of its apps,
// pointing at the gateway. Each app is given the API it speaks natively, so
// CC Switch's own local routing is not needed.

const HOMEPAGE = "https://github.com/DaBinBinah/magpie-AWS-Quick-bridge"
const ICON = "https://raw.githubusercontent.com/DaBinBinah/magpie-AWS-Quick-bridge/main/assets/icon-128.png"

export const APPS = {
  claude: { label: "Claude Code", apiFormat: "anthropic", v1: false, models: { haikuModel: "fast", sonnetModel: "smart", opusModel: "smart" } },
  codex: { label: "Codex", apiFormat: "openai_responses", v1: true },
  opencode: { label: "OpenCode", apiFormat: "openai_chat", v1: true },
}

// The address an app is given: Claude Code adds /v1 itself, the others are
// given it.
export const endpoint = (app, base) => base.replace(/\/+$/, "") + (APPS[app]?.v1 ? "/v1" : "")

export function importLink(app, { base, apiKey, model = "smart", name = "Amazon Quick" }) {
  const spec = APPS[app]
  if (!spec) throw new Error(`unknown app ${JSON.stringify(app)}; one of: ${Object.keys(APPS).join(", ")}`)
  const params = new URLSearchParams({
    resource: "provider",
    app,
    name,
    endpoint: endpoint(app, base),
    apiKey,
    model,
    ...(spec.models ?? {}),
    apiFormat: spec.apiFormat,
    homepage: HOMEPAGE,
    icon: "aws",
    iconUrl: ICON,
    notes: "Amazon Quick through magpie-aws-quick-bridge on this computer; keep `magpie-aws-quick-bridge serve` running.",
  })
  // CC Switch reads "+" as a plus sign, not a space
  return "ccswitch://v1/import?" + params.toString().replaceAll("+", "%20")
}
