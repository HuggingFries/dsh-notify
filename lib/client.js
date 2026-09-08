// dsh-notify — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules at /plugins/dsh-notify/client.js and executed
// through the vendored cordis Loader's lazy-CJS module table
// (window.__ModuleLoader__.load). The factory body is plain CJS with
// require() resolved against the shell's module table — the same shape the
// shipped ui-* packages' tsdown bundles emit and exactly how dsh-skin ships.
//
// Responsibilities:
//   1. subscribe to the host SSE feed (/dsh-notify/feed),
//   2. turn each notice into a browser desktop notification (Web Notifications
//      API); clicking the notification focuses dsh web and opens the exact
//      conversation (ctx.sessions.open),
//   3. when notifications are unavailable or denied, fall back to a small
//      in-page toast stack registered in shell.overlay,
//   4. render one row in Settings → General (id "dsh-notify") with per-kind
//      toggles, the permission button, and per-kind test buttons,
//   5. keep an invisible occupant in the session-scoped conversation.input.dock
//      slot whose sessionId prop feeds the quiet rule ("am I currently looking
//      at the conversation this notice belongs to?").
//
// Preferences live in localStorage (dsh-notify:config) — the Host settings
// wire only exposes an allowlisted set of namespaces to browser clients, so
// localStorage matches the boundary for a browser-side preference.
window.__ModuleLoader__.load({
	id: "dsh-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const _runtime_client = require("@deepseek-ai/dsh-client-runtime/client");

		//#region dsh-notify: constants and helpers

		const CFG_KEY = "dsh-notify:config";
		const SHOWN_KEY = "dsh-notify:shown";
		const ROW_ID = "dsh-notify";
		const CLIENT_VERSION = "0.2.5";

		/**
		 * Fire-and-forget client decision log: every notice handling decision is
		 * reported to the host /dsh-notify/log endpoint, which appends it to
		 * $DSH_HOME/dsh-notify.log — this is how delivery problems are diagnosed
		 * without a browser console.
		 */
		function logClient(payload) {
			try {
				const body = JSON.stringify(Object.assign({ v: CLIENT_VERSION, at: Date.now() }, payload));
				fetch("/dsh-notify/log", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body,
				}).catch(() => { /* ignore */ });
			} catch { /* ignore */ }
		}

		const DEFAULT_CFG = {
			done: true, // 回复完成 / reply finished
			question: true, // 向你提问 / question asked
			approval: true, // 请求批准 / approval requested
		};

		/** Kinds the Settings row offers test buttons for. */
		const TEST_KINDS = ["done", "question", "approval"];

		const KIND_TITLE_ZH = {
			done: "对话已完成",
			question: "需要你回答",
			approval: "需要你批准",
		};
		const KIND_TITLE_EN = {
			done: "DSH · conversation finished",
			question: "DSH · needs your answer",
			approval: "DSH · needs your approval",
		};

		const isZh = () => {
			try { return /^zh/i.test(navigator.language || ""); } catch { return false; }
		};

		const canNotify = () => typeof Notification !== "undefined";

		const notifyPermission = () => (canNotify() ? Notification.permission : "unsupported");

		function clip(text, max) {
			if (typeof text !== "string") return "";
			const flat = text.replace(/\s+/g, " ").trim();
			if (flat.length <= max) return flat;
			return flat.slice(0, Math.max(0, max - 1)) + "…";
		}

		function readCfg() {
			const cfg = { ...DEFAULT_CFG };
			try {
				const raw = localStorage.getItem(CFG_KEY);
				if (raw) {
					const parsed = JSON.parse(raw);
					if (parsed && typeof parsed === "object") {
						for (const key of Object.keys(DEFAULT_CFG)) {
							if (typeof parsed[key] === "boolean") cfg[key] = parsed[key];
						}
					}
				}
			} catch { /* ignore */ }
			return cfg;
		}

		function writeCfg(cfg) {
			try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
		}

		/**
		 * "Last handled notice time" cursor (epoch ms) instead of a sequence
		 * number: the host restarts its per-boot seq at 1, so an integer cursor
		 * in localStorage silently ate every notice after a server restart.
		 * Values < 1e12 (legacy integer seq cursors) are treated as zero.
		 */
		function readShownTime() {
			try {
				const n = Number.parseFloat(localStorage.getItem(SHOWN_KEY) || "0");
				return Number.isFinite(n) && n >= 1e12 ? n : 0;
			} catch { return 0; }
		}

		function markShownTime(time) {
			try { localStorage.setItem(SHOWN_KEY, String(time)); } catch { /* ignore */ }
		}

		/** Shared config bus: apply-world state + Settings row stay in sync. */
		const bus = {
			cfg: readCfg(),
			rev: 0,
			/** Session id currently open in THIS window (fed by ActiveSessionProbe; "" = none). */
			activeSessionId: "",
			toasts: [],
			toastListeners: new Set(),
		};

		/** Config change or permission change: bump the revision and sync the row store. */
		function bump() {
			bus.rev += 1;
			pushStore();
		}

		function updateCfg(patch) {
			bus.cfg = { ...bus.cfg, ...patch };
			writeCfg(bus.cfg);
			bump();
		}

		function pushToast(toast) {
			bus.toasts.push(toast);
			if (bus.toasts.length > 8) bus.toasts.splice(0, bus.toasts.length - 8);
			for (const listener of bus.toastListeners) {
				try { listener(bus.toasts.slice()); } catch { /* ignore */ }
			}
		}

		function subscribeToasts(listener) {
			bus.toastListeners.add(listener);
			return () => bus.toastListeners.delete(listener);
		}

		function textFor(notice) {
			const zh = isZh();
			const titles = zh ? KIND_TITLE_ZH : KIND_TITLE_EN;
			const kindTitle = titles[notice.kind] || titles.done;
			const label = typeof notice.label === "string" && notice.label ? clip(notice.label, 60) : "";
			const text = typeof notice.text === "string" && notice.text ? clip(notice.text, 200) : "";
			const title = notice.kind === "test"
				? zh ? "DSH 通知 · 测试" : "DSH Notify · Test"
				: kindTitle;
			const body = [label, text].filter(Boolean).join(" · ");
			return { title, body: body || kindTitle };
		}

		function jumpTo(ctx, sessionId) {
			try {
				if (sessionId) ctx.sessions.open(sessionId);
			} catch { /* ignore */ }
			try { window.focus(); } catch { /* ignore */ }
		}

		function showDesktop(ctx, notice) {
			try {
				const text = textFor(notice);
				const notification = new Notification(text.title, {
					body: text.body,
					tag: `dsh-notify-${notice.seq}`,
					requireInteraction: notice.kind === "question" || notice.kind === "approval",
				});
				notification.onclick = () => {
					try { notification.close(); } catch { /* ignore */ }
					jumpTo(ctx, notice.sessionId);
				};
				return true;
			} catch (error) {
				console.warn("[dsh-notify] desktop notification failed", error);
				return false;
			}
		}

		/**
		 * Decide how one host notice reaches the human:
		 * - the ONLY quiet case is when the human is looking at THIS very
		 *   conversation right now (page visible + focused + the notice belongs
		 *   to the currently open session);
		 * - every other state — page hidden or unfocused, another conversation
		 *   open, or no conversation open — shows a desktop notification
		 *   (when granted) and otherwise falls back to an in-page toast.
		 * A click on the notification jumps precisely into the notice's session.
		 */
		function handleNotice(ctx, notice) {
			if (!notice || typeof notice.seq !== "number") return;
			const kind = notice.kind;
			if (kind === "done" && !bus.cfg.done) return;
			if (kind === "question" && !bus.cfg.question) return;
			if (kind === "approval" && !bus.cfg.approval) return;
			if (kind !== "test" && kind !== "done" && kind !== "question" && kind !== "approval") return;

			const seq = notice.seq;
			const time = typeof notice.time === "number" && notice.time >= 1e12 ? notice.time : 0;
			if (time !== 0 && time <= readShownTime()) {
				logClient({ m: "dedupe", seq, kind });
				return; // already handled (dedupe across tabs + replay safety)
			}

			const isTest = kind === "test";
			let engaged = false;
			try {
				engaged = document.visibilityState === "visible" && document.hasFocus();
			} catch { /* ignore */ }
			const watching = engaged && Boolean(notice.sessionId) && notice.sessionId === bus.activeSessionId;
			if (watching && !isTest) {
				logClient({ m: "quiet", seq, kind, engaged, active: bus.activeSessionId });
				return; // watching this very conversation; nothing to show, do NOT mark as shown
			}
			logClient({ m: "decide", seq, kind, engaged, active: bus.activeSessionId, perm: notifyPermission() });

			const permission = notifyPermission();
			let shown = false;
			if (permission === "granted") {
				shown = showDesktop(ctx, notice);
			}
			// When permission is still undecided or denied, fall back to the
			// in-page toast (the Settings row exposes the explicit 开启权限 button;
			// while this page is visible a one-time prompt is also offered at boot).

			if (!shown) {
				const text = textFor(notice);
				pushToast({
					seq,
					kind,
					title: text.title,
					body: text.body,
					sessionId: notice.sessionId,
					at: Date.now(),
					onClick: () => jumpTo(ctx, notice.sessionId),
				});
			}
			if (time !== 0) markShownTime(time); // marked only once something was actually displayed
			logClient({ m: shown ? "os" : "toast", seq, kind, at: Date.now() });
		}

		function requestNotifyPermission() {
			if (!canNotify()) return Promise.resolve("unsupported");
			return Notification.requestPermission()
				.then((result) => { bump(); return result; })
				.catch(() => "unsupported");
		}

		function sendTestNotice(kind) {
			const body = JSON.stringify({ kind: TEST_KINDS.includes(kind) ? kind : "done" });
			return fetch("/dsh-notify/test", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			}).then((response) => response.json().then((payload) => payload));
		}

		//#endregion

		//#region dsh-notify: Settings → General row

		/**
		 * Row slot store: a mirror of the plugin config. The apply-world write
		 * path (updateCfg / permission changes) is the only writer; the row
		 * component reads via props.useStore.
		 */
		function createNotifyStore() {
			return _runtime_client.defineStore({
				init: () => ({ cfg: bus.cfg, rev: bus.rev }),
				actions: {
					sync: (d, cfg, rev) => {
						if (rev > d.rev) {
							d.cfg = cfg;
							d.rev = rev;
						}
					},
				},
			});
		}

		let storeActions = null;

		function pushStore() {
			if (storeActions && typeof storeActions.sync === "function") {
				try { storeActions.sync(bus.cfg, bus.rev); } catch { /* ignore */ }
			}
		}

		const rowStyles = {
			group: {
				borderBottom: "1px solid var(--dsw-alias-border-l2)",
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				padding: "16px 0",
			},
			title: {
				color: "var(--dsw-alias-label-primary)",
				fontSize: "14px",
				lineHeight: "22px",
			},
			hint: {
				color: "var(--dsw-alias-label-tertiary)",
				fontSize: "12px",
				lineHeight: "18px",
			},
			checkRow: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				cursor: "pointer",
				fontSize: "13px",
				color: "var(--dsw-alias-label-secondary)",
			},
			checkLabel: {
				display: "flex",
				flexDirection: "column",
				gap: "1px",
			},
			checkSub: {
				fontSize: "11px",
				color: "var(--dsw-alias-label-tertiary)",
			},
			buttonRow: {
				display: "flex",
				flexWrap: "wrap",
				gap: "8px",
			},
			button: {
				height: "28px",
				padding: "0 12px",
				borderRadius: "8px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-button-elevated-fill)",
				color: "var(--dsw-alias-label-primary)",
				cursor: "pointer",
				font: "inherit",
				fontSize: "12px",
			},
			status: {
				color: "var(--dsw-alias-label-secondary)",
				fontSize: "12px",
				lineHeight: "18px",
			},
			statusError: {
				color: "var(--dsw-alias-state-error-primary)",
				fontSize: "12px",
				lineHeight: "18px",
			},
		};

		function CheckRow({ checked, onChange, label, sub }) {
			return React.createElement(
				"label",
				{ style: rowStyles.checkRow },
				React.createElement("input", {
					type: "checkbox",
					checked,
					onChange: (event) => onChange(event.target.checked),
				}),
				React.createElement(
					"span",
					{ style: rowStyles.checkLabel },
					React.createElement("span", null, label),
					sub ? React.createElement("span", { style: rowStyles.checkSub }, sub) : null
				)
			);
		}

		function NotifyRow({ useStore, toggle, requestPermission, sendTest }) {
			const cfg = useStore((s) => s.cfg);
			const [feedback, setFeedback] = React.useState("");
			const [feedbackError, setFeedbackError] = React.useState(false);
			const zh = isZh();

			const onToggle = (key) => (value) => toggle(key, value);

			const onPermission = () => {
				setFeedback(zh ? "请求通知权限中…" : "Requesting notification permission…");
				setFeedbackError(false);
				requestPermission().then((result) => {
					if (result === "granted") {
						setFeedback(zh ? "已允许 — 现在试试下面的测试按钮" : "Granted — try a test button below");
					} else if (result === "denied") {
						setFeedback(zh ? "已被拒绝:请在浏览器地址栏左侧的站点权限中允许通知" : "Denied — allow notifications in the browser site settings");
						setFeedbackError(true);
					} else if (result === "unsupported") {
						setFeedback(zh ? "此浏览器不支持桌面通知,将使用页面内提醒" : "Desktop notifications unsupported — in-page toasts will be used");
						setFeedbackError(false);
					} else {
						setFeedback(zh ? "尚未决定 — 请在弹出的权限框中选择“允许”" : "Not decided yet — choose “Allow” in the prompt");
					}
				});
			};

			const onTest = (kind) => {
				setFeedback(zh ? "正在发送测试通知…" : "Sending test notification…");
				setFeedbackError(false);
				sendTest(kind)
					.then((payload) => {
						if (payload && payload.ok) {
							setFeedback(zh ? "已发送 ✓ 稍等片刻,桌面通知会弹出" : "Sent ✓ the desktop notification appears shortly");
						} else {
							setFeedback(String((payload && payload.error) || "failed"));
							setFeedbackError(true);
						}
					})
					.catch((error) => {
						setFeedback(String((error && error.message) || error));
						setFeedbackError(true);
					});
			};

			const permission = notifyPermission();
			const permText = permission === "granted"
				? (zh ? "通知:已允许" : "Notifications: granted")
				: permission === "denied"
					? (zh ? "通知:被浏览器拒绝" : "Notifications: denied")
					: permission === "default"
						? (zh ? "通知:尚未允许" : "Notifications: not granted yet")
						: (zh ? "通知:此浏览器不支持" : "Notifications: unsupported");

			return React.createElement(
				"div",
				{ style: rowStyles.group },
				React.createElement("div", { style: rowStyles.title }, "桌面通知 · Desktop notifications"),
				React.createElement(
					CheckRow,
					{
						checked: cfg.done,
						onChange: onToggle("done"),
						label: zh ? "回复完成时提醒" : "Alert when a reply finishes",
						sub: zh ? "agent 每次停下(完成/出错/超限)后通知" : "notify after every agent stop (done / error / token limit)",
					}
				),
				React.createElement(
					CheckRow,
					{
						checked: cfg.question,
						onChange: onToggle("question"),
						label: zh ? "向你提问时提醒" : "Alert when a question is asked",
						sub: zh ? "agent 使用 ask 工具等待你回答时" : "when the agent asks you something and waits",
					}
				),
				React.createElement(
					CheckRow,
					{
						checked: cfg.approval,
						onChange: onToggle("approval"),
						label: zh ? "请求批准时提醒" : "Alert when approval is requested",
						sub: zh ? "agent 等待你批准某操作时" : "when the agent waits for your approval",
					}
				),
				React.createElement(
					"div",
					{ style: rowStyles.buttonRow },
					React.createElement("button", { type: "button", style: rowStyles.button, onClick: onPermission },
						zh ? "开启通知权限" : "Enable notifications"),
					TEST_KINDS.map((kind) => React.createElement(
						"button",
						{ key: kind, type: "button", style: rowStyles.button, onClick: () => onTest(kind) },
						`测试 · ${kind}`
					))
				),
				React.createElement("div", { style: rowStyles.status }, permText),
				feedback
					? React.createElement("div", { style: feedbackError ? rowStyles.statusError : rowStyles.status }, feedback)
					: null,
				React.createElement(
					"div",
					{ style: rowStyles.hint },
					zh
						? "规则:只有当你正盯着“产生通知的那个对话”时才静音;页面在后台、或正看着别的对话时都会弹通知,点击直达对应对话。测试通知不受静音影响。设置保存在本浏览器(localStorage)。"
						: "Rule: quiet only while you are watching the exact conversation the notice belongs to; page in the background or another conversation open → notify, click jumps to that conversation. Test notifications bypass the quiet rule. Settings live in this browser (localStorage)."
				)
			);
		}

		//#endregion

		//#region dsh-notify: in-page toast fallback (shell.overlay)

		const toastStyles = {
			container: {
				position: "fixed",
				top: "12px",
				right: "12px",
				width: "320px",
				display: "flex",
				flexDirection: "column",
				gap: "8px",
				pointerEvents: "none",
				zIndex: 2147483000,
			},
			card: {
				pointerEvents: "auto",
				cursor: "pointer",
				borderRadius: "10px",
				padding: "10px 12px",
				background: "var(--dsw-alias-bg-overlay)",
				border: "1px solid var(--dsw-alias-border-l2)",
				boxShadow: "0 6px 24px rgba(0, 0, 0, 0.25)",
				color: "var(--dsw-alias-label-primary)",
				display: "flex",
				flexDirection: "column",
				gap: "3px",
			},
			title: {
				fontSize: "13px",
				fontWeight: 600,
				lineHeight: "18px",
			},
			body: {
				fontSize: "12px",
				lineHeight: "17px",
				color: "var(--dsw-alias-label-secondary)",
			},
		};

		function ToastLayer() {
			const [toasts, setToasts] = React.useState(() => bus.toasts.slice());
			const [, setTick] = React.useState(0);

			React.useEffect(() => subscribeToasts(setToasts), []);
			React.useEffect(() => {
				const handle = setInterval(() => setTick((value) => value + 1), 1000);
				return () => clearInterval(handle);
			}, []);

			const now = Date.now();
			const visible = toasts.filter((toast) => now - toast.at < 12000);
			if (visible.length === 0) return null;

			return React.createElement(
				"div",
				{ style: toastStyles.container },
				visible.map((toast) => React.createElement(
					"div",
					{
						key: toast.seq,
						style: toastStyles.card,
						title: toast.sessionId || undefined,
						onClick: () => {
							try {
								if (toast.onClick) toast.onClick();
							} catch { /* ignore */ }
							pushToastDismiss(toast.seq);
						},
					},
					React.createElement("div", { style: toastStyles.title }, toast.title),
					React.createElement("div", { style: toastStyles.body }, toast.body)
				))
			);
		}

		function pushToastDismiss(seq) {
			bus.toasts = bus.toasts.filter((toast) => toast.seq !== seq);
			for (const listener of bus.toastListeners) {
				try { listener(bus.toasts.slice()); } catch { /* ignore */ }
			}
		}

		//#endregion

		//#region dsh-notify: active-session probe

		/**
		 * Invisible occupant of the session-scoped `conversation.input.dock`
		 * slot: the owner passes the id of the conversation currently displayed
		 * in this window as a standard `sessionId` prop. It feeds
		 * `bus.activeSessionId` so handleNotice can stay quiet only while the
		 * human is looking at the very conversation the notice belongs to.
		 */
		function ActiveSessionProbe(props) {
			// sessionId may arrive as a direct standard prop, or as the id of the
			// owner's ConversationSnapshot share; log which source was used so a
			// missing delivery shows up in the diagnostic log.
			let sessionId = ""
			let via = "none"
			if (typeof props.sessionId === "string" && props.sessionId) {
				sessionId = props.sessionId
				via = "prop"
			} else if (props.session && typeof props.session.id === "string" && props.session.id) {
				sessionId = props.session.id
				via = "session"
			}
			try {
				if (bus.activeSessionId !== sessionId) {
					bus.activeSessionId = sessionId
					logClient({ m: "probe", via, sid: sessionId })
				}
			} catch { /* ignore */ }
			React.useEffect(() => {
				bus.activeSessionId = sessionId
				return () => {
					if (bus.activeSessionId === sessionId) bus.activeSessionId = ""
				}
			}, [sessionId])
			return null
		}

		//#endregion

		//#region dsh-notify: client plugin body

		const inject = ["slots", "sessions"];

		function apply(ctx) {
			logClient({ m: "boot", perm: notifyPermission(), active: bus.activeSessionId });

			// Live host feed: /dsh-notify/feed (same origin, SSE, auto-reconnect).
			const es = new EventSource("/dsh-notify/feed");
			es.onmessage = (event) => {
				try {
					handleNotice(ctx, JSON.parse(event.data));
				} catch (error) {
					console.warn("[dsh-notify] feed message error", error);
				}
			};
			es.onerror = () => { /* EventSource reconnects automatically */ };

			// Ask for notification permission once (shortly after boot) when the
			// page is visible and the browser has not decided yet. The Settings
			// row also exposes an explicit 开启权限 button.
			ctx.effect(() => {
				let permissionTimer = null;
				try {
					if (notifyPermission() === "default" && document.visibilityState === "visible") {
						permissionTimer = setTimeout(() => {
							try {
								Notification.requestPermission().then(() => bump()).catch(() => {});
							} catch { /* ignore */ }
						}, 1500);
					}
				} catch { /* ignore */ }
				return () => {
					if (permissionTimer) clearTimeout(permissionTimer);
					try { es.close(); } catch { /* ignore */ }
				};
			}, "dsh-notify: feed + permission");

			// Settings → General row (mirrors the dsh-skin registration shape:
			// store + inject faces wired by the settings cell owner).
			const store = createNotifyStore();
			const rowInject = (actions) => {
				storeActions = actions;
				pushStore();
				return {
					toggle: (key, value) => {
						if (Object.prototype.hasOwnProperty.call(DEFAULT_CFG, key)) {
							updateCfg({ [key]: Boolean(value) });
						}
					},
					requestPermission: () => requestNotifyPermission(),
					sendTest: (kind) => sendTestNotice(kind),
				};
			};
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: ROW_ID,
				order: 50,
				store,
				inject: rowInject,
			}, NotifyRow));

			// In-page fallback toasts.
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: ROW_ID,
				order: 1000,
			}, ToastLayer));

			// Track which conversation this window is showing (quiet rule).
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: `${ROW_ID}-active`,
				order: 30,
			}, ActiveSessionProbe));
		}

		//#endregion

		exports.inject = inject;
		exports.apply = apply;
		exports.ROW_ID = ROW_ID;
		return module.exports;
	}
});
