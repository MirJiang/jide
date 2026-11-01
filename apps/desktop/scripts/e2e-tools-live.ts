/**
 * E2E(live,消耗真实模型调用):工具桥执行半链
 * 模型 → pi 内 jide-tools 扩展 → HTTP 桥 → 宿主处理器(git_diff_files)→ 结果回喂模型。
 * 前置:~/.pi 已配置可用模型(DeepSeek)。
 * 用法:bun apps/desktop/scripts/e2e-tools-live.ts
 */

import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../src/bun/host/agent-host";
import { ToolBridgeServer } from "../src/bun/host/bridge-server";
import { WorkspaceManager } from "../src/bun/host/workspace-manager";
import type { HostEvent } from "@jide/contracts";

const workDir = mkdtempSync(join(tmpdir(), "jide-tools-live-"));
// runtime 放仓库外(git status 才干净);git worktree list 在 Windows 返回正斜杠,统一比对键
const runtime = join(mkdtempSync(join(tmpdir(), "jide-tools-live-rt-")), "runtime");
process.env.JIDE_HOME = runtime;
const root = workDir.replace(/\\/g, "/");

// 造一个真实 git 仓库:一次提交 + 一处未提交修改(git_diff_files 应报 M a.txt)
execSync(`git init -q && git config user.email t@t && git config user.name t`, { cwd: workDir });
writeFileSync(join(workDir, "a.txt"), "v1\n");
execSync(`git add -A && git commit -qm init`, { cwd: workDir });
appendFileSync(join(workDir, "a.txt"), "v2\n");

const host = new AgentHost(runtime);
const workspaces = new WorkspaceManager(runtime);
const events: HostEvent[] = [];
let settled: (() => void) | null = null;
host.bindEmitter((e) => {
	events.push(e);
	if (e.type === "host.log") console.log(`  [host.${e.level}] ${e.message}`);
	if (e.type === "agent.tool") console.log(`  [tool ${e.phase}] ${e.toolName}${(e as any).isError ? " (error)" : ""}`);
	if (e.type === "agent.settled") settled?.();
});
const waitForSettled = (ms: number) =>
	new Promise<boolean>((resolve) => {
		const t = setTimeout(() => resolve(false), ms);
		settled = () => {
			clearTimeout(t);
			resolve(true);
		};
	});

// 桥:git_diff_files 走真实 WorkspaceManager.gitStatus(与其余 7 个工具同一传输路径)
const bridge = new ToolBridgeServer();
bridge.register("git_diff_files", async (workspaceId) => {
	const st = await workspaces.gitStatus(workspaceId);
	if (!st.ok) return { content: [{ type: "text", text: st.error }], details: undefined, isError: true };
	const paths = st.changes.map((c) => c.path);
	return { content: [{ type: "text", text: paths.length ? paths.join("\n") : "(无变更)" }], details: undefined };
});
host.bindBridge(bridge);

function fail(msg: string): never {
	console.error(`\n❌ ${msg}`);
	try {
		host.disposeAll();
	} catch {
		/* 回收 */
	}
	console.error(`(目录保留:${workDir})`);
	process.exit(1);
}

console.log("[1] 开项目 + 反查 workspaceId…");
const opened = await workspaces.openProject(root);
if (!opened.opened) fail(`openProject:${opened.reason}`);
const found = await workspaces.findByPath(root);
if (!found) fail("findByPath 未命中");
console.log(`  workspaceId=${found.workspaceId}`);

console.log("[2] 创建会话(桥 env + jide-tools 注入)…");
const entry = await host.createSession({ workspacePath: root, workspaceId: found.workspaceId });
console.log(`  model=${entry.modelLabel}`);

console.log("[3] prompt:诱导模型调用 git_diff_files(1-2 次真实调用)…");
await host.prompt(
	entry.sessionId,
	"请调用 git_diff_files 工具查看当前工作区的变更文件,然后只回复工具返回的原始内容,不要多余文字。",
);
const ok = await waitForSettled(180_000);
if (!ok) fail("180s 未 settled");
const finals = events.filter((e: any) => e.type === "agent.message" && e.role === "assistant");
const toolCalls = events.filter((e: any) => e.type === "agent.tool" && e.toolName === "git_diff_files");
const toolErr = events.filter((e: any) => e.type === "agent.tool" && (e as any).isError);
const text = finals.map((e: any) => e.text).join("");
console.log(`  模型回复:${JSON.stringify(text.slice(0, 120))}`);

console.log("[4] 断言…");
if (!toolCalls.some((e: any) => e.phase === "start")) fail("模型没有调用 git_diff_files(见上方事件流)");
if (toolErr.length) fail("工具调用以错误收场");
if (!text.includes("a.txt")) fail(`模型回复未包含工具结果 a.txt:${text.slice(0, 200)}`);

console.log("[5] 清理…");
bridge.stop(); // 不停服 Bun.serve 句柄会吊住进程不退出
host.disposeAll();
await Bun.sleep(400);

console.log("\n✅ 工具桥执行半链通过:模型 → pi 扩展 → HTTP 桥(token)→ 宿主 gitStatus → 结果回喂模型");
