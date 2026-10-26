# Optional personal-use extension engine

Source: https://github.com/aimod-cc/agent2api
Pinned commit: adcab671c874e0a35fea15966e59e525b890b6e5 (2.9.7).

The complete upstream LICENSE applies: MIT terms plus the appended Usage Notice,
including non-commercial restrictions. This component is NOT pure MIT.
It is isolated as a separate process and bundled only by tauri.personal.conf.json.
Do not sell this personal-use bundle or treat subscription credentials as official API keys.
Credentials remain local; do not commit or share its SQLite data folder.

C.le modifications: loopback-only private management bridge, provider-scoped API
keys, glass UI, and daily check-in limited to actual non-inference check-in APIs.
WorkBuddy stays under C.le's existing account and check-in scheduler. The extension
engine's WorkBuddy keepalive/model-calling tasks are not exposed or scheduled.

Trae CN credential expiry parsing (refresh.rs and credentials.rs) is backported
unchanged from upstream v3.0.8, including its offline tests (issue #263).
Source: https://github.com/aimod-cc/Agent2API/tree/v3.0.8/desktop-tauri/src-tauri/server/src/server/core/providers/trae
This is a targeted backport, not an upgrade to the new plugin-based engine.
