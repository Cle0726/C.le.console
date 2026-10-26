# WorkBuddy / Claude account persistence

Account IDs and existing JSON files remain compatible. Neither listing accounts
nor a failed quota request is permission to merge identities or remove files.
An unreadable detail rejects the checked list so the UI can retain its cache.
Orphan detail files are discovered without rewriting the index while reading.

The credential flow is: check writable storage, rotate once per account, commit
the returned pair, then read quota. An owned Tokio task finishes the commit even
if the requesting window closes. Reauthorization and deletion are checked again
under the account-store lock before accepting delayed refresh results.

Each account directory has a private `.state/<id>/` directory:

- `credentials.json`: the latest acknowledged credential generation and its predecessor fingerprint.
- `history/`: up to eight immutable generations, independent of runtime errors.
- `runtime.json`: quota/status/error fields bound to that generation, without tokens.
- `last_verified.json`: updated only after an actual successful quota query.

Files use atomic replacement, file sync, parent-directory sync on Unix, and
0600 permissions from creation; private directories use 0700. After interruption
between the journal and primary write, only the matching predecessor is replayed.
Conflicting external credentials win. Missing primary records are not resurrected;
damaged originals are not rewritten merely by reading. Archived credential pairs
cannot overwrite a newer saved generation. Credential history is recovery data,
not a way to make a server-revoked grant usable again.

Managed Claude API routes use the existing authenticated loopback bridge. The Go
executor receives an access token without a refresh token; it cannot independently
rotate the same grant. Ordinary API keys and manually configured gateway accounts
keep their original path. Claude Code-owned grants are synchronized by identity
and are not independently renewed by the quota UI. Background synchronization
reads plaintext credential files only; explicit import remains available for
Keychain-backed credentials. Failed Keychain writes preserve the original item.

Design references inspected on 2026-10-26:

- [workbuddy2api-hub account save/refresh](https://github.com/ardeyouxipianyi/workbuddy2api-hub/blob/4f7ae6f2efcae5e6ae85aefa732035206044514b/wb_accounts.py): per-account refresh coordination and immediate persistence.
- [CodexBar Claude source documentation](https://github.com/steipete/CodexBar/blob/main/docs/claude.md): explicit credential ownership, retained cache timestamps, and preserving denied Keychain items.
- [Switcher for Claude Code](https://github.com/clumsyboss/switcher-for-claude-code): delegate the active CLI grant to Claude Code rather than racing it.

Offline regression command (synthetic records only):

```sh
cargo test --manifest-path tests/account-reliability/Cargo.toml --offline
```

The tests include an actual child-process exit after journal sync, cancellation,
coalescing, corrupt-primary recovery, rejection of stale writers and quota results,
private permissions, and bounded history. Gateway bridge tests use `httptest` and
never contact a model provider.
