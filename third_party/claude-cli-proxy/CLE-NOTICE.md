# C.le Claude CLI subscription bridge

Based on [openclaw-claude-proxy](https://github.com/mehdic/openclaw-claude-proxy),
commit `17b112d35dbe65b43c7095cbf4d827654b0ba7f0`, under the MIT license.
The original license is included alongside this notice. Licenses of bundled
runtime dependencies are in `claude-cli-dependencies.txt`.

C.le changes: isolate Claude Code settings and native tools, fetch the current
access token from C.le's per-account local credential bridge, require local
bearer authentication, preserve requested model IDs, propagate CLI failures,
reject unsupported image/file inputs, and support caller-dispatched tools.
The refresh token remains managed exclusively by C.le.

Build `cle-claude-cli.bundle.cjs` after installing this directory's locked npm
dependencies with `npm ci --ignore-scripts`, then run from the repository root:

`node node_modules/esbuild/bin/esbuild third_party/claude-cli-proxy/src/server/standalone.ts --bundle --platform=node --target=node20 --format=cjs --legal-comments=eof --outfile=third_party/claude-cli-proxy/cle-claude-cli.bundle.cjs`
