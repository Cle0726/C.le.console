# StoryOS v1.1 Desktop Bridge

This layer connects the existing Tauri desktop application to the StoryOS v1.0 read-only Authoring Workspace API.

## Security boundary

- Desktop access is limited to the dedicated `storyos-workspace` sidecar.
- The sidecar entry point imports only `storyos.workspace_cli`.
- Canon review, materialization and commit CLIs are not exposed by the sidecar entry point.
- Tauri grants only `shell:allow-execute` to the `main` window for this sidecar.
- `spawn`, stdin write and kill permissions are not granted.
- Allowed argument shapes are enumerated for `snapshot`, `entity` and `manuscript` reads.
- Project and manuscript paths are validated again inside StoryOS before any file is read.

## Desktop API

`src/services/storyosBridge.ts` exposes:

- `loadStoryOsWorkspace(projectPath, through?)`
- `loadStoryOsEntity(projectPath, entityId, through?)`
- `loadStoryOsManuscript(projectPath, relativePath)`

All responses are schema-checked before being returned to UI callers.

## Packaging

The read-only Python entry point is packaged as a one-file executable using the pinned `storyos[desktop]` extra.

- Windows target: `x86_64-pc-windows-msvc`
- macOS targets: `aarch64-apple-darwin`, `x86_64-apple-darwin`
- macOS sidecars are ad-hoc signed and verified before Tauri bundling.
- The builder performs an executable `--help` smoke test before accepting the artifact.

## CI / release policy

`node scripts/check-storyos-desktop-bridge.mjs` fails if the desktop permission boundary is broadened, the fixed sidecar changes, arbitrary argument mode is introduced, or mutation modules become reachable from the desktop sidecar entry point.

Windows pull-request CI uses a compile-only StoryOS placeholder after running the security audit and TypeScript checks. Windows release and macOS preview workflows build the real StoryOS executable before Tauri packaging.
