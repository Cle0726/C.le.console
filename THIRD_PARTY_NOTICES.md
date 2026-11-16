# Third-party notices

## doubao2api protocol reference

Parts of the Doubao web login and Samantha video-generation flow in
`src-tauri/src/modules/doubao_web.rs` are adapted from
[`wangchuxiaoji-oss/doubao2api`](https://github.com/wangchuxiaoji-oss/doubao2api),
licensed under the Apache License 2.0.

The multi-account pool, account health, retry and asynchronous video-task
designs also reference the more complete Apache-2.0 fork
[`carzygod/doubao2api`](https://github.com/carzygod/doubao2api).

Copyright 2026 wangchuxiaoji-oss contributors.
Copyright 2026 carzygod/doubao2api contributors.

The full Apache License 2.0 text is available at
<https://www.apache.org/licenses/LICENSE-2.0>.

## WorkBuddy-Daily (WorkBuddy 国际版 daily activity)

The WorkBuddy 国际版 daily-activity chain (the `/v2/report` `chat_request_send`
event that lights the growth-center streak, the `/activity/growth/streak`
read-back, and the `/console/as/conversations/` web session) follows
[`L0NE-6/WorkBuddy-Daily`](https://github.com/L0NE-6/WorkBuddy-Daily)
(`workbuddy_intl_daily.py`), licensed under the MIT License.
Copyright (c) the WorkBuddy-Daily contributors.

## Cockpit Tools WorkBuddy management reference

The WorkBuddy multi-account daily-credit status flow, automatic check-in
scheduler, configuration dialog, and history presentation are adapted from
[`jlcodes99/cockpit-tools`](https://github.com/jlcodes99/cockpit-tools), with
changes for C.le. console's shared storage, independent API window, and fixed
Beijing time (UTC+8) scheduling.

Cockpit Tools is licensed under CC BY-NC-SA 4.0. C.le. console is distributed
under the same license. Copyright remains with the Cockpit Tools contributors.

The full CC BY-NC-SA 4.0 legal code is available at
<https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode>.
