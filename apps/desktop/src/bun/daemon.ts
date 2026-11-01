/**
 * JIDE daemon —— 常驻宿主(P1.5)
 *
 * 全部宿主服务在此进程:agent 会话/工作区/终端/计划/测试域/记忆/评审/自动化/工具桥/日志回喂。
 * UI(Electrobun 主进程)变薄客户端:
 *   - 请求:POST /rpc/<method>(Bearer token,body={params})
 *   - 事件:WS /events?token=;连上后可发 {type:"resync", lastSeq} 补缺(journal 回放)
 * 生命周期:app 拉起后常驻 —— app 关了 agent 与 automations 照跑(路线图 Q3)。
 * 单实例:端口/令牌落 <JIDE_HOME>/daemon/;崩溃由 app 下次启动 ensureDaemon 拉新。
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	PROTOCOL_VERSION,
	createEventJournal,
	isHostEventType,
	type HostEvent,
	type HostRequestHandlers,
} from "@jide/contracts";
import { AgentHost } from "./host/agent-host";
import { WorkspaceManager } from "./host/workspace-manager";
import { FileService } from "./host/file-service";
import { TerminalManager } from "./host/terminal-manager";
import { PlanManager } from "./host/plan-manager";
import { DevServerManager } from "./host/devserver-manager";
import { BrowserAutomation } from "./host/browser-automation";
import { ChecksManager } from "./host/checks-manager";
import { ReviewQueue } from "./host/review-queue";
import { MemoryManager } from "./host/memory-manager";
import { SettingsManager } from "./host/settings-manager";
import { CredentialStore } from "./host/credential-store";
import { ToolBridgeServer, type BridgeToolResult } from "./host/bridge-server";
import { DevLogPump } from "./host/dev-log-pump";
import { ModelCatalog } from "./host/model-catalog";
import { AutomationManager } from "./host/automation-manager";
import { OrchestratorManager } from "./host/orchestrator";
import { RaceManager } from "./host/race-manager";
import { TaskManager } from "./host/task-manager";
import { EventStore } from "./host/event-store";
import { applyAutostart, launcherPath } from "./host/autostart";
import { mapFilesToTests as mapTests } from "./host/test-runner";
import { HttpProbe, TestRunner } from "./host/test-runner";

const RUNTIME_ROOT = process.env.JIDE_HOME ?? join(homedir(), ".jide");
const DAEMON_DIR = join(RUNTIME_ROOT, "daemon");
mkdirSync(DAEMON_DIR, { recursive: true });

const logFile = join(DAEMON_DIR, "daemon.log");
const log = (msg: string) => {
	try {
		appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
	} catch {
		/* 日志失败不致命 */
	}
	console.log(`[jide-daemon] ${msg}`);
};

/* ==================== 服务装配(自 index.ts 平移) ==================== */

const host = new AgentHost(RUNTIME_ROOT);
const logPump = new DevLogPump(host, {
	// 两级过滤第二级:粗筛命中 → 模型精判(false=不打断,null=精判不可用回退直推)
	judge: (workspaceId, tail) => orchestrator.judgeLogHit(workspaceId, tail),
});
const workspaces = new WorkspaceManager(RUNTIME_ROOT);
const files = new FileService(workspaces);
const settings = new SettingsManager(RUNTIME_ROOT);
const terminals = new TerminalManager(() => settings.get().terminalShell);
const devservers = new DevServerManager();
const browsers = new BrowserAutomation(RUNTIME_ROOT);
const checks = new ChecksManager(browsers);
const runner = new TestRunner();
const review = new ReviewQueue(workspaces, RUNTIME_ROOT);
const memories = new Map<string, MemoryManager>();
const creds = new CredentialStore();
const plans = new PlanManager(workspaces, RUNTIME_ROOT);
const modelCatalog = new ModelCatalog();

const memoryFor = (workspaceId: string): MemoryManager | null => {
	const { cwd } = workspaces.locate(workspaceId);
	if (!cwd) return null;
	let m = memories.get(workspaceId);
	if (!m) {
		m = new MemoryManager(cwd);
		m.bindEmitter(emit);
		memories.set(workspaceId, m);
	}
	return m;
};

/** 项目根记忆(P3.4 任务经历落点:写在仓库根 .memory,不随 worktree 清理丢失) */
const memoryRoots = new Map<string, MemoryManager>();
const memoryForRoot = (projectId: string): MemoryManager | null => {
	const rec = workspaces.getProject(projectId);
	if (!rec) return null;
	let m = memoryRoots.get(projectId);
	if (!m) {
		m = new MemoryManager(rec.root);
		m.bindEmitter(emit);
		memoryRoots.set(projectId, m);
	}
	return m;
};

function scanTestFiles(cwd: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, rel: string, depth: number) => {
		if (depth > 6) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name === "node_modules" || e.name === ".git" || e.name === "build" || e.name === "dist" || e.name === ".hutch") continue;
			const relPath = rel ? rel + "/" + e.name : e.name;
			if (e.isDirectory()) walk(join(dir, e.name), relPath, depth + 1);
			else if (/\.(test|spec)\.[tj]sx?$/.test(e.name)) out.push(relPath);
		}
	};
	walk(cwd, "", 0);
	return out;
}

/* ---- 工具桥:pi 进程内 jide-tools 扩展回环调用宿主服务(§4 工具协议表) ---- */
const brText = (t: string, isError?: boolean): BridgeToolResult => ({
	content: [{ type: "text", text: t }],
	details: undefined,
	...(isError ? { isError: true } : {}),
});

const bridge = new ToolBridgeServer();

bridge.register("dev_server", async (workspaceId, p) => {
	if (p.action === "stop") {
		const r = await devservers.stop(workspaceId);
		return brText(r.ok ? "dev server 已停止" : r.error, !r.ok);
	}
	if (p.action === "status") {
		return brText(JSON.stringify(devservers.status(workspaceId)));
	}
	const loc = workspaces.locate(workspaceId);
	if (!loc.cwd) return brText("工作区不存在", true);
	const trust = workspaces.requireTrusted(loc.projectId!);
	if (!trust.ok) return brText(trust.error, true);
	const r = await devservers.ensure(workspaceId, {
		command: p.command ?? `bunx vite --port ${p.port ?? 5175}`,
		cwd: loc.cwd,
		port: p.port ?? 5175,
		probe: p.probe ?? "auto",
	});
	if (!r.ok) return brText(`启动失败:${r.error}\n日志尾:\n${r.logTail ?? "(空)"}`, true);
	return brText(`就绪 url=${r.url} probe=${r.probeMode} ${r.startedMs}ms`);
});

bridge.register("http_probe", async (_wid, p) => {
	const r = await HttpProbe.run(p.url, {
		expectStatus: p.expectStatus,
		contains: p.contains,
		jsonPath: p.jsonPath,
		jsonEquals: p.jsonEquals,
	});
	if (!r.ok) return brText(`探测失败:${r.error}`, true);
	return brText(`passed=${r.passed} actual=${r.actual}${r.detail ? ` detail=${r.detail}` : ""}`);
});

bridge.register("browser", async (workspaceId, p) => {
	try {
		switch (p.action) {
			case "navigate": {
				if (!p.url) return brText("参数不足:url 必填", true);
				const r = await browsers.navigate(workspaceId, p.url);
				return r.ok ? brText(`已打开:${p.url}${r.title ? ` (title=${r.title})` : ""}`) : brText(r.error, true);
			}
			case "click": {
				if (!p.selector) return brText("参数不足:selector 必填", true);
				const r = await browsers.click(workspaceId, p.selector);
				return r.ok ? brText(`已点击 ${p.selector}`) : brText(`${r.error}(可稍后重试)`, true);
			}
			case "fill": {
				if (!p.selector) return brText("参数不足:selector 必填", true);
				const r = await browsers.fill(workspaceId, p.selector, p.value ?? "");
				return r.ok ? brText(`已填写 ${p.selector}`) : brText(r.error, true);
			}
			case "hover": {
				if (!p.selector) return brText("参数不足:selector 必填", true);
				const r = await browsers.hover(workspaceId, p.selector);
				return r.ok ? brText(`已 hover ${p.selector}`) : brText(r.error, true);
			}
			case "scroll": {
				await browsers.scroll(workspaceId, p.x ?? 0, p.y ?? 300, p.selector);
				return brText("已滚动");
			}
			case "snapshot": {
				const r = await browsers.snapshot(workspaceId);
				return r.ok ? brText("DOM 快照:\n" + r.outline.slice(0, 2000)) : brText(r.error, true);
			}
			case "console": {
				const msgs = browsers.consoleMessages(workspaceId, 30);
				return brText(msgs.length ? msgs.join("\n") : "(控制台无输出)");
			}
			case "record": {
				const r = await browsers.record(workspaceId, Math.min(p.ms ?? 5000, 30000), 500);
				return r.ok ? brText(`录屏 ${r.frames} 帧 → ${r.dir}(replay.html 可回放)`) : brText(r.error, true);
			}
			case "capture": {
				const r = await browsers.capture(workspaceId, "shot");
				return r.ok
					? brText(`截图已回传:${r.path}(${Math.round((r.dataBase64.length * 0.75) / 1024)}KB)`)
					: brText(r.error, true);
			}
			default:
				return brText("参数不足:action 不识别", true);
		}
	} catch (err: any) {
		return brText(String(err?.message ?? err), true);
	}
});

bridge.register("test_run", async (workspaceId, p) => {
	const loc = workspaces.locate(workspaceId);
	if (!loc.cwd) return brText("工作区不存在", true);
	const trust = workspaces.requireTrusted(loc.projectId!);
	if (!trust.ok) return brText(trust.error, true);
	const allTests = scanTestFiles(loc.cwd);
	const changed: string[] = [];
	if (p.scope !== "all") {
		const st = await workspaces.gitStatus(workspaceId);
		if (st.ok) changed.push(...st.changes.map((c: any) => c.path));
	}
	const selected = p.scope === "all" ? allTests : mapTests(changed, allTests);
	emit({ type: "test.progress", workspaceId, phase: "selecting", selected: selected.length, total: allTests.length, done: 0, passed: 0, failed: 0 });
	if (!selected.length) {
		return brText(`选测 0/${allTests.length}(无关联用例);如需回归请 scope=all`);
	}
	const r = await runner.run(loc.cwd, selected, allTests.length);
	const pass = r.results.filter((x: any) => x.status === "pass").length;
	const fail = r.results.filter((x: any) => x.status === "fail").length;
	emit({ type: "test.progress", workspaceId, phase: "done", selected: r.selected, total: r.total, done: r.results.length, passed: pass, failed: fail });
	const lines = r.results.map(
		(x: any) =>
			`${x.status === "pass" ? "✓" : x.status === "fail" ? "✗" : "–"} ${x.name} ${x.durationMs}ms${x.message ? "\n    " + String(x.message).slice(0, 300) : ""}`,
	);
	return brText(`选测 ${selected.length}/${allTests.length} · 通过 ${pass} · 失败 ${fail} · ${r.durationMs}ms\n${lines.join("\n")}`);
});

bridge.register("checks", async (workspaceId, p) => {
	if (p.action === "create") {
		if (!p.title || !p.assertion) return brText("参数不足:create 需 title 与 assertion", true);
		const r = checks.create(workspaceId, p.title, p.kind ?? "asset", p.assertion);
		return r.ok ? brText(`已创建检查项 ${r.id}(${p.title})`) : brText(r.error, true);
	}
	const r = await checks.run(workspaceId, p.ids);
	if (!r.ok) return brText(r.error ?? "检查项运行失败", true);
	if (r.results.length) {
		review.enqueueChecks(workspaceId, r.results.filter((x: any) => x.passed).length, r.results.length);
	}
	const lines = r.results.map((x: any) => `${x.passed ? "✓" : "✗"} ${x.title}${x.detail ? " · " + x.detail : ""}`);
	return brText(`检查项 ${r.results.filter((x: any) => x.passed).length}/${r.results.length} 通过\n${lines.join("\n")}`);
});

bridge.register("plan", async (workspaceId, p) => {
	if (p.action === "create") {
		if (!p.goal || !p.steps) return brText("参数不足:create 需 goal 与 steps", true);
		const loc = workspaces.locate(workspaceId);
		if (loc.projectId) {
			const t = workspaces.requireTrusted(loc.projectId);
			if (!t.ok) return brText(t.error, true);
		}
		plans.create(workspaceId, p.goal, p.steps);
		return brText(`计划已建立(${p.steps.length} 步),面板可见;逐步执行后用 step_done 推进`);
	}
	if (p.stepIndex === undefined) return brText("参数不足:step_done 需 stepIndex", true);
	const cur = plans.getByWorkspace(workspaceId);
	if (!cur) return brText("当前工作区无进行中计划,先 create", true);
	const r = await plans.stepDone(cur.id, p.stepIndex);
	return r.ok
		? brText(`步骤 ${p.stepIndex + 1} 完成${r.commit ? `,自动提交 ${r.commit.sha}` : ""}`)
		: brText(r.error, true);
});

bridge.register("memory_suggest", async (workspaceId, p) => {
	const m = memoryFor(workspaceId);
	if (!m) return brText("工作区不存在", true);
	m.suggest(p.scope, p.file, p.lines, p.reason);
	return brText(`已生成记忆建议卡片(${p.file},${p.lines.length} 条),等待用户采纳`);
});

bridge.register("terminal_read", async (workspaceId, p) => {
	const list = terminals.listByWorkspace(workspaceId);
	if (!list.length) {
		return brText("当前工作区没有终端(用户尚未在底部面板打开);可请用户开一个,或改用 bash 工具执行命令", true);
	}
	const id = p.terminalId && list.some((t) => t.id === p.terminalId) ? p.terminalId : list[list.length - 1].id;
	const r = terminals.tail(id, Math.min(p.lines ?? 40, 500));
	if (!r.ok) return brText(r.error, true);
	return brText(`[终端 ${id}] 最近输出(尾部 ${r.lines.length} 行):\n${r.lines.join("\n") || "(暂无输出)"}`);
});

bridge.register("terminal_send", async (workspaceId, p) => {
	if (!p.text) return brText("参数不足:text 必填", true);
	const loc = workspaces.locate(workspaceId);
	if (loc.projectId) {
		const t = workspaces.requireTrusted(loc.projectId);
		if (!t.ok) return brText(t.error, true);
	}
	const list = terminals.listByWorkspace(workspaceId);
	if (!list.length) return brText("当前工作区没有终端;可请用户在底部面板打开一个", true);
	const id = p.terminalId && list.some((t) => t.id === p.terminalId) ? p.terminalId : list[list.length - 1].id;
	const r = terminals.write(id, p.text + (p.enter === false ? "" : "\r"));
	return r.ok
		? brText(`已发送到终端 ${id}${p.enter === false ? "(未回车)" : ""};稍后用 terminal_read 查看结果`)
		: brText(r.error, true);
});

bridge.register("git_diff_files", async (workspaceId) => {
	const st = await workspaces.gitStatus(workspaceId);
	if (!st.ok) return brText(st.error, true);
	const paths = st.changes.map((c) => c.path);
	return brText(paths.length ? paths.join("\n") : "(无变更)");
});

/* ---- 编排桥处理器(P2:Router 会话的委派工具) ---- */
bridge.register("spawn_worker", async (workspaceId, p) => {
	try {
		if (!p.objective) return brText("参数不足:objective 必填", true);
		const rec = orchestrator.spawnWorker({
			objective: p.objective,
			workspaceId: p.workspaceId || workspaceId,
			modelKey: p.modelKey,
			timeoutMin: p.timeoutMin,
			speculative: p.speculative === true,
			routerSessionId: p.__router,
		});
		// 任务卡归组(P3.3):同发起方未收口卡附加,否则新卡(聊天轮/Router 分派链路)
		try {
			tasks.attachWorker({ routerSessionId: p.__router, workerId: rec.id, objective: p.objective, workspaceId: rec.workspaceId, source: "chat" });
		} catch { /* 卡域异常不阻塞委派 */ }
		return brText(
			rec.speculative
				? `已委派投机 Worker ${rec.id}(隔离 worktree 静默修复;验证全绿才提交进评审队列,否则丢弃)。`
				: `已委派 Worker ${rec.id}(排队中);用 wait_workers({workerIds:["${rec.id}"]}) 收结果。`,
		);
	} catch (err: any) {
		return brText(String(err?.message ?? err), true);
	}
});
bridge.register("wait_workers", async (_wid, p) => {
	try {
		const ids: string[] = Array.isArray(p.workerIds) ? p.workerIds : [];
		const out = await orchestrator.waitWorkers(ids, Math.min(p.timeoutSec ?? 300, 600));
		if (!out.length) return brText("没有可等待的 Worker");
		const lines = out.map(
			(w) =>
				`${w.id} · ${w.status}${w.durationMs !== undefined ? ` · ${Math.round(w.durationMs / 1000)}s` : ""}${w.summary ? `\n  摘要:${w.summary.slice(0, 400)}` : ""}${w.error ? `\n  错误:${w.error.slice(0, 200)}` : ""}`,
		);
		return brText(lines.join("\n"));
	} catch (err: any) {
		return brText(String(err?.message ?? err), true);
	}
});
bridge.register("worker_status", async (_wid, p) => {
	const list = p.workerId ? [orchestrator.get(p.workerId)].filter(Boolean) : orchestrator.list();
	if (!list.length) return brText("暂无 Worker");
	return brText(
		list
			.map((w: any) => `${w.id} · ${w.status}${w.durationMs !== undefined ? ` · ${Math.round(w.durationMs / 1000)}s` : ""} · 目标:${w.objective.slice(0, 60)}${w.summary ? ` · ${w.summary.slice(0, 120)}` : ""}${w.error ? ` · ${w.error.slice(0, 120)}` : ""}`)
			.join("\n"),
	);
});
bridge.register("send_to_worker", async (_wid, p) => {
	try {
		if (!p.workerId || !p.text) return brText("参数不足:workerId 与 text 必填", true);
		await orchestrator.sendToWorker(p.workerId, p.text);
		return brText(`已追加到 Worker ${p.workerId};完成会另行回喂。`);
	} catch (err: any) {
		return brText(String(err?.message ?? err), true);
	}
});
bridge.register("stop_worker", async (_wid, p) => {
	try {
		if (!p.workerId) return brText("参数不足:workerId 必填", true);
		await orchestrator.stopWorker(p.workerId);
		return brText(`Worker ${p.workerId} 已中断。`);
	} catch (err: any) {
		return brText(String(err?.message ?? err), true);
	}
});
bridge.register("start_race", async (workspaceId, p) => {
	try {
		if (!p.objective) return brText("参数不足:objective 必填", true);
		const raceId = await races.start({
			objective: p.objective,
			workspaceId: p.workspaceId || workspaceId,
			variants: p.variants,
			timeoutMin: p.timeoutMin,
			routerSessionId: p.__router,
		});
		try {
			const race = races.get(raceId);
			if (race) tasks.beginRace({ raceId, objective: race.objective, workspaceId: p.workspaceId || workspaceId, workerIds: race.entries.map((en) => en.workerId) });
		} catch { /* 卡域异常不阻塞开赛 */ }
		return brText(`竞赛 ${raceId} 已开赛(${(p.variants?.length ?? 3)} 路并行,隔离 worktree)。收束后自动评分,用户在竞赛面板人工选优;结果也会回喂本对话。`);
	} catch (err: any) {
		return brText(String(err?.message ?? err), true);
	}
});

host.bindBridge(bridge);

/* ---- 编排层(P2):当前对话即 Router,委派 Worker 池;含精判会话与投机收口 ---- */
const orchestrator = new OrchestratorManager({
	host,
	workspaces,
	verify: {
		scanTests: scanTestFiles,
		gitStatus: (workspaceId) => workspaces.gitStatus(workspaceId),
		mapTests: mapTests,
		runTests: (cwd, files_, total) => runner.run(cwd, files_, total),
		runChecks: (workspaceId) => checks.run(workspaceId),
		enqueueChecks: (workspaceId, passed, total) => review.enqueueChecks(workspaceId, passed, total),
		commitAll: (workspaceId, message) => workspaces.commitAll(workspaceId, message, true),
		enqueueCommit: (workspaceId, branch, sha, message) => review.enqueueCommit(workspaceId, branch, sha, message),
	},
	getRouterModelKey: () => settings.get().routerModel || settings.get().defaultModel,
	judgeCwd: RUNTIME_ROOT,
});

/* dev server 逐行日志 → 回喂泵(错误检测 + 节流;精判钩子:模型判定是否值得打断) */
devservers.onLogLine = (workspaceId, line) => logPump.onLine(workspaceId, line);

/* ==================== 事件出口:journal 分配 seq + 落盘 + WS 广播 ==================== */
// 唯一事实源:全部事件(宿主+服务)在此分配单调 seq;resync 回放以本 journal 为准;
// EventStore 落盘供 daemon 重启回读近期上下文与调试轨迹。

const clients = new Set<ServerWebSocket>();
const journal = createEventJournal();
const eventStore = new EventStore(DAEMON_DIR);
for (const e of eventStore.load()) journal.append(e); // 重启回读(seq 重编号;跨重启 resync 由快照类 RPC 兜底)

const emit = (raw: HostEvent) => {
	if (!isHostEventType(raw?.type)) return;
	const e = journal.append(raw) as HostEvent;
	eventStore.append(e);
	const line = JSON.stringify(e);
	for (const ws of clients) {
		try {
			ws.send(line);
		} catch {
			/* 客户端断开由 close 清理 */
		}
	}
	if (e.type === "host.log") log(`[host.${e.level}] ${e.message}`);
	logPump.handleHostEvent(e);
	automations.handleHostEvent(e);
	orchestrator.handleHostEvent(e);
	tasks.handleHostEvent(e);
};

host.bindEmitter(emit);
logPump.bindEmitter(emit);
workspaces.bindEmitter(emit);
terminals.bindEmitter(emit);
plans.bindEmitter(emit);
plans.setReviewQueue(review as any);
devservers.bindEmitter(emit);
browsers.bindEmitter(emit);
checks.bindEmitter(emit);
review.bindEmitter(emit);
orchestrator.bindEmitter(emit);
orchestrator.startWatchdog();
checks.setCwdResolver((workspaceId) => workspaces.locate(workspaceId).cwd);

/* ---- 竞赛域(P3):fan-out 一拖 N 对比选优 ---- */
const races = new RaceManager({
	orchestrator,
	workspaces,
	review: {
		enqueueCommit: (workspaceId, branch, sha, message) => review.enqueueCommit(workspaceId, branch, sha, message),
		pendingCommitItem: (workspaceId, sha) => review.pendingCommitItem(workspaceId, sha),
		decide: (id, decision) => review.decide(id, decision),
	},
	verify: {
		scanTests: scanTestFiles,
		gitStatus: (workspaceId) => workspaces.gitStatus(workspaceId),
		mapTests: mapTests,
		runTests: (cwd, files_, total) => runner.run(cwd, files_, total),
		runChecks: (workspaceId) => checks.run(workspaceId),
	},
	runtimeRoot: RUNTIME_ROOT,
});
races.setCommitFn((workspaceId, message) => workspaces.commitAll(workspaceId, message, true));
races.bindEmitter(emit);
races.startWatching();

/* ---- 自动化域(P1.5;P3 起 dispatch=router 经常驻 Router 拆解分派) ---- */
const automations = new AutomationManager({
	host,
	workspaces,
	runtimeRoot: RUNTIME_ROOT,
	verify: {
		scanTests: scanTestFiles,
		gitStatus: (workspaceId) => workspaces.gitStatus(workspaceId),
		mapTests: mapTests,
		runTests: (cwd, files_, total) => runner.run(cwd, files_, total),
		runChecks: (workspaceId) => checks.run(workspaceId),
		enqueueChecks: (workspaceId, passed, total) => review.enqueueChecks(workspaceId, passed, total),
	},
	orchestrator: {
		ensureRouter: () => orchestrator.ensureRouter(),
		onWorkerUpdate: (cb) => orchestrator.onWorkerUpdate(cb),
		waitWorkers: (ids, timeoutSec) => orchestrator.waitWorkers(ids, timeoutSec),
	},
});
automations.bindEmitter(emit);
automations.start();

/* ---- 任务卡看板(P3.3):聚合 Worker 池/竞赛/自动化运行;兼 Worker 面板 ---- */
const tasks = new TaskManager({
	runtimeRoot: RUNTIME_ROOT,
	getAutomation: (id) => automations.get(id),
	getRace: (id) => races.get(id),
	// P3.4 长期记忆:任务终态 → 项目根 .memory/project/experience.md(系统任务沉淀通道)
	onFinalize: (task) => {
		try {
			if (!task.workspaceId) return;
			const pid = workspaces.locate(task.workspaceId).projectId;
			if (!pid) return;
			memoryForRoot(pid)?.appendExperience({
				outcome: task.status === "done" ? "done" : task.status === "cancelled" ? "cancelled" : "failed",
				source: task.source,
				title: task.title,
				summary: task.summary,
			});
		} catch {
			/* 经历写入失败不影响卡域 */
		}
	},
});
tasks.bindEmitter(emit);
tasks.bindWorkerLookup((id) => orchestrator.get(id));
orchestrator.onWorkerUpdate((rec) => tasks.onWorkerUpdate(rec));

/* ==================== 请求处理(窗口本地项除外,全在此) ==================== */

const handlers = {
	/* ---------- 协议与会话 ---------- */
	"session.create": async ({ workspacePath }: any) => {
		try {
			let memoryContext: string | undefined;
			const memByPath = [...memories.entries()].find(([, m]) => (m as any).cwd === workspacePath)?.[1];
			if (memByPath) {
				const inj = memByPath.inject([]);
				memoryContext = inj.text || undefined;
			}
			let workspaceId: string | undefined;
			try {
				workspaceId = (await workspaces.findByPath(workspacePath))?.workspaceId;
			} catch {
				/* 反查失败不阻塞会话创建(工具返回明确错误) */
			}
			const modelKey = settings.get().defaultModel;
			const { parseModelKey } = await import("@jide/contracts");
			const model = parseModelKey(modelKey) ?? undefined;
			// 编排模式(P2):编排会话注入 jide-orchestrator 扩展(委派工具),会话即 Router
			const orchestratorEnabled = settings.get().orchestrator !== false;
			const entry = await host.createSession({ workspacePath, memoryContext, workspaceId, model, orchestrator: orchestratorEnabled });
			return { ok: true, sessionId: entry.sessionId, modelLabel: entry.modelLabel };
		} catch (err: any) {
			host.log("error", `会话创建失败:${err?.message ?? err}`);
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"session.prompt": async ({ sessionId, text }: any) => {
		try {
			await host.prompt(sessionId, text);
			return { ok: true };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"session.abort": async ({ sessionId }: any) => {
		try {
			await host.abort(sessionId);
			return { ok: true };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"session.rebuild": async ({ sessionId }: any) => {
		try {
			const { entry, restored } = await host.rebuild(sessionId);
			return { ok: true, sessionId: entry.sessionId, restoredMessages: restored };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"session.get": ({ sessionId }: any) => {
		const snap = host.getSnapshot(sessionId);
		if (!snap) return { ok: false, error: `会话不存在:${sessionId}` };
		return { ok: true, ...snap };
	},
	"session.respondUI": ({ sessionId, requestId, value, confirmed, cancelled }: any) => {
		try {
			host.respondUI(sessionId, { requestId, value, confirmed, cancelled });
			return { ok: true };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"session.setModel": async ({ sessionId, provider, modelId }: any) => {
		try {
			const modelLabel = await host.setModel(sessionId, provider, modelId);
			return { ok: true, modelLabel };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"session.setThinkingLevel": async ({ sessionId, level }: any) => {
		try {
			await host.setThinkingLevel(sessionId, level);
			return { ok: true, level };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"session.getThinkingLevels": async ({ sessionId }: any) => {
		try {
			return { ok: true, levels: await host.getThinkingLevels(sessionId) };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"session.setPermissionMode": ({ sessionId, mode }: any) => {
		try {
			if (mode !== "auto" && mode !== "confirm") throw new Error(`权限模式不合法:${mode}`);
			const cwd = host.getSession(sessionId)?.cwd;
			if (!cwd) throw new Error("会话不存在");
			// guard 扩展每次 bash tool_call 读取(工作区级语义:同项目会话共享)
			const dir = join(cwd, ".jide");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "guard-mode.json"), JSON.stringify({ mode }));
			host.log("info", `权限模式已切换:${mode === "confirm" ? "执行前确认" : "自动"}`);
			return { ok: true };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"session.askWithContext": ({ workspaceId, source, contextText }: any) => {
		emit({ type: "host.log", level: "info", message: `[${source}] ${contextText.slice(0, 200)}` });
		return { ok: true };
	},

	/* ---------- 工作区(W1-W4) ---------- */
	"settings.get": () => ({ ok: true, settings: settings.get() }),
	"settings.set": ({ patch }: any) => {
		const before = settings.get().autostart;
		const next = settings.set(patch);
		// 开机自启副作用:仅当 launcher 真实存在(打包态);源码态 exe 为构建产物,跳过
		if (patch?.autostart !== undefined && next.autostart !== before) {
			const appDir = import.meta.dir;
			const lp = launcherPath(appDir);
			if (!existsSync(lp)) {
				log("autostart 跳过:未找到 launcher.exe(源码运行态)");
			} else {
				const r = applyAutostart(next.autostart, appDir);
				if (!r.ok) log(`autostart 写入失败:${r.error ?? ""}`);
			}
		}
		return { ok: true, settings: next };
	},
	"credential.list": async () => {
		try {
			return { ok: true, names: await creds.listUsers() };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"credential.set": async ({ name, secret }: any) => {
		const r = await creds.set(name, secret);
		return r.ok ? { ok: true } : { ok: false, error: r.error ?? "凭据写入失败" };
	},
	"credential.delete": async ({ name }: any) => {
		await creds.delete(name);
		return { ok: true };
	},
	"project.clone": async ({ url, dir }: any) => {
		try {
			const target = dir.replace(/[\\/]+$/, "");
			if (!/^https?:\/\/|git@|ssh:\/\//.test(url)) return { ok: false, error: "远程地址格式不合法" };
			const proc = Bun.spawn(["git", "clone", "--progress", url, target], { stdout: "pipe", stderr: "pipe" });
			const err = await new Response(proc.stderr).text();
			const code = await proc.exited;
			if (code !== 0) {
				const lines = err.trim().split(/\r?\n/).filter(Boolean);
				return { ok: false, error: lines[lines.length - 1] ?? "克隆失败" };
			}
			return { ok: true, folder: target };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"project.open": async ({ path }: any) => {
		const r = await workspaces.openProject(path);
		if (!r.opened) return { ok: false, error: r.reason };
		return { ok: true, projectId: r.project.id, root: r.project.root, name: r.project.name, trusted: r.project.trusted, isRepo: true, branch: r.branch };
	},
	"project.trust": ({ projectId }: any) => {
		const ok = workspaces.trustProject(projectId);
		return ok ? { ok: true, trusted: true } : { ok: false, error: "项目未打开" };
	},
	"workspace.list": async ({ projectId }: any) => {
		const list = await workspaces.listWorkspaces(projectId);
		const rec = workspaces.getProject(projectId);
		return {
			ok: true,
			activeWorkspaceId: rec?.activeWorkspaceId ?? list[0]?.id ?? null,
			workspaces: list.map((w) => ({ id: w.id, kind: w.kind, branch: w.branch, path: w.path, baseRef: w.baseRef })),
		};
	},
	"workspace.create": async ({ projectId, name, fromRef, parentWorkspaceId }: any) => {
		const r = await workspaces.createWorktree(projectId, name, { fromRef, parentWorkspaceId, source: parentWorkspaceId ? "stack" : "user" });
		if (!r.ok) return { ok: false, error: r.error };
		try {
			const rec = workspaces.getProject(projectId);
			if (rec) {
				const srcDir = join(RUNTIME_ROOT, "sessions", rec.root.replace(/[^a-zA-Z0-9_-]+/g, "--"));
				const destDir = join(RUNTIME_ROOT, "sessions", r.path.replace(/[^a-zA-Z0-9_-]+/g, "--"));
				const fsFiles = readdirSync(srcDir).filter((f) => f.endsWith(".jsonl")).sort();
				const latest = fsFiles[fsFiles.length - 1];
				if (latest) {
					mkdirSync(destDir, { recursive: true });
					copyFileSync(join(srcDir, latest), join(destDir, latest));
				}
			}
		} catch {
			/* 无源会话 */
		}
		return { ok: true, workspaceId: r.workspaceId, path: r.path, branch: r.branch };
	},
	"workspace.switch": async ({ projectId, workspaceId }: any) => {
		const r = await workspaces.switchWorkspace(projectId, workspaceId);
		return r.ok ? { ok: true, activeWorkspaceId: r.activeWorkspaceId } : { ok: false, error: r.error };
	},
	/* ---- P3.2:用户提交与评审入队(合并走 W6 门禁;stacked 按血缘) ---- */
	"git.commitAll": async ({ workspaceId, message }: any) => {
		try {
			const r = await workspaces.commitAll(workspaceId, String(message ?? "").trim(), false);
			if (!r.ok) return { ok: false, error: r.error };
			return { ok: true, sha: r.sha, message: r.message };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"review.enqueueCommit": async ({ workspaceId, sha, message }: any) => {
		try {
			const projectId = workspaceId.split(":")[0];
			const info = workspaces.getWorkspace(projectId, workspaceId);
			if (!info?.branch || info.branch === "(detached)") return { ok: false, error: "工作区分支不可用" };
			if (info.kind === "default") return { ok: false, error: "Default 工作区即主线,无需送审" };
			// sha 缺省 = 工作区分支当前 HEAD
			let headSha = sha as string | undefined;
			if (!headSha) {
				const log = await workspaces.gitLog(workspaceId, 1);
				if (!log.ok || !log.commits.length) return { ok: false, error: "分支无提交,无内容可送审" };
				headSha = log.commits[0].sha;
			}
			// 血缘:stacked 子工作区以父分支为基分支(评审合链自底向上)
			const meta = workspaces.getProject(projectId)?.worktrees?.[workspaceId];
			let baseBranch: string | undefined;
			if (meta?.parentWorkspaceId) {
				baseBranch = workspaces.getWorkspace(projectId, meta.parentWorkspaceId)?.branch;
			}
			const item = review.enqueueCommit(workspaceId, info.branch, headSha, message ?? `工作区送审:${info.branch}`, { baseBranch });
			return { ok: true, itemId: item.id };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},

	/* ---------- 文件 ---------- */
	"fs.list": ({ workspaceId, relPath }: any) => {
		const r = files.list(workspaceId, relPath);
		return r.ok ? { ok: true, entries: r.entries } : { ok: false, error: r.error };
	},
	"fs.read": ({ workspaceId, relPath }: any) => {
		const r = files.read(workspaceId, relPath);
		return r.ok ? { ok: true, content: r.content, size: r.size } : { ok: false, error: r.error };
	},
	"fs.write": ({ workspaceId, relPath, content }: any) => {
		const r = files.write(workspaceId, relPath, content);
		return r.ok ? { ok: true } : { ok: false, error: r.error };
	},
	"fs.search": ({ workspaceId, query, maxResults }: any) => {
		const { cwd } = workspaces.locate(workspaceId);
		if (!cwd) return { ok: false, error: "工作区不存在" };
		const results: Array<{ path: string; line: number; text: string }> = [];
		const q = query.toLowerCase();
		const walk = (dir: string, rel: string, depth: number) => {
			if (depth > 6 || results.length >= (maxResults ?? 100)) return;
			let entries;
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				if (e.name === "node_modules" || e.name === ".git" || e.name === "build" || e.name === "dist" || e.name === ".hutch") continue;
				const relPath = rel ? rel + "/" + e.name : e.name;
				if (e.isDirectory()) {
					walk(join(dir, e.name), relPath, depth + 1);
					continue;
				}
				if (!/\.(ts|tsx|js|jsx|json|md|css|html|py|go|rs)$/.test(e.name)) continue;
				try {
					const content = readFileSync(join(dir, e.name), "utf8");
					const lines = content.split(/\r?\n/);
					for (let i = 0; i < lines.length && results.length < (maxResults ?? 100); i++) {
						const low = lines[i].toLowerCase();
						const at = low.indexOf(q);
						if (at >= 0) results.push({ path: relPath, line: i + 1, text: lines[i].trim().slice(0, 160) });
					}
				} catch {
					/* binary/locked */
				}
			}
		};
		walk(cwd, "", 0);
		return { ok: true, results };
	},

	/* ---------- 终端 ---------- */
	"terminal.create": ({ workspaceId, cwd }: any) => {
		const { projectId } = workspaces.locate(workspaceId);
		if (projectId) {
			const t = workspaces.requireTrusted(projectId);
			if (!t.ok) return { ok: false, error: t.error };
		} else {
			return { ok: false, error: "工作区不存在" };
		}
		const entry = terminals.create(workspaceId, cwd ?? undefined);
		return { ok: true, terminalId: entry.id };
	},
	"terminal.write": ({ terminalId, data }: any) => {
		const r = terminals.write(terminalId, data);
		return r.ok ? { ok: true } : { ok: false, error: r.error };
	},
	"terminal.resize": ({ terminalId, cols, rows }: any) => {
		const r = terminals.resize(terminalId, cols, rows);
		return r.ok ? { ok: true } : { ok: false, error: r.error };
	},
	"terminal.dispose": ({ terminalId }: any) => {
		const r = terminals.dispose(terminalId);
		return r.ok ? { ok: true } : { ok: false, error: r.error };
	},

	/* ---------- 计划(W5) ---------- */
	"plan.create": ({ workspaceId, goal, steps }: any) => {
		const { projectId } = workspaces.locate(workspaceId);
		if (projectId) {
			const t = workspaces.requireTrusted(projectId);
			if (!t.ok) return { ok: false, error: t.error };
		}
		const plan = plans.create(workspaceId, goal, steps);
		return { ok: true, planId: plan.id };
	},
	"plan.stepDone": async ({ planId, stepIndex }: any) => {
		const r = await plans.stepDone(planId, stepIndex);
		return r.ok ? { ok: true, ...(r.commit ? { commit: r.commit } : {}) } : { ok: false, error: r.error };
	},
	"plan.get": ({ workspaceId }: any) => {
		const plan = plans.getByWorkspace(workspaceId);
		return {
			ok: true,
			plan: plan
				? {
						planId: plan.id,
						goal: plan.goal,
						steps: plan.steps.map((st) => ({ text: st.text, state: st.state, ...(st.commit ? { commit: st.commit } : {}) })),
					}
				: null,
		};
	},

	/* ---------- Git 呈现 ---------- */
	"git.status": async ({ workspaceId }: any) => {
		const r = await workspaces.gitStatus(workspaceId);
		return r.ok ? { ok: true, branch: r.branch, changes: r.changes, ahead: r.ahead, behind: r.behind } : { ok: false, error: r.error };
	},
	"git.log": async ({ workspaceId, limit }: any) => {
		const r = await workspaces.gitLog(workspaceId, limit);
		return r.ok ? { ok: true, commits: r.commits } : { ok: false, error: r.error };
	},
	"git.fileDiff": async ({ workspaceId, path }: any) => {
		const r = await workspaces.fileDiff(workspaceId, path);
		return r.ok
			? { ok: true, path, headContent: r.headContent, workContent: r.workContent, headExists: r.headExists }
			: { ok: false, error: r.error };
	},
	"git.sync": async ({ workspaceId }: any) => {
		const r = await workspaces.sync(workspaceId);
		return r.ok ? { ok: true, fetched: r.fetched, ahead: r.ahead, behind: r.behind } : { ok: false, error: r.error };
	},
	"git.openPullRequest": async ({ workspaceId }: any) => {
		const url = await workspaces.remoteCompareUrl(workspaceId);
		if (!url) return { ok: false, error: "无远端或当前在 main" };
		Bun.spawn(["cmd", "/c", "start", "", url], { stdout: "ignore", stderr: "ignore" });
		return { ok: true, url };
	},

	/* ---------- 测试域 M3(4A-4F) ---------- */
	"devserver.ensure": async ({ workspaceId, command, cwd, port, probe, readyPattern }: any) => {
		const loc = workspaces.locate(workspaceId);
		if (!loc.cwd) return { ok: false, error: "工作区不存在" };
		const trust = workspaces.requireTrusted(loc.projectId!);
		if (!trust.ok) return { ok: false, error: trust.error };
		try {
			const r = await devservers.ensure(workspaceId, {
				command: command ?? "bunx vite --port " + (port ?? 5175),
				cwd: cwd ?? loc.cwd,
				port: port ?? 5175,
				probe: probe ?? "auto",
				readyPattern,
			});
			return r.ok
				? { ok: true, url: r.url, port: r.port, probeMode: r.probeMode, startedMs: r.startedMs }
				: { ok: false, error: r.error, logTail: r.logTail };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"devserver.stop": async ({ workspaceId }: any) => {
		const r = await devservers.stop(workspaceId);
		return r.ok ? { ok: true } : { ok: false, error: r.error };
	},
	"devserver.status": ({ workspaceId }: any) => devservers.status(workspaceId),
	"probe.http": ({ url, expectStatus, contains, jsonPath, jsonEquals }: any) => HttpProbe.run(url, { expectStatus, contains, jsonPath, jsonEquals }),
	"test.run": async ({ workspaceId, scope, files: testFiles }: any) => {
		const loc = workspaces.locate(workspaceId);
		if (!loc.cwd) return { ok: false, error: "工作区不存在" };
		const trust = workspaces.requireTrusted(loc.projectId!);
		if (!trust.ok) return { ok: false, error: trust.error };
		const allTests = scanTestFiles(loc.cwd);
		const changed: string[] = [];
		if (scope !== "all") {
			const st = await workspaces.gitStatus(workspaceId);
			if (st.ok) changed.push(...st.changes.map((c) => c.path));
			if (scope === "files" && testFiles) changed.push(...testFiles);
		}
		const selected = scope === "all" ? allTests : mapTests(changed, allTests);
		emit({ type: "test.progress", workspaceId, phase: "selecting", selected: selected.length, total: allTests.length, done: 0, passed: 0, failed: 0 });
		if (selected.length === 0 && scope !== "all") {
			return { ok: true, selected: 0, total: allTests.length, durationMs: 0, results: [] };
		}
		const r = await runner.run(loc.cwd, scope === "all" ? allTests : selected, allTests.length);
		const pass = r.results.filter((x) => x.status === "pass").length;
		const fail = r.results.filter((x) => x.status === "fail").length;
		emit({ type: "test.progress", workspaceId, phase: "done", selected: r.selected, total: r.total, done: r.results.length, passed: pass, failed: fail });
		return r.ok
			? { ok: true, selected: r.selected, total: r.total, durationMs: r.durationMs, results: r.results }
			: { ok: false, error: "runner 失败" };
	},

	"checks.list": ({ workspaceId }: any) => ({ ok: true, checks: checks.list(workspaceId) }),
	"checks.create": ({ workspaceId, title, kind, assertion, appliesTo }: any) => {
		const r = checks.create(workspaceId, title, kind, assertion, appliesTo);
		return r.ok ? { ok: true, id: r.id } : { ok: false, error: r.error };
	},
	"checks.run": async ({ workspaceId, ids }: any) => {
		const r = await checks.run(workspaceId, ids);
		if (r.ok && r.results.length) {
			const pass = r.results.filter((x: any) => x.passed).length;
			review.enqueueChecks(workspaceId, pass, r.results.length);
		}
		return r;
	},
	"checks.delete": ({ workspaceId, id }: any) => checks.delete(workspaceId, id),

	"browser.navigate": async ({ workspaceId, url }: any) => {
		try {
			const r = await browsers.navigate(workspaceId, url);
			return r.ok ? { ok: true, title: r.title } : { ok: false, error: r.error };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"browser.click": async ({ workspaceId, selector }: any) => {
		try {
			return await browsers.click(workspaceId, selector);
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"browser.hover": async ({ workspaceId, selector }: any) => {
		try {
			return await browsers.hover(workspaceId, selector);
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"browser.scroll": async ({ workspaceId, x, y, selector }: any) => {
		try {
			return await browsers.scroll(workspaceId, x, y, selector);
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"browser.snapshot": async ({ workspaceId }: any) => {
		try {
			return await browsers.snapshot(workspaceId);
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"browser.console": ({ workspaceId, limit }: any) => ({ ok: true, messages: browsers.consoleMessages(workspaceId, limit) }),
	"browser.record": async ({ workspaceId, ms, intervalMs }: any) => {
		try {
			return await browsers.record(workspaceId, ms, intervalMs);
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"browser.capture": async ({ workspaceId, kind }: any) => {
		try {
			return await browsers.capture(workspaceId, kind);
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"run.agentSelfTest": async ({ workspaceId }: any) => {
		const loc = workspaces.locate(workspaceId);
		if (!loc.cwd) return { ok: false, error: "工作区不存在" };
		const allTests = scanTestFiles(loc.cwd);
		const st = await workspaces.gitStatus(workspaceId);
		const changed = st.ok ? st.changes.map((c) => c.path) : [];
		const selected = mapTests(changed, allTests);
		const t = selected.length ? await runner.run(loc.cwd, selected, allTests.length) : { selected: 0, total: allTests.length, results: [] as any[] };
		const c = await checks.run(workspaceId);
		const pass = t.results.filter((x: any) => x.status === "pass").length;
		const fail = t.results.filter((x: any) => x.status === "fail").length;
		const cPass = c.results.filter((x: any) => x.passed).length;
		const summary = `测试 ${pass}/${pass + fail}(选测 ${t.selected}/${t.total}) · 检查项 ${cPass}/${c.results.length}`;
		return { ok: true, summary };
	},

	"review.list": ({ projectId }: any) => ({ ok: true, items: review.list(projectId) }),
	"review.decide": ({ id, decision, note }: any) => review.decide(id, decision, note),

	/* ---------- 记忆域 M4 ---------- */
	"memory.status": ({ workspaceId }: any) => {
		const m = memoryFor(workspaceId);
		if (!m) return { ok: false, error: "工作区不存在" };
		return {
			ok: true,
			budget: m.budget(),
			entries: m.list().map((e) => ({ scope: e.scope, file: e.file, source: e.source, lines: e.lines, lastHit: e.lastHit })),
			agentsMd: m.readAgents(),
		};
	},
	"memory.suggest": ({ workspaceId, scope, file, lines, reason }: any) => {
		const m = memoryFor(workspaceId);
		if (!m) return { ok: false, error: "工作区不存在" };
		const s = m.suggest(scope, file, lines, reason);
		return { ok: true, suggestionId: s.id };
	},
	"memory.decide": ({ suggestionId, action, editedLines }: any) => {
		for (const [wid, m] of memories.entries()) {
			if (action === "adopt") {
				const sg = (m as any).suggestions?.get(suggestionId);
				const r = m.adopt(suggestionId, editedLines);
				if (r.ok) {
					review.enqueueMemory(wid, "记忆 · " + (sg?.file ?? ""), (sg?.lines ?? []).slice(0, 2).join(" / "));
					return r;
				}
			} else {
				const r = m.ignore(suggestionId);
				if (r.ok) return r;
			}
		}
		return { ok: false, error: "建议不存在" };
	},
	"memory.tidy": ({ workspaceId }: any) => {
		const m = memoryFor(workspaceId);
		if (!m) return { ok: false, error: "工作区不存在" };
		return m.tidy();
	},
	"memory.revertTidy": ({ workspaceId }: any) => {
		const m = memoryFor(workspaceId);
		if (!m) return { ok: false, error: "工作区不存在" };
		return { ok: true, restored: m.revertTidy() };
	},
	"memory.recall": ({ workspaceId, keywords }: any) => {
		const m = memoryFor(workspaceId);
		if (!m) return { ok: false, error: "工作区不存在" };
		return { ok: true, hits: m.recallKeywords(keywords) };
	},

	/* ---------- 模型与自动化 ---------- */
	"models.list": async ({ refresh }: any) => {
		try {
			const models = await modelCatalog.list(refresh === true);
			return { ok: true, models };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"automations.list": () => {
		const { automations: list, runs } = automations.list();
		return { ok: true, automations: list, runs };
	},
	"automations.save": ({ automation }: any) => {
		try {
			const saved = automations.save(automation);
			return { ok: true, automation: saved };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"automations.delete": ({ id }: any) => {
		try {
			automations.delete(id);
			return { ok: true };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"automations.run": async ({ id }: any) => {
		try {
			const rec = await automations.run(id, "manual");
			return { ok: true, runId: rec.id };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"automations.runs": ({ id }: any) => ({ ok: true, runs: automations.list().runs[id] ?? [] }),

	/* ---------- 编排域(P2) ---------- */
	"orchestrator.workers": () => {
		return { ok: true, workers: orchestrator.list() };
	},

	/* ---------- 任务卡看板(P3.3) ---------- */
	"tasks.list": () => {
		return { ok: true, tasks: tasks.list() };
	},
	"tasks.dismiss": ({ taskId }: any) => {
		return tasks.dismiss(taskId);
	},

	/* ---------- 竞赛域(P3) ---------- */
	"races.list": () => {
		return { ok: true, races: races.list() };
	},
	"races.start": async ({ objective, workspaceId, variants, timeoutMin, __router }: any) => {
		try {
			const raceId = await races.start({ objective, workspaceId, variants, timeoutMin, routerSessionId: __router });
			try {
				const race = races.get(raceId);
				if (race) tasks.beginRace({ raceId, objective: race.objective, workspaceId, workerIds: race.entries.map((en) => en.workerId) });
			} catch { /* 卡域异常不阻塞开赛 */ }
			return { ok: true, raceId };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"races.resolve": async ({ raceId, winnerWorkerId, note }: any) => {
		try {
			const r = await races.resolve(raceId, winnerWorkerId, note);
			return { ok: true, ...r };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"races.discard": async ({ raceId, note }: any) => {
		try {
			await races.discard(raceId, note);
			return { ok: true };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"races.cancel": async ({ raceId }: any) => {
		try {
			await races.cancel(raceId);
			return { ok: true };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
} satisfies Omit<
	HostRequestHandlers,
	"app.hello" | "project.pickFolder" | "preview.open" | "window.minimize" | "window.toggleMaximize" | "window.close"
> as Record<string, (params: any) => any>;

/* ==================== HTTP + WS 服务 ==================== */

const tokenBytes = new Uint8Array(32);
crypto.getRandomValues(tokenBytes);
const token = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, "0")).join("");

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(req, srv) {
		const url = new URL(req.url);
		if (url.pathname === "/health") {
			return Response.json({ ok: true, protocol: PROTOCOL_VERSION, pid: process.pid });
		}
		const auth = req.headers.get("authorization") ?? "";
		if (auth !== `Bearer ${token}` && url.searchParams.get("token") !== token) {
			return new Response("unauthorized", { status: 401 });
		}
		if (url.pathname === "/events") {
			if (srv.upgrade(req, { data: undefined })) return;
			return new Response("upgrade failed", { status: 500 });
		}
		if (req.method === "POST" && url.pathname.startsWith("/rpc/")) {
			const method = decodeURIComponent(url.pathname.slice("/rpc/".length));
			const h = handlers[method];
			if (!h) return Response.json({ ok: false, error: `未知方法:${method}` }, { status: 404 });
			return (async () => {
				try {
					const body = await req.json().catch(() => ({}) as any);
					const result = await h(body?.params ?? {});
					return Response.json(result ?? { ok: true });
				} catch (err: any) {
					return Response.json({ ok: false, error: String(err?.message ?? err) });
				}
			})();
		}
		return new Response("not found", { status: 404 });
	},
	websocket: {
		open(ws) {
			clients.add(ws);
		},
		close(ws) {
			clients.delete(ws);
		},
		message(ws, msg) {
			try {
				const m = JSON.parse(String(msg));
				if (m?.type === "resync") {
					for (const e of journal.since(Number(m.lastSeq) || 0)) ws.send(JSON.stringify(e));
				}
			} catch {
				/* 非 JSON 忽略 */
			}
		},
	},
});

writeFileSync(join(DAEMON_DIR, "port"), String(server.port));
writeFileSync(join(DAEMON_DIR, "token"), token);
writeFileSync(join(DAEMON_DIR, "pid"), String(process.pid));
log(`daemon 就绪 127.0.0.1:${server.port} · protocol v${PROTOCOL_VERSION} · pid ${process.pid}`);

/* ==================== 冒烟钩子(自 index.ts 平移,daemon 侧服务直调) ==================== */

if (process.env.JIDE_SMOKE_PLAN) {
	const wid = process.env.JIDE_SMOKE_PLAN;
	setTimeout(async () => {
		try {
			await workspaces.listWorkspaces(wid.split(":")[0]);
			const wspath = workspaces.locate(wid).cwd;
			if (wspath) await Bun.write(wspath + "/smoke-cart.ts", "export const priceCents = 2990;\n");
			const plan = plans.create(wid, "修复购物车总额浮点 bug", ["定位总额计算逻辑", "改为分单位整数计算", "回归验证", "浏览器验证展示", "沉淀检查项"]);
			console.log(`[jide:smoke-plan] plan created ${plan.id} on ${wid}`);
			const r1 = await plans.stepDone(plan.id, 0);
			console.log(`[jide:smoke-plan] step1 commit=${r1.ok ? (r1.commit?.sha ?? "none(no changes)") : r1.error}`);
			const r2 = await plans.stepDone(plan.id, 1);
			console.log(`[jide:smoke-plan] step2 commit=${r2.ok ? (r2.commit?.sha ?? "none(no changes)") : r2.error}`);
		} catch (e) {
			console.log(`[jide:smoke-plan] err ${e}`);
		}
	}, 4000);
}

if (process.env.JIDE_SMOKE_M4) {
	const m4wid = process.env.JIDE_SMOKE_M4;
	setTimeout(async () => {
		try {
			const m = memoryFor(m4wid)!;
			const sg = m.suggest("project", "conventions.md", ["金额一律以「分」为整数单位计算,展示用 toFixed(2)", "浮点金额断言:期望值写字面量"], "会话沉淀:购物车修复");
			const adopt = m.adopt(sg.id);
			console.log("[jide:smoke-m4] adopt:", JSON.stringify(adopt));
			const inj = m.inject([]);
			console.log("[jide:smoke-m4] budget:", JSON.stringify(inj.budget), "chars:", inj.text.length);
			const entry = await host.createSession({ workspacePath: workspaces.locate(m4wid).cwd ?? "", demoMode: true, memoryContext: m.inject([]).text });
			console.log("[jide:smoke-m4] session with memory created:", entry.sessionId.slice(0, 8));
			console.log("[jide:smoke-m4] ALL DONE");
		} catch (e) {
			console.log("[jide:smoke-m4] ERR", e);
		}
	}, 5000);
}
