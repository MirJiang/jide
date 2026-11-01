/**
 * JIDE 工具桥扩展(pi 进程内,经 `pi --mode rpc -e <本文件>` 加载)
 *
 * 把 JIDE 测试域/计划域/记忆域能力注册为 pi 自定义工具(business-design §4 工具协议表),
 * execute 经宿主 ToolBridgeServer(127.0.0.1 + Bearer token,env 注入)回环调用宿主服务:
 *
 *   dev_server.ensure → test.run(diff) → browser(navigate/click/capture) → checks.verify
 *   plan.step_done(自动提交)→ memory_suggest(建议卡片)→ terminal_read/send(终端协作)
 *
 * 失败语义(协议表,宿主侧保证):
 *   - http_probe 断言失败 ≠ 工具失败(passed:false 正常返回)
 *   - test_run 用例失败 ≠ 工具失败
 *   - 桥不可达/宿主异常 → isError 结果(agent 可读错误文本)
 *
 * 本文件不 import 任何 JIDE 模块 —— 由 pi 的 jiti 直接加载;
 * `typebox` 经 pi 的 jiti 虚拟模块表解析到 pi 自带副本(1.4.0 实证)。
 */

import { Type } from "typebox";

const BRIDGE_URL = process.env.JIDE_BRIDGE_URL ?? "";
const BRIDGE_TOKEN = process.env.JIDE_BRIDGE_TOKEN ?? "";
const WORKSPACE_ID = process.env.JIDE_WORKSPACE_ID ?? "";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
	isError?: boolean;
};

/** 回环调用宿主工具;返回宿主格式化好的结果 */
async function bridge(name: string, params: Record<string, unknown>): Promise<ToolResult> {
	if (!BRIDGE_URL || !BRIDGE_TOKEN) {
		throw new Error("JIDE 工具桥未接入(会话创建时未注入桥环境变量),该工具不可用");
	}
	let res: Response;
	try {
		res = await fetch(`${BRIDGE_URL}/tool/${name}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${BRIDGE_TOKEN}`,
			},
			body: JSON.stringify({ workspaceId: WORKSPACE_ID, params }),
			signal: AbortSignal.timeout(120_000),
		});
	} catch (err: any) {
		throw new Error(`JIDE 工具桥不可达(${String(err?.message ?? err)})`);
	}
	if (!res.ok) {
		let detail = "";
		try {
			detail = (await res.json())?.error ?? "";
		} catch {
			/* 非 JSON 响应 */
		}
		throw new Error(`JIDE 工具桥调用失败(HTTP ${res.status})${detail ? `:${detail}` : ""}`);
	}
	return (await res.json()) as ToolResult;
}

/** 统一包装:桥结果直接返回;桥异常 → isError 结果(agent 可读) */
function jideTool(def: {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: any;
}) {
	return {
		...def,
		async execute(_toolCallId: string, params: Record<string, unknown>) {
			try {
				return await bridge(def.name, params);
			} catch (err: any) {
				return {
					content: [{ type: "text", text: String(err?.message ?? err) }],
					details: undefined,
					isError: true,
				} satisfies ToolResult;
			}
		},
	};
}

export default function (pi: any) {
	const tools = [
		jideTool({
			name: "dev_server",
			label: "dev server 管理",
			description:
				"管理当前工作区的 dev server(启动并等待就绪/停止/查状态)。agent 与内嵌预览共享同一实例。ensure 返回 {url, port, probeMode, startedMs};启动超时返回错误与日志尾。",
			promptSnippet: "dev_server({action:'ensure'}) → {url}:启动并等待 dev server 就绪(三模式探测)。",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("ensure"), Type.Literal("stop"), Type.Literal("status")]),
				port: Type.Optional(Type.Number({ description: "dev server 端口(默认 5175)" })),
				command: Type.Optional(Type.String({ description: "启动命令(默认 bunx vite --port N)" })),
				probe: Type.Optional(
					Type.Union([Type.Literal("auto"), Type.Literal("http"), Type.Literal("port"), Type.Literal("log")]),
				),
			}),
		}),

		jideTool({
			name: "http_probe",
			label: "HTTP 探测",
			description:
				"对 url 发请求并按期望断言(状态码/包含文本/JSON 路径)。断言失败不是工具失败:返回 passed:false 与实际值,供你判断后重试或修复。",
			promptSnippet: "http_probe({url, jsonPath, jsonEquals}) → {passed, actual}:接口级自测断言。",
			parameters: Type.Object({
				url: Type.String(),
				expectStatus: Type.Optional(Type.Number()),
				contains: Type.Optional(Type.String({ description: "响应须包含的文本" })),
				jsonPath: Type.Optional(Type.String({ description: "如 total.yuan" })),
				jsonEquals: Type.Optional(Type.String()),
			}),
		}),

		jideTool({
			name: "browser",
			label: "浏览器自动化",
			description:
				"浏览器实操验证:navigate(url) 打开页面;click(selector) 点击;fill(selector,value) 填写;capture 截图(落盘为证据)。元素不存在是可重试错误。",
			promptSnippet: "browser({action:'navigate',url}) / click / fill / capture:浏览器级验证与截图证据。",
			parameters: Type.Object({
				action: Type.Union([
					Type.Literal("navigate"),
					Type.Literal("click"),
					Type.Literal("fill"),
					Type.Literal("capture"),
					Type.Literal("hover"),
					Type.Literal("scroll"),
					Type.Literal("snapshot"),
					Type.Literal("console"),
					Type.Literal("record"),
				]),
				x: Type.Optional(Type.Number()),
				y: Type.Optional(Type.Number()),
				ms: Type.Optional(Type.Number()),
				url: Type.Optional(Type.String()),
				selector: Type.Optional(Type.String({ description: "CSS 选择器" })),
				value: Type.Optional(Type.String()),
			}),
		}),

		jideTool({
			name: "test_run",
			label: "智能选测",
			description:
				"运行测试。scope=diff 按 git 变更文件映射关联用例子集(如 12/48);all 全量回归(子集失败时再全量)。返回逐用例结果;用例失败不是工具失败。",
			promptSnippet: "test_run({scope:'diff'}) → 选中 N/M 用例逐条结果;先选测,失败再 all。",
			promptGuidelines: ["改完代码先用 test_run({scope:'diff'}) 自测,子集失败再 scope:'all'"],
			parameters: Type.Object({
				scope: Type.Union([Type.Literal("diff"), Type.Literal("all")], { default: "diff" }),
			}),
		}),

		jideTool({
			name: "checks",
			label: "检查项",
			description:
				"检查项 = 沉淀为项目资产的验收断言(.jide/checks/)。verify 运行(全部或指定 ids),逐项通过/失败附证据;create 新建(asset=跨会话复用、diff 命中自动带上)。",
			promptSnippet: "checks({action:'verify'}) → 逐项 pass/fail;完成后把断言 create 成 asset。",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("verify"), Type.Literal("create")]),
				title: Type.Optional(Type.String()),
				kind: Type.Optional(Type.Union([Type.Literal("asset"), Type.Literal("temp")])),
				assertion: Type.Optional(
					Type.Object({
						type: Type.String(),
						url: Type.Optional(Type.String()),
						contains: Type.Optional(Type.String()),
					}),
				),
				ids: Type.Optional(Type.Array(Type.String())),
			}),
		}),

		jideTool({
			name: "plan",
			label: "计划",
			description:
				"计划 = 当前任务步骤清单(用户在右侧面板可见)。create(goal, steps[]) 建立;step_done(stepIndex) 标记完成——隔离工作区会自动提交(Agent · 计划步骤 N)并进入评审队列。",
			promptSnippet: "plan({action:'create',goal,steps}) 建立 todo;step_done 逐步推进(自动提交)。",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("create"), Type.Literal("step_done")]),
				goal: Type.Optional(Type.String()),
				steps: Type.Optional(Type.Array(Type.String())),
				stepIndex: Type.Optional(Type.Number()),
			}),
		}),

		jideTool({
			name: "memory_suggest",
			label: "记忆建议",
			description:
				"提议写入项目记忆(.memory/,用户可见)。不会静默写入:以建议卡片呈现给用户,采纳/忽略/改后采纳由用户决定。",
			promptSnippet: "memory_suggest({scope,file,lines,reason}) → 建议卡片(用户三动作)。",
			parameters: Type.Object({
				scope: Type.Union([Type.Literal("project"), Type.Literal("user")]),
				file: Type.String({ description: "如 conventions.md / feedback.md" }),
				lines: Type.Array(Type.String(), { description: "一行一事" }),
				reason: Type.String({ description: "来源说明,如 会话沉淀:购物车修复" }),
			}),
		}),

		jideTool({
			name: "terminal_read",
			label: "终端读屏",
			description:
				"读取用户底部终端面板的最近输出(剥除 ANSI;不指定 terminalId 则读该工作区最新终端)。用于复现用户看到的报错、确认命令结果。终端不存在时报错,可请用户打开。",
			promptSnippet: "terminal_read({lines}) → 用户终端最近输出:诊断用户侧问题的第一手材料。",
			parameters: Type.Object({
				terminalId: Type.Optional(Type.String({ description: "缺省 = 工作区最新终端" })),
				lines: Type.Optional(Type.Number({ description: "读取行数(默认 40,上限 500)" })),
			}),
		}),

		jideTool({
			name: "terminal_send",
			label: "终端输入",
			description:
				"向用户底部终端发送文本(默认追加回车执行)。用户能在终端里实时看到你的输入;发送后用 terminal_read 查看结果。仅已信任工作区可用。",
			promptSnippet: "terminal_send({text}) → 在用户终端执行并可用 terminal_read 看结果。",
			parameters: Type.Object({
				text: Type.String({ description: "发送的文本(一行命令)" }),
				terminalId: Type.Optional(Type.String()),
				enter: Type.Optional(Type.Boolean({ description: "默认 true=追加回车执行" })),
			}),
		}),

		jideTool({
			name: "git_diff_files",
			label: "变更文件",
			description: "列出当前工作区相对 HEAD 的变更文件(供选测与计划参考)。",
			promptSnippet: "git_diff_files() → 变更文件列表(M/A/D/?)。",
			parameters: Type.Object({}),
		}),
	];

	for (const t of tools) pi.registerTool(t);
}
