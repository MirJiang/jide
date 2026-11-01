/**
 * EventStore — 宿主事件磁盘持久化(daemon 事件日志)
 *
 * daemon 唯一 journal(内存)之外的落盘层:每条事件追加 JSONL;
 * daemon 重启时回读,重建近期事件上下文(seq 重新从 1 编号 —— 跨重启的
 * resync 以快照类 RPC 兜底,这里保证"新连接可回放近期全量"与调试轨迹)。
 * 超过 maxBytes 轮转为 .old(保留一代)。
 */

import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { isHostEventType, type HostEvent } from "@jide/contracts";

export interface EventStoreOptions {
	maxBytes?: number;
	/** 回读上限(条) */
	maxLoad?: number;
}

export class EventStore {
	private path: string;
	private oldPath: string;
	private maxBytes: number;
	private maxLoad: number;

	constructor(dir: string, opts: EventStoreOptions = {}) {
		this.path = join(dir, "events.jsonl");
		this.oldPath = join(dir, "events.jsonl.old");
		this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
		this.maxLoad = opts.maxLoad ?? 10_000;
	}

	append(e: HostEvent) {
		try {
			if (existsSync(this.path) && statSync(this.path).size > this.maxBytes) {
				try {
					renameSync(this.path, this.oldPath);
				} catch {
					/* 轮转失败不阻塞写入 */
				}
			}
			appendFileSync(this.path, JSON.stringify(e) + "\n");
		} catch {
			/* 落盘失败不阻塞事件流 */
		}
	}

	/** 回读(只取合法事件;最多 maxLoad 条);文件不存在返回空 */
	load(): HostEvent[] {
		const read = (p: string): HostEvent[] => {
			if (!existsSync(p)) return [];
			const out: HostEvent[] = [];
			const lines = readFileSync(p, "utf8").split("\n");
			for (const line of lines) {
				if (!line.trim() || out.length >= this.maxLoad) break;
				try {
					const e = JSON.parse(line);
					if (isHostEventType(e?.type) && typeof e.seq === "number") out.push(e as HostEvent);
				} catch {
					/* 坏行跳过 */
				}
			}
			return out;
		};
		// .old 在前(更早),当前文件在后
		return [...read(this.oldPath), ...read(this.path)];
	}
}
