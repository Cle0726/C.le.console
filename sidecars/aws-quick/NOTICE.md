# AWS Quick sidecar (cle-aws-quick)

`cle-aws-quick` is a separate program bundled with C.le.控制台. It is built from:

- the sources of magpie-AWS-Quick-bridge 0.3.11
  (https://github.com/DaBinBinah/magpie-AWS-Quick-bridge, commit
  5a8d414f3332a071e9ac7da46d64445a3af3564d), © 2026 DaBinBinah, GPL-3.0-only,
  vendored at `third_party/magpie-aws-quick-bridge`. C.le.控制台 modified them
  on 2026-11-23: tool calls written as loose JSON are mended, a tool call that
  cannot be read and a lost or failed upstream connection are answered with a
  retryable "overloaded" error, dial failures are retried, and a streamed
  Anthropic answer sends pings while the model thinks. With client tools, a
  streamed reply's text is held until the turn is complete, so a turn the
  content filter or a lost connection cuts off is asked again (up to four times)
  on a new thread before the client sees anything of it. On 2026-11-24: images
  in a tool result (Claude Code reading a picture) are sent to Amazon Quick as
  attachments, as those of a user message already were, and the content
  filter's notice sent as a guardrail event is asked again the same way. The
  account files can be named per call (gateway/store.mjs), so one process can
  serve several accounts (`cle-aws-quick multi`);
- `sidecars/aws-quick/entry.mjs`, a small command-line driver, GPL-3.0-only;
- the Node.js 22 runtime, packaged with @yao-pkg/pkg (MIT-licensed Node.js).

It runs as its own process and talks to C.le.控制台 only through loopback HTTP
and JSON lines on stdout. The GPL-3.0 text is in `LICENSE` beside this file.
The complete corresponding source is published at
https://github.com/Cle0726/C.le.console under `third_party/magpie-aws-quick-bridge`
and `sidecars/aws-quick`, and is built by `scripts/build-aws-quick-sidecar.mjs`.

This is an unofficial project, unrelated to Amazon / AWS. Use only your own or
authorized accounts and follow the Amazon Quick terms of service.
