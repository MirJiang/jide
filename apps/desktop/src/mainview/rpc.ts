/**
 * 渲染层 RPC 客户端(DR-TS-05 起 = Electron IPC 桥)
 * window.jide 由 electron/preload.ts 注入;契约类型仍来自 @jide/contracts。
 * 公开接口(JideClient/connect)与旧 Electrobun 版逐签名一致,UI 层零改动。
 */

import type { HostRequestShapes, HostEvent } from "@jide/contracts";
import { isHostEvent, type HostEventHandler } from "@jide/contracts";

export interface JideClient {
	request<M extends keyof HostRequestShapes>(
		method: M,
		params: HostRequestShapes[M]["params"],
	): Promise<HostRequestShapes[M]["response"]>;
	resync(lastSeq: number): void;
}

interface JideBridge {
	request(method: string, params: unknown): Promise<unknown>;
	resync(lastSeq: number): void;
	onEvent(cb: (event: unknown) => void): void;
}

function bridge(): JideBridge {
	const b = (window as unknown as { jide?: JideBridge }).jide;
	if (!b) throw new Error("jide 桥未注入(preload 缺失或非 Electron 环境)");
	return b;
}

/** 建立 RPC 连接;onEvent 收到宿主事件流(过滤非法包) */
export function connect(onEvent: HostEventHandler): JideClient {
	const b = bridge();
	b.onEvent((raw) => {
		if (isHostEvent(raw)) onEvent(raw);
	});

	return {
		request: (method, params) => b.request(method, params) as Promise<HostRequestShapes[typeof method]["response"]>,
		resync: (lastSeq) => b.resync(lastSeq),
	};
}
