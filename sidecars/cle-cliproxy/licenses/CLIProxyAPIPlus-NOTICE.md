Kiro and GitHub Copilot executor/auth/translator portions are adapted from
https://github.com/Ant-Intelligence/CLIProxyAPIPlus
commit a14267def09a2d71228c5f3bedbdeecd84bfe095.
See CLIProxyAPIPlus-LICENSE for the full MIT grant and copyright notices.

C.le uses its existing native login stores and a private credential bridge;
the vendored executors do not own or persist a second rotating credential copy.
