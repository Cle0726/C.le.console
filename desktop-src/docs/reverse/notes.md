# Reverse-engineered notes

These notes capture only the behavior inferred from the packaged artifacts in the parent directory.

## Stable references

- `../C.le.控制台.exe`
- `../cockpit-cliproxy.exe`
- `../scripts/claude-desktop-auth-helper.cjs`

## High-confidence architecture

- Desktop host: Tauri 2 + Rust + Wry/WebView2
- Web UI: React + Vite
- Local gateway sidecar: Go
- Claude login helper: Electron script

## Runtime conventions reused in Phase 1

- Helper args: `--user-data-dir`, `--status-file`, `--export-file`, `--cookie-file`
- Helper logs: `<userDataDir>/Logs`
- Local gateway default bind: `127.0.0.1:8787`
- Localhost-only management is the default security posture
