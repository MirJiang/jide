/**
 * [仅测试/smoke] DemoEngine — 进程内脚本引擎(原 demo-faux 的 pi-free 替代)
 * 不联网、不花 token、不依赖任何 pi 包;按脚本合成与真实引擎同构的 EngineEvent 流。
 * 会话历史自写 JSONL(<sessionDir>/<sessionId>.jsonl),支撑 rebuild 恢复计数。
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentEngine, EngineEvent, EngineMessage } from "./agent-engine";

/** 演示脚本:文本流 → 工具调用 → 总结,与原 faux 版形态一致 */
const DEMO_STEPS: Array<{ kind: "text" | "tool"; text: string; toolName?: string }> = [
	{
		kind: "text",
		text: "收到。我是 JIDE 的本地演练 agent(faux provider)——不联网、不花 token,但走的是真实会话链路:这条消息会流式渲染到界面。",
	},
	{
		kind: "tool",
		toolName: "read",
		text: "我演示一次工具调用:工具结果已回传(演练)。JIDE 的差异化在后面:改完自己测、测完自己验。现在可以点「停止」试试中断,或「重建会话」验证恢复。",
	},
];

export interface DemoEngineOptions {
	cwd: string;
	sessionDir: string;
	/** 重建:重开既有会话文件(sessionId 从文件名还原) */
	sessionFile?: string;
}

export class DemoEngine implements AgentEngine {
	kind = "demo" as const;
	sessionId: string;
	sessionFilePath: string;
	readonly modelLabel = "faux-demo(本地演练)";

	private listeners = new Set<(e: EngineEvent) => void>();
	private cached: EngineMessage[] = [];
	private aborted = false;

	constructor(private opts: DemoEngineOptions) {
		if (opts.sessionFile) {
			this.sessionFilePath = opts.sessionFile;
			this.sessionId = opts.sessionFile.split(/[\\/]/).pop()!.replace(/\.jsonl$/, "");
		} else {
			this.sessionId = `demo-${randomUUID().slice(0, 8)}`;
			this.sessionFilePath = join(opts.sessionDir, `${this.sessionId}.jsonl`);
		}
	}

	onEvent(cb: (e: EngineEvent) => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private emit(e: EngineEvent) {
		for (const cb of this.listeners) cb(e);
	}

	private streamText(text: string) {
		const chunks = text.match(/[\s\S]{1,6}/g) ?? [];
		for (const chunk of chunks) {
			if (this.aborted) return;
			this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: chunk } });
		}
	}

	async prompt(text: string): Promise<void> {
		this.aborted = false;
		this.append({ role: "user", text });
		this.cached.push({ role: "user", text });
		this.emit({ type: "agent_start" });
		for (const step of DEMO_STEPS) {
			if (this.aborted) break;
			if (step.kind === "tool") {
				this.emit({ type: "tool_execution_start", toolName: step.toolName ?? "unknown" });
				this.emit({ type: "tool_execution_end", toolName: step.toolName ?? "unknown", isError: false });
			}
			this.streamText(step.text);
			if (this.aborted) break;
			const msg = { role: "assistant" as const, content: step.text };
			this.emit({ type: "message_end", message: msg });
			this.append({ role: "assistant", text: step.text });
			this.cached.push({ role: "assistant", text: step.text });
			await Bun.sleep(10);
		}
		this.emit({ type: "agent_settled" });
	}

	async abort(): Promise<void> {
		this.aborted = true; // 流式循环下一片退出;idle 时调用是安全幂等
	}

	/** 脚本引擎不支持插队注入(保持接口同构,静默忽略) */
	async steer(_text: string): Promise<void> {}

	snapshotMessages(): EngineMessage[] {
		return [...this.cached];
	}

	async messages(): Promise<EngineMessage[]> {
		if (!existsSync(this.sessionFilePath)) return this.cached;
		const lines = readFileSync(this.sessionFilePath, "utf8").split("\n").filter(Boolean);
		const parsed: EngineMessage[] = [];
		for (const line of lines) {
			try {
				const o = JSON.parse(line);
				if (o?.role === "user" || o?.role === "assistant") parsed.push({ role: o.role, text: String(o.text ?? "") });
			} catch {
				// 半行/坏行跳过
			}
		}
		this.cached = parsed;
		return [...parsed];
	}

	async dispose(): Promise<void> {
		this.aborted = true;
	}

	private append(m: EngineMessage) {
		try {
			appendFileSync(this.sessionFilePath, `${JSON.stringify({ ...m, ts: Date.now() })}\n`);
		} catch {
			// 演练路径,落盘失败不影响事件流
		}
	}
}
