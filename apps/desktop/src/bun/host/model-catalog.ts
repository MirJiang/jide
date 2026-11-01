/**
 * ModelCatalog — pi 模型目录(get_available_models)的宿主缓存
 *
 * 目录来自用户 ~/.pi 的模型配置(pi 内置目录 + models.json / models-store),
 * 读取不需要认证。宿主拉起临时 `pi --mode rpc --no-session` 进程查询后立即回收;
 * 结果缓存 cacheTtlMs(默认 5 分钟),refresh=true 强制重拉。
 *
 * 拉起临时进程约 1-3s(含模型目录刷新),UI 侧应有「刷新中」态。
 */

import { join } from "node:path";
import { modelKey, type PiModelInfo } from "@jide/contracts";
import { PiRpcClient, resolvePiCli } from "./pi-rpc-client";

export type ModelSpawner = () => Promise<PiRpcClient>;

export class ModelCatalog {
	private cache: PiModelInfo[] | null = null;
	private cachedAt = 0;
	private inflight: Promise<PiModelInfo[]> | null = null;

	constructor(
		private opts: {
			cacheTtlMs?: number;
			/** 测试注入;默认拉起真实临时 pi */
			spawner?: ModelSpawner;
		} = {},
	) {}

	/** 投影 pi Model 对象 → PiModelInfo(容错:缺 provider/id 的条目丢弃) */
	static project(raw: any): PiModelInfo | null {
		const provider = String(raw?.provider ?? "");
		const id = String(raw?.id ?? "");
		if (!provider || !id) return null;
		return {
			key: modelKey(provider, id),
			provider,
			id,
			name: String(raw?.name ?? id),
			reasoning: Boolean(raw?.reasoning),
			...(raw?.contextWindow !== undefined ? { contextWindow: Number(raw.contextWindow) } : {}),
			...(raw?.maxTokens !== undefined ? { maxTokens: Number(raw.maxTokens) } : {}),
		};
	}

	async list(refresh = false): Promise<PiModelInfo[]> {
		const ttl = this.opts.cacheTtlMs ?? 5 * 60_000;
		if (!refresh && this.cache && Date.now() - this.cachedAt < ttl) return this.cache;
		if (this.inflight) return this.inflight;
		this.inflight = (async () => {
			const models = await this.fetchOnce();
			this.cache = models;
			this.cachedAt = Date.now();
			return models;
		})();
		try {
			return await this.inflight;
		} finally {
			this.inflight = null;
		}
	}

	private async fetchOnce(): Promise<PiModelInfo[]> {
		const spawn = this.opts.spawner ?? defaultSpawner;
		const client = await spawn();
		try {
			const r = await client.request({ type: "get_available_models" }, 20_000);
			const raws: any[] = Array.isArray(r?.models) ? r.models : [];
			const out: PiModelInfo[] = [];
			const seen = new Set<string>();
			for (const raw of raws) {
				const m = ModelCatalog.project(raw);
				if (m && !seen.has(m.key)) {
					seen.add(m.key);
					out.push(m);
				}
			}
			out.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
			return out;
		} finally {
			await client.dispose();
		}
	}
}

/** 默认拉起:临时 pi --mode rpc --no-session(不落会话文件,查完即收) */
async function defaultSpawner(): Promise<PiRpcClient> {
	const { nodePath, cliPath } = resolvePiCli();
	return PiRpcClient.spawn({
		nodePath,
		cliPath,
		cwd: join(process.env.JIDE_HOME ?? process.cwd()),
		args: ["--no-session"],
	});
}
