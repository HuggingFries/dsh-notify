# dsh-notify

Desktop notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh):
the moment an **agent stops**, you get a notification — even when you stepped away —
and clicking it jumps straight back to the exact conversation in the dsh web UI.

> 目的:人离开时不至于 AI 停下来而人不知道 —— 每个"AI 停下需要你"的时刻都提醒,
> 点击通知一键跳回对应对话,提升人机协同效率。

## What triggers a notification

Every LLM "stop" in **every top-level dialog** (top-level sessions only; subagent
children are filtered out so delegation fan-out does not spam you):

| Moment | How it is detected (durable session events) |
|---|---|
| 回复完成 / reply finished | `turn/end` with reason `completed` / `error` / `max-tokens` / `blocked` |
| 向你提问 / a question is asked | `tool/call` of `ask_user_question` (the agent pauses and waits for your answer) |
| 请求批准 / approval requested | `approval/asked` (the agent waits for an approval decision) |

## What a notification does

- **Desktop notification** (browser Web Notifications API → Windows Action Center
  popups on Chrome/Edge).
- **Click it** → dsh web comes to the foreground and opens the exact session
  (`ctx.sessions.open`).
- **Smart quiet rule** — the only silent case is when you are looking at the very
  conversation the notice belongs to (page visible + focused + that session open
  in this window). Every other situation notifies:
  - the page is hidden / unfocused (you stepped away), or
  - the page is open but you are working in **another conversation** — e.g. you
    are coding in dialog A while dialog B finishes or asks a question; the popup
    appears and clicking it jumps precisely into dialog B.
  - Test notifications from the Settings row bypass the quiet rule.
- If desktop notifications are denied/unavailable, a small **in-page toast** is
  shown instead so nothing is silently lost.

## Install (this machine / after publishing)

```sh
# local path
dsh plugin --profile web add -w D:\dsh\dsh-notify

# after you push to GitHub (dsh plugin installs git packages like any pnpm dep)
dsh plugin --profile web add -w github:<your-name>/dsh-notify
```

Then **restart** the running instance and start it again:

```sh
dsh web
```

First use: open **Settings → General → 桌面通知 · Desktop notifications** and click
**开启通知权限 / Enable notifications** (one-time browser permission), then use the
`测试 · done / question / approval` buttons to verify each channel. The row's
per-kind toggles (回复完成 / 向你提问 / 请求批准) turn individual kinds on and off;
the quiet rule itself is fixed (see above), so there is no separate "away only"
switch.

## How it works

This package is a regular dual-face dsh plugin, structurally identical to
[dsh-skin](https://github.com/KinGao294/dsh-skin):

- `package.json` declares `dsh.bundle.patch` (host composition layer) and
  `dsh.client` (browser bundle served at `/plugins/dsh-notify/client.js`).
- `cordis.patch.yml` inserts one loader entry (`dsh-notify`) into the profile.
- **Host half** `lib/index.js` — plain ESM, only Node builtins. It listens to the
  process-wide `session/event` feed at the profile root scope, keeps a small
  per-session fold (title/label, last assistant text tail, dedupe keys), ignores
  subagent child sessions (`session.header.origin` / `delegationDepth`), and pushes
  notices over a same-origin SSE endpoint it registers with the `webServer`
  service:
  - `GET  /dsh-notify/feed` — SSE, `Last-Event-ID` replay for reconnect,
    `: ping` heartbeats;
  - `GET  /dsh-notify/status` — tiny JSON health endpoint;
  - `POST /dsh-notify/test` — push a synthetic notice (used by the Settings row).
  An activity log is appended to `$DSH_HOME/dsh-notify.log` for debugging.
- **Browser half** `lib/client.js` — CJS bundle for the shell module table
  (`window.__ModuleLoader__.load`), requires only `react` and
  `@deepseek-ai/dsh-client-runtime/client`. It subscribes to the SSE feed, shows
  desktop notifications with click-to-session, renders the Settings row (per-kind
  toggles + permission + test buttons), mounts the in-page toast fallback into
  the `shell.overlay` slot, and keeps an invisible occupant in the session-scoped
  `conversation.input.dock` slot whose `sessionId` prop feeds the quiet rule
  ("am I currently looking at the conversation this notice belongs to?").
  Preferences live in `localStorage`
  (`dsh-notify:config`, `dsh-notify:shown`), matching the browser-side preference
  boundary (the Host settings wire only exposes allowlisted namespaces).

## Platform boundaries (read before you promise "actions on the notification")

- The notification channel is the **browser**: notifications only fire while a dsh
  web page is open (any tab). Click-to-jump and inline action buttons on OS
  notifications require a native app with an AUMID (Windows) or a service worker,
  and answering an approval/question from the notification would additionally
  require the page's private answerer protocol — none of that is exposed to
  plugins. So the workflow is: notification → click → the exact conversation is
  open in front of you with the question/approval card and its buttons ready.
- `approval/asked` audit events are also emitted under the `never` approval policy
  (the ask is auto-rejected right after); with `never` the notice is mostly noise,
  so disable 请求批准 in the Settings row if you run that policy.

## Development

No build step: edit `lib/index.js` / `lib/client.js`, then restart `dsh web`
(client bundles are re-hashed and served with a new `rev` at boot). Validate
syntax locally with `node --check lib/index.js` and `node --check lib/client.js`.

## Roadmap ideas

- Service-worker notifications with inline 同意/拒绝 action buttons routed to the
  session when the page reconnects.
- Per-session quiet hours, notification sound choice, aggregate "N conversations
  stopped" batching for parallel runs.
- Windows-native toast fallback via a bundled helper for when no page is open.
