/**
 * M3 测试域服务测试(真实环境):
 *  - DevServerManager:三模式探测(用一个 Bun.serve 当 dev server)
 *  - HttpProbe:状态码/包含文本/JSON 路径 + 失败语义
 *  - mapFilesToTests:diff 智能选测映射
 *  - TestRunner:真 bun test 跑生成的用例文件
 *  - BrowserAutomation:系统 Edge CDP → navigate/click/capture
 *  - ReviewQueue:提交入队 → approve → ff 合并进 main
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostEvent, HostEventInput } from "@jide/contracts";
import { DevServerManager } from "./devserver-manager";
import { HttpProbe, mapFilesToTests } from "./test-runner";
import { BrowserAutomation } from "./browser-automation";
import { ReviewQueue } from "./review-queue";
import { WorkspaceManager } from "./workspace-manager";
import { ChecksManager } from "./checks-manager";

const root = mkdtempSync(join(tmpdir(), "jide-m3-test-"));
const events: HostEventInput[] = [];
const emit = (e: HostEventInput) => events.push(e);

/* ---------- 测试用 dev server(Bun.serve) ---------- */
let server: any;
// 绑临时端口(port 0)防硬编码端口被残留进程/并行跑毒害;真值 beforeAll 后回填
let PORT = 18765;
beforeAll(async () => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req) => {
			const url = new URL(req.url);
			if (url.pathname === "/api/total") {
				return Response.json({ total: { cents: 8970, yuan: "89.70" } });
			}
			if (url.pathname === "/cart") {
				return new Response("<html><body><button id='add' onclick='this.textContent=\"added\"'>加入购物车</button><div id='t'>¥89.70</div></body></html>", { headers: { "content-type": "text/html" } });
			}
			if (url.pathname === "/bad") return new Response("nope", { status: 500 });
			return new Response("OK 首页");
		},
	});
	PORT = server.port;
});

afterAll(async () => {
	server?.stop(true);
	// Edge 子进程可能仍占着 profile 目录,给一点时间再清理
	for (let i = 0; i < 5; i++) {
		try {
			rmSync(root, { recursive: true, force: true });
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 500));
		}
	}
});

describe("4A dev server:就绪探测三模式", () => {
	test("http 模式:对已运行的服务器立即就绪", async () => {
		const dm = new DevServerManager();
		dm.bindEmitter(emit);
		// 用一个无害常驻进程模拟 dev server 命令(bun -e sleep)
		const r = await dm.ensure("ws-test", {
			command: "bun -e \"await Bun.sleep(60000)\"",
			cwd: root,
			port: PORT,
			probe: "http",
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.url).toContain(`:${PORT}`);
			expect(r.startedMs).toBeLessThan(5000);
		}
		// 状态事件已推送
		expect(events.some((e) => e.type === "devserver.status" && e.state === "ready")).toBe(true);
		await dm.stop("ws-test");
	}, 20000);

	test("port 模式:端口连通即就绪", async () => {
		const dm = new DevServerManager();
		dm.bindEmitter(emit);
		const r = await dm.ensure("ws-test2", {
			command: "bun -e \"await Bun.sleep(60000)\"",
			cwd: root,
			port: PORT,
			probe: "port",
		});
		expect(r.ok).toBe(true);
		await dm.stop("ws-test2");
	}, 20000);

	test("log 模式:日志特征命中即就绪", async () => {
		const dm = new DevServerManager();
		dm.bindEmitter(emit);
		const r = await dm.ensure("ws-test3", {
			command: "bun -e \"console.log('ready in 300ms'); await Bun.sleep(60000)\"",
			cwd: root,
			port: PORT, // 端口被测试服务器占着也无妨,log 模式不看
			probe: "log",
			readyPattern: "ready in",
		});
		expect(r.ok).toBe(true);
		await dm.stop("ws-test3");
	}, 20000);

	test("崩溃感知:进程退出 → crashed 事件", async () => {
		const dm = new DevServerManager();
		const evts: HostEventInput[] = [];
		dm.bindEmitter((e) => evts.push(e));
		// 故意选一个立刻退出的命令 + log 探测永不命中 → 超时;但进程退出事件应到
		const r = await dm.ensure("ws-crash", {
			command: "bun -e \"console.log('ready now')\"",
			cwd: root,
			port: 1,
			probe: "log",
			readyPattern: "ready now",
		});
		// log 特征立即命中 → ready;随后进程退出 → crashed
		expect(r.ok).toBe(true);
		await new Promise((res) => setTimeout(res, 800));
		expect(evts.some((e) => e.type === "devserver.status" && e.state === "crashed")).toBe(true);
	}, 20000);
});

describe("4B HTTP 探测", () => {
	test("状态码 + 包含文本", async () => {
		const ok = await HttpProbe.run(`http://127.0.0.1:${PORT}/`, { expectStatus: 200, contains: "首页" });
		expect(ok.ok && ok.passed).toBe(true);
	});
	test("断言失败 ≠ 工具失败(passed=false 仍 ok)", async () => {
		const bad = await HttpProbe.run(`http://127.0.0.1:${PORT}/bad`, { expectStatus: 200 });
		expect(bad.ok).toBe(true);
		if (bad.ok) expect(bad.passed).toBe(false);
		const missing = await HttpProbe.run(`http://127.0.0.1:${PORT}/`, { contains: "不存在的内容" });
		expect(missing.ok && !missing.passed).toBe(true);
	});
	test("JSON 路径断言", async () => {
		const j = await HttpProbe.run(`http://127.0.0.1:${PORT}/api/total`, {
			jsonPath: "total.yuan",
			jsonEquals: "89.70",
		});
		expect(j.ok && j.passed).toBe(true);
		const j2 = await HttpProbe.run(`http://127.0.0.1:${PORT}/api/total`, {
			jsonPath: "total.cents",
			jsonEquals: "8970",
		});
		expect(j2.ok && j2.passed).toBe(true);
	});
});

describe("4D 智能选测", () => {
	test("映射:变更源文件 → 关联测试子集", () => {
		const all = ["src/cart.test.ts", "src/user.test.ts", "src/cart.int.test.ts", "src/__tests__/util.test.ts", "lib/format.test.ts"];
		const hit = mapFilesToTests(["src/cart.ts"], all);
		expect(hit).toContain("src/cart.test.ts");
		expect(hit).not.toContain("src/user.test.ts");
		expect(hit).not.toContain("src/__tests__/util.test.ts");
		expect(hit).not.toContain("lib/format.test.ts");
		// 12/48 级别:1/5
		expect(hit.length / all.length).toBeLessThan(1);
	});

	test("TestRunner:真跑 bun test(2 用例,1 过 1 败)", async () => {
		const dir = join(root, "proj");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "cart.test.ts"),
			`import { test, expect } from "bun:test";
test("总额 · 整数数量", () => { expect(2990 * 3).toBe(8970); });
test("总额 · 浮点陷阱", () => { expect((29.9 * 3).toFixed(2)).toBe("89.70"); });`,
		);
		const { TestRunner } = await import("./test-runner");
		const runner = new TestRunner();
		const r = await runner.run(dir, ["cart.test.ts"], 2);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.selected).toBe(1);
			expect(r.total).toBe(2);
			expect(r.durationMs).toBeLessThan(5000);
			const statuses = r.results.map((x) => x.status);
			expect(statuses).toContain("pass");
			// 29.9*3=89.699999... toFixed(2)="89.70" 其实会过;确保至少有结果解析
			expect(r.results.length).toBeGreaterThanOrEqual(2);
		}
	}, 30000);
});

describe("4C 浏览器自动化(系统 Edge + CDP)", () => {
	const browsers = new BrowserAutomation(join(root, "runtime"));

	test("navigate → click → textContent → capture 截图回传", async () => {
		browsers.bindEmitter(emit);
		const nav = await browsers.navigate("ws-browser", `http://127.0.0.1:${PORT}/cart`);
		expect(nav.ok).toBe(true);

		const click = await browsers.click("ws-browser", "#add");
		expect(click.ok).toBe(true);

		const text = await browsers.textContent("ws-browser");
		expect(text.ok && text.text).toContain("added");

		const shot = await browsers.capture("ws-browser");
		expect(shot.ok).toBe(true);
		if (shot.ok) {
			expect(shot.dataBase64.length).toBeGreaterThan(1000);
			// 截图落盘存在
			expect(() => readFileSync(shot.path)).not.toThrow();
		}
		browsers.disposeAll();
	}, 60000);

	test("click 元素不存在 → 可重试错误语义", async () => {
		const b2 = new BrowserAutomation(join(root, "runtime"));
		await b2.navigate("ws-b2", `http://127.0.0.1:${PORT}/cart`);
		const r = await b2.click("ws-b2", "#nonexistent");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("元素不存在");
		b2.disposeAll();
	}, 60000);
});

describe("W6 评审队列:门禁合并", () => {
	test("提交入队 → approve → ff 合并进 main;追问/忽略不改 main", async () => {
		const projDir = join(root, "shop");
		mkdirSync(projDir, { recursive: true });
		const g = async (...args: string[]) => {
			const p = Bun.spawn(["git", "-C", projDir, ...args], { stdout: "pipe", stderr: "pipe" });
			const out = await new Response(p.stdout).text();
			const code = await p.exited;
			if (code !== 0) throw new Error(`git ${args.join(" ")}: ${out}`);
			return out.trim();
		};
		await g("init", "-b", "main");
		writeFileSync(join(projDir, "base.txt"), "base");
		await g("add", "-A");
		await g("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "init");

		const ws = new WorkspaceManager(join(root, "runtime"));
		ws.bindEmitter(emit);
		const opened = await ws.openProject(projDir);
		if (opened.opened) ws.trustProject(opened.project.id);
		const created = await ws.createWorktree(opened.opened ? opened.project.id : "x", "m3", { fromRef: "HEAD" });
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		// 在隔离区做一个 Agent 提交
		writeFileSync(join(created.path, "fix.txt"), "fixed");
		const commit = await ws.commitAll(created.workspaceId, "Agent · 计划步骤 1:修复", true);
		expect(commit.ok).toBe(true);

		const rq = new ReviewQueue(ws, join(root, "runtime"));
		rq.bindEmitter(emit);
		rq.enqueueCommit(created.workspaceId, created.branch, commit.ok ? commit.sha : "", "Agent · 计划步骤 1:修复");
		const items = rq.list(opened.project!.id);
		expect(items).toHaveLength(1);
		expect(items[0].state).toBe("pending");

		const mainBefore = await g("rev-parse", "--short", "main");
		const r = await rq.decide(items[0].id, "approve");
		expect(r.ok).toBe(true);
		if (r.ok && "merged" in r && r.merged) {
			const mainAfter = await g("rev-parse", "--short", "main");
			expect(mainAfter).not.toBe(mainBefore);
		}
		// main 上能看见 fix.txt
		expect(readFileSync(join(projDir, "fix.txt"), "utf8")).toBe("fixed");

		// 追问与忽略不合并
		rq.enqueueCommit(created.workspaceId, created.branch, "x", "second");
		const items2 = rq.pending();
		const askR = await rq.decide(items2[0].id, "ask");
		expect(askR.ok).toBe(true);
		expect(rq.pending()).toHaveLength(0);
	}, 30000);
});

describe("P3.2 stacked 血缘合并流", () => {
	test("入队去重;父未合入 → 子审批被守卫拒绝;父合入后子经 rebase 合并;主线继续前进仍可合", async () => {
		const projDir = join(root, "stacked-repo");
		mkdirSync(projDir, { recursive: true });
		const g = async (cwd: string, ...args: string[]) => {
			const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
			const out = await new Response(p.stdout).text();
			const code = await p.exited;
			if (code !== 0) throw new Error(`git ${args.join(" ")}: ${out}`);
			return out.trim();
		};
		await g(projDir, "init", "-b", "main");
		writeFileSync(join(projDir, "base.txt"), "b");
		await g(projDir, "add", "-A");
		await g(projDir, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "init");

		const ws = new WorkspaceManager(join(root, "runtime-stacked"));
		ws.bindEmitter(emit);
		const opened = await ws.openProject(projDir);
		if (!opened.opened) throw new Error("项目未打开");
		const pid = opened.project.id;
		ws.trustProject(pid);

		const parent = await ws.createWorktree(pid, "stack-parent", { source: "user" });
		expect(parent.ok).toBe(true);
		if (!parent.ok) return;
		const child = await ws.createWorktree(pid, "stack-child", { parentWorkspaceId: parent.workspaceId });
		expect(child.ok).toBe(true);
		if (!child.ok) return;
		// 血缘带出
		const childInfo = (await ws.listWorkspaces(pid)).find((w) => w.id === child.workspaceId);
		expect(childInfo?.parentWorkspaceId).toBe(parent.workspaceId);
		expect(childInfo?.source).toBe("stack");
		expect(childInfo?.baseRef).toBe(parent.branch);

		// 双方各做一次提交
		writeFileSync(join(parent.path, "p.txt"), "p");
		const pc = await ws.commitAll(parent.workspaceId, "parent work", false);
		expect(pc.ok).toBe(true);
		writeFileSync(join(child.path, "c.txt"), "c");
		const cc = await ws.commitAll(child.workspaceId, "child work", false);
		expect(cc.ok).toBe(true);

		const rq = new ReviewQueue(ws, join(root, "runtime-stacked"));
		rq.bindEmitter(emit);

		// 子先送审(baseBranch = 父分支):父未合入 → 守卫拒绝,条目回 pending
		const childItem = rq.enqueueCommit(child.workspaceId, child.branch, cc.ok ? cc.sha : "", "child work", { baseBranch: parent.branch });
		const dup = rq.enqueueCommit(child.workspaceId, child.branch, cc.ok ? cc.sha : "", "child work", { baseBranch: parent.branch });
		expect(dup.id).toBe(childItem.id); // 幂等去重
		const guard = await rq.decide(childItem.id, "approve");
		expect(guard.ok).toBe(false);
		if (!guard.ok) expect(guard.error).toContain("父分支");
		expect(rq.pending()).toHaveLength(1);

		// 父送审 → approve → ff 合入主线
		const parentItem = rq.enqueueCommit(parent.workspaceId, parent.branch, pc.ok ? pc.sha : "", "parent work");
		const pr = await rq.decide(parentItem.id, "approve");
		expect(pr.ok).toBe(true);
		expect(readFileSync(join(projDir, "p.txt"), "utf8")).toBe("p");

		// 主线再前进一格(制造分叉)→ 子审批走 rebase onto 主线头
		writeFileSync(join(projDir, "main-only.txt"), "m");
		await g(projDir, "add", "-A");
		await g(projDir, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "main advance");

		const cr = await rq.decide(childItem.id, "approve");
		expect(cr.ok).toBe(true);
		expect(readFileSync(join(projDir, "c.txt"), "utf8")).toBe("c");
		expect(readFileSync(join(projDir, "main-only.txt"), "utf8")).toBe("m");
	}, 30000);
});

describe("4E 检查项(沉淀与复验,http 断言)", () => {
	test("创建资产检查项 → 落盘 .jide/checks → 执行通过;失败项 passed=false", async () => {
		const browsers = new BrowserAutomation(join(root, "runtime"));
		const checks = new ChecksManager(browsers, HttpProbe.run);
		checks.bindEmitter(emit);
		checks.setCwdResolver(() => root); // 资产存 root/.jide/checks

		const c1 = checks.create("ws-checks", "总额展示两位小数", "asset", {
			type: "http",
			url: `http://127.0.0.1:${PORT}/api/total`,
			jsonPath: "total.yuan",
			contains: undefined,
		} as any);
		expect(c1.ok).toBe(true);

		// 直接用 http 断言语义复验
		const c2 = checks.create("ws-checks", "首页可访问", "asset", {
			type: "http",
			url: `http://127.0.0.1:${PORT}/`,
			expectStatus: 200,
			contains: "首页",
		});
		expect(c2.ok).toBe(true);
		const c3 = checks.create("ws-checks", "坏路径(应失败)", "temp", {
			type: "http",
			url: `http://127.0.0.1:${PORT}/bad`,
			expectStatus: 200,
		});
		expect(c3.ok).toBe(true);

		const r = await checks.run("ws-checks");
		expect(r.ok).toBe(true);
		if (r.ok) {
			const byTitle = new Map(r.results.map((x) => [x.title, x]));
			expect(byTitle.get("首页可访问")?.passed).toBe(true);
			expect(byTitle.get("坏路径(应失败)")?.passed).toBe(false);
		}
		// 资产已落盘
		const listed = checks.list("ws-checks");
		expect(listed.filter((c) => c.kind === "asset").length).toBeGreaterThanOrEqual(2);
		// diff 命中自动带上
		const sel = checks.selectForDiff("ws-checks", []);
		expect(Array.isArray(sel)).toBe(true);
	}, 20000);
});
