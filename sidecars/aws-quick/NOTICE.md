# AWS Quick sidecar (cle-aws-quick)

`cle-aws-quick` is a separate program bundled with C.le.控制台. It is built from:

- the unmodified sources of magpie-AWS-Quick-bridge 0.3.11
  (https://github.com/DaBinBinah/magpie-AWS-Quick-bridge, commit
  5a8d414f3332a071e9ac7da46d64445a3af3564d), © 2026 DaBinBinah, GPL-3.0-only,
  vendored at `third_party/magpie-aws-quick-bridge`;
- `sidecars/aws-quick/entry.mjs`, a small command-line driver, GPL-3.0-only;
- the Node.js 22 runtime, packaged with @yao-pkg/pkg (MIT-licensed Node.js).

It runs as its own process and talks to C.le.控制台 only through loopback HTTP
and JSON lines on stdout. The GPL-3.0 text is in `LICENSE` beside this file.
The complete corresponding source is published at
https://github.com/Cle0726/C.le.console under `third_party/magpie-aws-quick-bridge`
and `sidecars/aws-quick`, and is built by `scripts/build-aws-quick-sidecar.mjs`.

This is an unofficial project, unrelated to Amazon / AWS. Use only your own or
authorized accounts and follow the Amazon Quick terms of service.
