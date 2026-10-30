/**
 * view 侧 RPC 客户端:与 src/bun/index.ts 的 JideRPC 镜像
 * (类型来自 @jide/contracts;electrobun/view 的 defineRPC 需要具体形状)
 */

import Electrobun, { Electroview } from "electrobun/view";
import type { RPCSchema } from "electrobun/view";
import type { HostRequestShapes, HostEvent } from "@jide/contracts";
import { isHostEvent, type HostEventHandler } from "@jide/contracts";

type JideRPCView = {
	bun: {
		requests: {
			[K in keyof HostRequestShapes]: {
				params: HostRequestShapes[K]["params"];
				response: HostRequestShapes[K]["response"];
			};
		};
		messages: {
			resync: { lastSeq: number };
		};
	};
	webview: {
		requests: {};
		messages: {
			event: HostEvent;
		};
	};
};

export interface JideClient {
	request<M extends keyof HostRequestShapes>(
		method: M,
		params: HostRequestShapes[M]["params"],
	): Promise<HostRequestShapes[M]["response"]>;
	resync(lastSeq: number): void;
}

/** 建立 RPC 连接;onEvent 收到宿主事件流(过滤非法包) */
export function connect(onEvent: HostEventHandler): JideClient {
	const rpc = Electroview.defineRPC<JideRPCView>({
		maxRequestTime: 120_000,
		handlers: {
			requests: {},
			messages: {
				event: (payload) => {
					if (isHostEvent(payload)) onEvent(payload);
				},
			},
		},
	});

	const electrobun = new Electrobun.Electroview({ rpc });

	return {
		request: (method, params) =>
			(electrobun.rpc!.request as any)[method](params),
		resync: (lastSeq) => {
			(electrobun.rpc as any)?.send?.resync({ lastSeq });
		},
	};
}
