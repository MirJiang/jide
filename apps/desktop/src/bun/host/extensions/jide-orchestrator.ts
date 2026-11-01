/**
 * JIDE 编排扩展(pi 进程内,经 `pi --mode rpc -e <本文件>` 加载;仅编排会话注入)
 *
 * 当前对话即 Router:注册 5 个委派工具,经宿主 ToolBridgeServer 回环到
 * OrchestratorManager(Worker 池)。发起时经 ctx 取本会话 id 作 Router 标识,
 * Worker 完成后宿主 steer/prompt 回喂本会话。
 *
 * 本文件不 import 任何 JIDE 模块;typebox 经 pi jiti 虚拟模块解析。
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

async function bridge(name: string, params: Record<string, unknown>): Promise<ToolResult> {
	if (!BRIDGE_URL || !BRIDGE_TOKEN) {
		throw new Error("JIDE 编排桥未接入(会话创建时未注入桥环境变量),工具不可用");
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
			signal: AbortSignal.timeout(600_000), // wait_workers 上限 10min
		});
	} catch (err: any) {
		throw new Error(`JIDE 编排桥不可达(${String(err?.message ?? err)})`);
	}
	if (!res.ok) {
		let detail = "";
		try {
			detail = (await res.json())?.error ?? "";
		} catch {
			/* 非 JSON */
		}
		throw new Error(`JIDE 编排桥调用失败(HTTP ${res.status})${detail ? `:${detail}` : ""}`);
	}
	return (await res.json()) as ToolResult;
}

function orchTool(def: {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: any;
}) {
	return {
		...def,
		async execute(_toolCallId: string, params: Record<string, unknown>, _signal: unknown, _onUpdate: unknown, ctx: any) {
			try {
				// Router 标识:本会话 id(Worker 完成后宿主回喂目标)
				const router = ctx?.sessionManager?.getSessionId?.() ?? "";
				return await bridge(def.name, { ...params, __router: router });
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
	// 未注入编排环境(非编排会话)→ 不注册,零存在感
	if (process.env.JIDE_ORCH !== "1") return;

	const tools = [
		orchTool({
			name: "spawn_worker",
			label: "委派 Worker",
			description:
				"把一个自包含的子任务委派给 Worker(独立会话+独立工具,在目标工作区执行)。目标须写清:做什么/验收标准/不要越界做什么。立即返回 workerId;用 wait_workers 收结果。适合可并行的独立子任务(如分别排查两个模块),不适合强顺序依赖的步骤。",
			promptSnippet: "spawn_worker({objective}) → workerId:并行委派子任务。",
			promptGuidelines: [
				"委派前把目标写成自包含任务书;并行委派后用 wait_workers 汇总",
				"speculative=true:后台静默修复,验证全绿才自动提交进评审队列,红则丢弃 —— 低风险修复用它",
			],
			parameters: Type.Object({
				objective: Type.String({ description: "自包含任务书(做什么/验收标准/边界)" }),
				workspaceId: Type.Optional(Type.String({ description: "缺省 = 当前工作区" })),
				modelKey: Type.Optional(Type.String({ description: 'Worker 模型 key("<provider>/<modelId>");缺省 = pi 默认' })),
				timeoutMin: Type.Optional(Type.Number({ description: "单 Worker 超时分钟(默认 30)" })),
				speculative: Type.Optional(
					Type.Boolean({ description: "投机执行:于隔离 worktree 静默修复,测试+检查项全绿才自动提交进评审队列,否则丢弃" }),
				),
			}),
		}),
		orchTool({
			name: "wait_workers",
			label: "等待 Worker",
			description: "等待指定 Worker(缺省全部)收束并返回逐个状态与结果摘要;最长 10 分钟。",
			promptSnippet: "wait_workers({workerIds}) → 逐个状态+摘要。",
			parameters: Type.Object({
				workerIds: Type.Optional(Type.Array(Type.String())),
				timeoutSec: Type.Optional(Type.Number({ description: "默认 300,上限 600" })),
			}),
		}),
		orchTool({
			name: "worker_status",
			label: "Worker 状态",
			description: "查看 Worker 状态(指定 id 或全部):running/done/failed 与摘要。",
			promptSnippet: "worker_status({workerId}) → 状态与摘要。",
			parameters: Type.Object({
				workerId: Type.Optional(Type.String()),
			}),
		}),
		orchTool({
			name: "send_to_worker",
			label: "追加指令",
			description: "给已收束的 Worker 追加一轮指令(复用其会话上下文);忙碌中的 Worker 会拒绝。",
			promptSnippet: "send_to_worker({workerId,text}) → 追加一轮。",
			parameters: Type.Object({
				workerId: Type.String(),
				text: Type.String(),
			}),
		}),
		orchTool({
			name: "stop_worker",
			label: "停止 Worker",
			description: "中断一个 Worker(超时/方向错误时用)。",
			promptSnippet: "stop_worker({workerId}) → 中断。",
			parameters: Type.Object({
				workerId: Type.String(),
			}),
		}),
		orchTool({
			name: "start_race",
			label: "开赛(一拖 N)",
			description:
				"竞赛:同一任务书在 N 个隔离 worktree 各派一个 Worker 并行执行,收束后自动评分(测试+检查项)。适合'多方案不知哪个好'的任务(如两种修复思路)。完成后用户在竞赛面板人工选优合入;你在对话里会收到结果。",
			promptSnippet: "start_race({objective, variants}) → raceId:多方案并行竞赛,用户人工选优。",
			promptGuidelines: ["竞赛任务书必须自含验收标准;variants 可为不同思路指定不同模型"],
			parameters: Type.Object({
				objective: Type.String({ description: "自包含任务书(做什么/验收标准/边界)" }),
				variants: Type.Optional(
					Type.Array(Type.Object({ modelKey: Type.Optional(Type.String()) }), {
						description: "每路模型配置;缺省 3 路全默认模型(最多 4 路)",
					}),
				),
				timeoutMin: Type.Optional(Type.Number({ description: "单 Worker 超时分钟(默认 30)" })),
			}),
		}),
	];

	for (const t of tools) pi.registerTool(t);
}
