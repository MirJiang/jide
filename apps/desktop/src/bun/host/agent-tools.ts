/**
 * agent-tools — 把测试域/计划域/记忆域能力注册为 pi 自定义工具(business-design §4 工具协议表)
 *
 * 这是"自测闭环"的 agent 侧入口:agent 改完代码后可自主
 *   dev_server.ensure → test.run(diff) → browser(navigate/click/capture) → checks.verify
 *   plan.step_done(自动提交)→ memory.suggest(建议卡片)
 *
 * 失败语义(协议表):
 *   - http.probe 断言失败 ≠ 工具失败(passed:false 正常返回)
 *   - test.run 用例失败 ≠ 工具失败
 *   - browser 元素不存在 → 可重试错误(agent 可等待后重试)
 *   - dev_server.ensure 启动超时 → 错误 + 日志尾
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** 宿主服务在工具侧的最小面(由 index.ts 注入,避免循环依赖) */
export interface ToolContext {
	workspaceId: string;
	cwd: string;
	devserver: {
		ensure: (workspaceId: string, opts: any) => Promise<any>;
		stop: (workspaceId: string) => Promise<any>;
		status: (workspaceId: string) => any;
	};
	probe: typeof import("./test-runner").HttpProbe.run;
	testRunner: {
		run: (cwd: string, files: string[], total: number) => Promise<any>;
	};
	scanTests: (cwd: string) => string[];
	changedFiles: (workspaceId: string) => Promise<string[]>;
	browsers: {
		navigate: (workspaceId: string, url: string) => Promise<any>;
		click: (workspaceId: string, selector: string) => Promise<any>;
		fill: (workspaceId: string, selector: string, value: string) => Promise<any>;
		capture: (workspaceId: string, kind?: "shot") => Promise<any>;
	};
	checks: {
		run: (workspaceId: string, ids?: string[]) => Promise<any>;
		create: (workspaceId: string, title: string, kind: "asset" | "temp", assertion: any, appliesTo?: string[]) => any;
	};
	plans: {
		create: (workspaceId: string, goal: string, steps: string[]) => any;
		stepDone: (planId: string, stepIndex: number) => Promise<any>;
		current: (workspaceId: string) => string | undefined;
	};
	memory: {
		suggest: (scope: "project" | "user", file: string, lines: string[], reason: string) => any;
	};
}

function fmt(v: unknown): string {
	return typeof v === "string" ? v : JSON.stringify(v);
}

export function buildJideTools(ctx: ToolContext) {
	const devServer = defineTool({
		parameters: Type.Object({
			action: Type.Union([Type.Literal("ensure"), Type.Literal("stop"), Type.Literal("status")]),
			port: Type.Optional(Type.Number({ description: "dev server 端口(默认 5175)" })),
			command: Type.Optional(Type.String({ description: "启动命令(默认 bunx vite --port N)" })),
			probe: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("http"), Type.Literal("port"), Type.Literal("log")])),
		}),
			name: "dev_server",
			label: "dev server 管理",
			description:
				"管理当前工作区的 dev server(启动并等待就绪/停止/查状态)。agent 与内嵌预览共享同一实例。ensure 返回 {url, port, probeMode, startedMs};启动超时返回错误与日志尾。",
			promptSnippet: "dev_server({action:'ensure'}) → {url}:启动并等待 dev server 就绪(三模式探测)。",
			execute: async (_id, params) => {
				try {
					if (params.action === "stop") {
						const r = await ctx.devserver.stop(ctx.workspaceId);
						return { content: [{ type: "text", text: fmt(r) }] };
					}
					if (params.action === "status") {
						return { content: [{ type: "text", text: fmt(ctx.devserver.status(ctx.workspaceId)) }] };
					}
					const r = await ctx.devserver.ensure(ctx.workspaceId, {
						command: params.command ?? `bunx vite --port ${params.port ?? 5175}`,
						cwd: ctx.cwd,
						port: params.port ?? 5175,
						probe: params.probe ?? "auto",
					});
					if (!r.ok) {
						return {
							content: [{ type: "text", text: `启动失败:${r.error}\n日志尾:\n${r.logTail ?? "(空)"}` }],
							isError: true,
						};
					}
					return { content: [{ type: "text", text: `就绪 url=${r.url} probe=${r.probeMode} ${r.startedMs}ms` }] };
				} catch (e: any) {
					return { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true };
				}
			},
		},
	);

	const httpProbe = defineTool({
		parameters: Type.Object({
			url: Type.String(),
			expectStatus: Type.Optional(Type.Number()),
			contains: Type.Optional(Type.String({ description: "响应须包含的文本" })),
			jsonPath: Type.Optional(Type.String({ description: "如 total.yuan" })),
			jsonEquals: Type.Optional(Type.String()),
		}),
			name: "http_probe",
			label: "HTTP 探测",
			description:
				"对 url 发请求并按期望断言(状态码/包含文本/JSON 路径)。断言失败不是工具失败:返回 passed:false 与实际值,供你判断后重试或修复。",
			promptSnippet: "http_probe({url, jsonPath, jsonEquals}) → {passed, actual}:接口级自测断言。",
			execute: async (_id, p) => {
				const r = await ctx.probe(p.url, {
					expectStatus: p.expectStatus,
					contains: p.contains,
					jsonPath: p.jsonPath,
					jsonEquals: p.jsonEquals,
				});
				if (!r.ok) return { content: [{ type: "text", text: `探测失败:${r.error}` }], isError: true };
				return {
					content: [{ type: "text", text: `passed=${r.passed} actual=${r.actual}${r.detail ? ` detail=${r.detail}` : ""}` }],
				};
			},
		},
	);

	const browser = defineTool({
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("navigate"),
				Type.Literal("click"),
				Type.Literal("fill"),
				Type.Literal("capture"),
			]),
			url: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String({ description: "CSS 选择器" })),
			value: Type.Optional(Type.String()),
		}),
			name: "browser",
			label: "浏览器自动化",
			description:
				"浏览器实操验证:navigate(url) 打开页面;click(selector) 点击;fill(selector,value) 填写;capture 截图(多模态回传,落盘为证据)。元素不存在是可重试错误。",
			promptSnippet: "browser({action:'navigate',url}) / click / fill / capture:浏览器级验证与截图证据。",
			execute: async (_id, p) => {
				try {
					if (p.action === "navigate" && p.url) {
						const r = await ctx.browsers.navigate(ctx.workspaceId, p.url);
						return r.ok
							? { content: [{ type: "text", text: `已打开:${p.url}${r.title ? ` (title=${r.title})` : ""}` }] }
							: { content: [{ type: "text", text: r.error }], isError: true };
					}
					if (p.action === "click" && p.selector) {
						const r = await ctx.browsers.click(ctx.workspaceId, p.selector);
						return r.ok
							? { content: [{ type: "text", text: `已点击 ${p.selector}` }] }
							: { content: [{ type: "text", text: `${r.error}(可稍后重试)` }], isError: true };
					}
					if (p.action === "fill" && p.selector) {
						const r = await ctx.browsers.fill(ctx.workspaceId, p.selector, p.value ?? "");
						return r.ok
							? { content: [{ type: "text", text: `已填写 ${p.selector}` }] }
							: { content: [{ type: "text", text: r.error }], isError: true };
					}
					if (p.action === "capture") {
						const r = await ctx.browsers.capture(ctx.workspaceId, "shot");
						return r.ok
							? { content: [{ type: "text", text: `截图已回传:${r.path}(${Math.round((r.dataBase64.length * 0.75) / 1024)}KB)` }] }
							: { content: [{ type: "text", text: r.error }], isError: true };
					}
					return { content: [{ type: "text", text: "参数不足" }], isError: true };
				} catch (e: any) {
					return { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true };
				}
			},
		},
	);

	const testRun = defineTool({
		parameters: Type.Object({
			scope: Type.Union([Type.Literal("diff"), Type.Literal("all")], { default: "diff" }),
		}),
			name: "test_run",
			label: "智能选测",
			description:
				"运行测试。scope=diff 按 git 变更文件映射关联用例子集(如 12/48);all 全量回归(子集失败时再全量)。返回逐用例结果;用例失败不是工具失败。",
			promptSnippet: "test_run({scope:'diff'}) → 选中 N/M 用例逐条结果;先选测,失败再 all。",
			execute: async (_id, p) => {
				const all = ctx.scanTests(ctx.cwd);
				const selected = p.scope === "all" ? all : await (async () => {
					const changed = await ctx.changedFiles(ctx.workspaceId);
					const { mapFilesToTests } = await import("./test-runner");
					return mapFilesToTests(changed, all);
				})();
				if (!selected.length) {
					return { content: [{ type: "text", text: `选测 0/${all.length}(无关联用例);如需回归请 scope=all` }] };
				}
				const r = await ctx.testRunner.run(ctx.cwd, selected, all.length);
				const pass = r.results.filter((x: any) => x.status === "pass").length;
				const fail = r.results.filter((x: any) => x.status === "fail").length;
				const lines = r.results.map(
					(x: any) => `${x.status === "pass" ? "✓" : x.status === "fail" ? "✗" : "–"} ${x.name} ${x.durationMs}ms${x.message ? "\n    " + String(x.message).slice(0, 300) : ""}`,
				);
				return {
					content: [
						{ type: "text", text: `选测 ${selected.length}/${all.length} · 通过 ${pass} · 失败 ${fail} · ${r.durationMs}ms\n${lines.join("\n")}` },
					],
				};
			},
		},
	);

	const checks = defineTool({
		parameters: Type.Object({
			action: Type.Union([Type.Literal("verify"), Type.Literal("create")]),
			title: Type.Optional(Type.String()),
			kind: Type.Optional(Type.Union([Type.Literal("asset"), Type.Literal("temp")])),
			assertion: Type.Optional(Type.Object({ type: Type.String(), url: Type.Optional(Type.String()), contains: Type.Optional(Type.String()) })),
			ids: Type.Optional(Type.Array(Type.String())),
		}),
			name: "checks",
			label: "检查项",
			description:
				"检查项 = 沉淀为项目资产的验收断言(.jide/checks/)。verify 运行(全部或指定 ids),逐项通过/失败附证据;create 新建(asset=跨会话复用、diff 命中自动带上)。",
			promptSnippet: "checks({action:'verify'}) → 逐项 pass/fail;完成后把断言 create 成 asset。",
			execute: async (_id, p) => {
				if (p.action === "create" && p.title && p.assertion) {
					const r = ctx.checks.create(ctx.workspaceId, p.title, p.kind ?? "asset", p.assertion as any);
					return r.ok
						? { content: [{ type: "text", text: `已创建检查项 ${r.id}(${p.title})` }] }
						: { content: [{ type: "text", text: r.error }], isError: true };
				}
				const r = await ctx.checks.run(ctx.workspaceId, p.ids);
				const lines = r.results.map((x: any) => `${x.passed ? "✓" : "✗"} ${x.title}${x.detail ? " · " + x.detail : ""}`);
				return { content: [{ type: "text", text: `检查项 ${r.results.filter((x: any) => x.passed).length}/${r.results.length} 通过\n${lines.join("\n")}` }] };
			},
		},
	);

	const plan = defineTool({
		parameters: Type.Object({
			action: Type.Union([Type.Literal("create"), Type.Literal("step_done")]),
			goal: Type.Optional(Type.String()),
			steps: Type.Optional(Type.Array(Type.String())),
			stepIndex: Type.Optional(Type.Number()),
		}),
			name: "plan",
			label: "计划",
			description:
				"计划 = 当前任务步骤清单(用户在右侧面板可见)。create(goal, steps[]) 建立;step_done(stepIndex) 标记完成——隔离工作区会自动提交(Agent · 计划步骤 N)并进入评审队列。",
			promptSnippet: "plan({action:'create',goal,steps}) 建立 todo;step_done 逐步推进(自动提交)。",
			execute: async (_id, p) => {
				if (p.action === "create" && p.goal && p.steps) {
					const r = ctx.plans.create(ctx.workspaceId, p.goal, p.steps);
					return { content: [{ type: "text", text: `计划已建立(${p.steps.length} 步),面板可见;逐步执行后用 step_done 推进` }] };
				}
				if (p.action === "step_done" && p.stepIndex !== undefined) {
					const cur = ctx.plans.current(ctx.workspaceId);
					if (!cur) return { content: [{ type: "text", text: "当前工作区无进行中计划,先 create" }], isError: true };
					const r = await ctx.plans.stepDone(cur, p.stepIndex);
					return r.ok
						? { content: [{ type: "text", text: `步骤 ${p.stepIndex + 1} 完成${r.commit ? `,自动提交 ${r.commit.sha}` : ""}` }] }
						: { content: [{ type: "text", text: r.error }], isError: true };
				}
				return { content: [{ type: "text", text: "参数不足" }], isError: true };
			},
		},
	);

	const memorySuggest = defineTool({
		parameters: Type.Object({
			scope: Type.Union([Type.Literal("project"), Type.Literal("user")]),
			file: Type.String({ description: "如 conventions.md / feedback.md" }),
			lines: Type.Array(Type.String(), { description: "一行一事" }),
			reason: Type.String({ description: "来源说明,如 会话沉淀:购物车修复" }),
		}),
			name: "memory_suggest",
			label: "记忆建议",
			description:
				"提议写入项目记忆(.memory/,用户可见)。不会静默写入:以建议卡片呈现给用户,采纳/忽略/改后采纳由用户决定。",
			promptSnippet: "memory_suggest({scope,file,lines,reason}) → 建议卡片(用户三动作)。",
			execute: async (_id, p) => {
				ctx.memory.suggest(p.scope, p.file, p.lines, p.reason);
				return { content: [{ type: "text", text: `已生成记忆建议卡片(${p.file},${p.lines.length} 条),等待用户采纳` }] };
			},
		},
	);

	const gitDiff = defineTool({
		parameters: Type.Object({}),
			name: "git_diff_files",
			label: "变更文件",
			description: "列出当前工作区相对 HEAD 的变更文件(供选测与计划参考)。",
			promptSnippet: "git_diff_files() → 变更文件列表(M/A/D/?)。",
			execute: async () => {
				const changed = await ctx.changedFiles(ctx.workspaceId);
				return { content: [{ type: "text", text: changed.length ? changed.join("\n") : "(无变更)" }] };
			},
		},
	);

	return [devServer, httpProbe, browser, testRun, checks, plan, memorySuggest, gitDiff];
}
