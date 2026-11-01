/**
 * DevLogPump — 宿主推送式日志回喂("AI 实时看日志"零桥路径,§用户愿景②)
 *
 * DevServerManager 逐行回调 → 错误行进缓冲 → debounce 合并 → steer 插队到该工作区
 * 运行中的 agent 会话(pi RPC steer,复用既有 stdio 通道,不依赖工具桥)。
 *
 * 行为边界(防失控):
 *  - 只对 agent 运行中(busy)的会话插队;空闲不自动起轮 —— 避免未经用户同意的
 *    API 消耗,只在 host.log 提示"可让 agent 排查";
 *  - debounce 合并一次错误爆发(默认 2.5s);每工作区最小间隔(默认 15s);
 *  - 每 agent 轮最多推送 3 次(agent.settled 时经 handleHostEvent 重置),
 *    超出降级为 host.log;缓冲上限 60 行,超出丢最旧。
 */

import type { AgentHost } from "./agent-host";

const ERROR_RE = /\b(error|failed|exception|fatal)\b|EADDRINUSE|ENOENT|EACCES|Segmentation/i;

export interface DevLogPumpOptions {
	debounceMs?: number;
	minIntervalMs?: number;
	maxPushesPerTurn?: number;
	maxBufferLines?: number;
	/** 模型精判(两级过滤第二级):返回 false = 判定不值得打断(降级 host.log);null = 精判不可用(回退直推) */
	judge?: (workspaceId: string, tail: string) => Promise<boolean | null>;
}

interface HostEventLike {
	type: string;
	sessionId?: string;
}

export class DevLogPump {
	private buf = new Map<string, string[]>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private lastPushAt = new Map<string, number>();
	private pushCount = new Map<string, number>();
	private emit: (e: HostEventLike) => void = () => {};
	private readonly opts: Required<DevLogPumpOptions>;

	constructor(
		private host: {
			log: (level: "info" | "warn" | "error", message: string) => void;
			steerBusyForWorkspace: (workspaceId: string, text: string) => Promise<number>;
			getSession: (sessionId: string) => { workspaceId?: string } | undefined;
			hasSessionForWorkspace: (workspaceId: string) => boolean;
			hasBusySessionForWorkspace: (workspaceId: string) => boolean;
		},
		opts?: DevLogPumpOptions,
	) {
		this.opts = {
			debounceMs: 2_500,
			minIntervalMs: 15_000,
			maxPushesPerTurn: 3,
			maxBufferLines: 60,
			...opts,
		};
	}

	/** 订阅宿主事件流(agent.settled 重置轮次计数) */
	bindEmitter(emit: (e: HostEventLike) => void) {
		this.emit = emit;
	}

	handleHostEvent(e: HostEventLike) {
		if (e.type === "agent.settled" && e.sessionId) {
			const entry = this.host.getSession(e.sessionId);
			if (entry?.workspaceId) this.pushCount.delete(entry.workspaceId);
		}
	}

	/** DevServerManager 逐行回调入口(同步上下文,只做入队) */
	onLine(workspaceId: string, line: string) {
		if (!ERROR_RE.test(line)) return;
		const buf = this.buf.get(workspaceId) ?? [];
		buf.push(line);
		if (buf.length > this.opts.maxBufferLines) buf.splice(0, buf.length - this.opts.maxBufferLines);
		this.buf.set(workspaceId, buf);
		if (this.timers.has(workspaceId)) return; // debounce 中
		this.timers.set(
			workspaceId,
			setTimeout(() => {
				this.timers.delete(workspaceId);
				void this.flush(workspaceId);
			}, this.opts.debounceMs),
		);
	}

	dispose() {
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		this.buf.clear();
	}

	private async flush(workspaceId: string) {
		const lines = this.buf.get(workspaceId);
		if (!lines?.length) return;
		const now = Date.now();
		const last = this.lastPushAt.get(workspaceId) ?? 0;
		const since = now - last;
		if (since < this.opts.minIntervalMs) {
			// 冷却期:缓冲保留,到点重试(错误不丢);重试间隔不低于 debounce,避免紧密轮询
			this.timers.set(
				workspaceId,
				setTimeout(() => {
					this.timers.delete(workspaceId);
					void this.flush(workspaceId);
				}, Math.max(this.opts.minIntervalMs - since, this.opts.debounceMs)),
			);
			return;
		}

		const count = this.pushCount.get(workspaceId) ?? 0;
		const tail = lines.splice(0, lines.length).join("\n");

		if (count >= this.opts.maxPushesPerTurn) {
			this.host.log("warn", `dev server 持续报错(本轮已插队 ${count} 次,降级为日志):${tail.slice(0, 160)}`);
			return;
		}

		this.lastPushAt.set(workspaceId, now);
		const tailText = `【宿主推送】dev server 日志出现错误:\n${tail}`;

		// 两级过滤第二级:模型精判(仅当确有 busy 会话可打断;失败回退直推)
		if (this.opts.judge) {
			const hasBusy = this.host.hasBusySessionForWorkspace(workspaceId);
			if (hasBusy) {
				const verdict = await this.opts.judge(workspaceId, tail).catch(() => null);
				if (verdict === false) {
					this.host.log("info", `精判:该错误暂不值得打断 agent(已记录):${tail.slice(0, 120)}`);
					return;
				}
			}
		}

		const pushed = await this.host.steerBusyForWorkspace(workspaceId, tailText);
		if (pushed > 0) {
			this.pushCount.set(workspaceId, count + 1);
			this.host.log("info", `dev server 错误日志已插队推送给 agent(${pushed} 个会话)`);
		} else if (this.host.hasSessionForWorkspace(workspaceId)) {
			this.host.log("info", `dev server 报错(agent 空闲,未自动插队;可让 agent 排查):${tail.slice(0, 200)}`);
		}
	}
}
