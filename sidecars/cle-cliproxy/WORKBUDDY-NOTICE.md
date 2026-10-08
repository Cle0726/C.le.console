# WorkBuddy adapter attribution

C.le's WorkBuddy adapter adapts the account identity headers, client request
normalization and model discovery protocol from:

- https://github.com/ardeyouxipianyi/workbuddy2api-hub
  Revision: 4bdeaf03df51313a902e6f1243d1c8e11b384ea4
  Sources: `wb_identity.py`, `wb_accounts.py`, `wb_proxy.py`.
- https://github.com/modersetech/workbuddy-connect-api
  Revision: 232def29b30b3287394fe7820c2702be95cc8dd2
  Sources: `src/upstream.ts`, `src/nonstream.ts`.

Both projects are MIT licensed. Protocol translation, credential ownership and
account routing use C.le's existing CLIProxyAPI and WorkBuddy account manager.
C.le does not include the projects' task/reward automation or request-content
sanitization features.

## MIT License

Copyright (c) 2026
Copyright (c) 2026 workbuddy-connect-api contributors

Derived from dsh-workbuddy-connect (c) corrinehu and contributors, MIT, and
from Sliverkiss/workbuddy2api (c) Sliverkiss, MIT — the WorkBuddy upstream
protocol reference.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
