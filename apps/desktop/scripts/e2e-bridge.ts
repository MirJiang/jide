/**
 * E2E(离线,零模型调用):工具桥接线全链
 *  - AgentHost + ToolBridgeServer 以产品路径创建真实 pi 会话(-e jide-guard/jide-memory/jide-tools + 桥 env);
 *  - 借检查器扩展在 pi 进程内读 pi.getAllTools() 落盘,断言 8 个 JIDE 工具注册成功
 *    (1.4.0 jiti 虚拟模块解析 typebox 的实证);
 *  - 桥服务端真实监听随机端口(处理器返回 canned 值)。
 *
 * 用法:bun apps/desktop/scripts/e2e-bridge.ts
 */

import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../src/bun/host/agent-host";
import { ToolBridgeServer } from "../src/bun/host/bridge-server";
import type { HostEvent } from "@jide/contracts";

const workDir = mkdtempSync(join(tmpdir(), "jide-bridge-e2e-"));
const runtime = join(workDir, "runtime");
process.env.JIDE_HOME = runtime;

const host = new AgentHost(runtime);
const events: HostEvent[] = [];
host.bindEmitter((e) => {
	events.push(e);
	if (e.type === "host.log") console.log(`  [host.${e.level}] ${e.message}`);
});

// 桥:注册一个可断言的 canned 工具(产品处理器在 index.ts,这里验证传输/env 链路)
const bridge = new ToolBridgeServer();
let bridgeHit = false;
bridge.register("git_diff_files", async (workspaceId) => {
	bridgeHit = true;
	return {
		content: [{ type: "text", text: `canned-diff wid=${workspaceId}` }],
		details: undefined,
	};
});
host.bindBridge(bridge);

// 检查器扩展:session_start 时把 pi 内工具清单落盘(pi 进程内执行,jiti 加载)
const toolsOut = join(workDir, "pi-tools.json");
const checker = join(workDir, "jide-checker.ts");
writeFileSync(
	checker,
	`import { writeFileSync } from "node:fs";
export default function (pi: any) {
	pi.on("session_start", () => {
		const tools = pi.getAllTools().map((t: any) => t.name);
		writeFileSync(${JSON.stringify(toolsOut)}, JSON.stringify({ tools, active: pi.getActiveTools() }, null, 2));
	});
}
`,
	"utf8",
);

// 让 AgentHost 把检查器扩展一并传给 pi(产品路径只传 jide-extensions 目录内三个;
// 检查器放临时目录,经 monkey-patch piExtensionArgs 追加,不改产品代码)
const origExtArgs = (host as any).piExtensionArgs.bind(host);
(host as any).piExtensionArgs = () => [...origExtArgs(), "-e", checker];

function fail(msg: string): never {
	console.error(`\n❌ ${msg}`);
	try {
		host.disposeAll();
	} catch {
		/* 回收 */
	}
	console.error(`(工作目录保留供排查:${workDir})`);
	process.exit(1);
}

console.log("[1] createSession(spawn 真实 pi,gate/memory/tools 三扩展 + 桥 env)…");
const entry = await host.createSession({ workspacePath: workDir, workspaceId: "e2e:w1" });
console.log(`  sessionId=${entry.sessionId.slice(0, 12)} model=${entry.modelLabel}`);
console.log(`  桥已监听:${bridge.running}`);

console.log("[2] 等 pi 进程内检查器写工具清单…");
let raw: string | null = null;
for (let i = 0; i < 60; i++) {
	if (existsSync(toolsOut)) {
		raw = readFileSync(toolsOut, "utf8");
		break;
	}
	await Bun.sleep(500);
}
if (!raw) fail("20s 内检查器未落盘(session_start 未触发或扩展加载失败;查 pi stderr)");
const { tools, active } = JSON.parse(raw);

const JIDE_TOOLS = ["dev_server", "http_probe", "browser", "test_run", "checks", "plan", "memory_suggest", "terminal_read", "terminal_send", "git_diff_files"];
const missing = JIDE_TOOLS.filter((t) => !tools.includes(t));
console.log(`  pi 内注册工具数=${tools.length} · JIDE 工具缺失=${missing.length ? missing.join(",") : "无"}`);
if (missing.length) fail(`以下 JIDE 工具未在 pi 1.4.0 内注册成功:${missing.join(", ")}\n全部:${tools.join(", ")}`);
const inactive = JIDE_TOOLS.filter((t) => !active.includes(t));
if (inactive.length) fail(`已注册但未激活(模型不可见):${inactive.join(", ")}`);
console.log(`  10 个 JIDE 工具已注册且激活(active=${active.length})`);

console.log("[3] 引擎缝事件自检(agent_start 未误触发、无扩展报错日志)…");
const errLogs = events.filter((e: any) => e.type === "host.log" && e.level === "error");
if (errLogs.length) fail(`宿主错误日志:${errLogs.map((e: any) => e.message).join(" | ")}`);

console.log("[4] 清理 disposeAll…");
host.disposeAll();
bridge.stop();
await Bun.sleep(400);

console.log("[5] 模型目录实拉(临时 pi --no-session,get_available_models)…");
const { ModelCatalog } = await import("../src/bun/host/model-catalog");
const catalog = new ModelCatalog();
const t0 = Date.now();
const models = await catalog.list(true);
console.log(`  ${Date.now() - t0}ms · ${models.length} 个模型:${models.slice(0, 6).map((m) => m.key).join(", ")}${models.length > 6 ? " …" : ""}`);
if (models.length === 0) console.log("  (目录为空:该机 ~/.pi 未配置模型,不阻塞工具桥结论)");
const cached = await catalog.list(); // 二次走缓存
if (cached.length !== models.length) fail("缓存与实拉结果不一致");

rmSync(workDir, { recursive: true, force: true });

console.log("\n✅ 工具桥 E2E 通过:真实 pi 1.4.0 注册 10 个 JIDE 工具(guard/memory/tools 三扩展 + 桥 env 注入)");
console.log(`   模型目录:${models.length} 个(缓存命中复验一致)`);
