/**
 * demo 模式:pi Faux Provider 全链路本地演练(M1 验收通道,无网络/无密钥)
 *
 * 两大陷阱均按 dg-piagent H03 处理:
 *  1. ModelRuntime 必须 registerProvider(faux 配置),否则 prompt 报 "Provider is not configured";
 *  2. 双 pi-ai 实例陷阱 —— 本项目 bun 安装同版本会去重提升;安装后自检
 *     node_modules/@earendil-works/pi-coding-agent/node_modules 不存在即单实例。
 */

import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** 演示脚本:完整走一遍 文本流 → 工具调用 → 总结 的形态 */
const DEMO_SCRIPT = [
	fauxAssistantMessage(
		"收到。我是 JIDE 的本地演练 agent(faux provider)——不联网、不花 token,但走的是真实 pi 会话链路:这条消息会流式渲染到界面。",
	),
	fauxAssistantMessage(
		[
			fauxText("我演示一次工具调用:"),
			fauxToolCall("read", { file_path: "src/cart.ts" }),
		],
		{ stopReason: "toolUse" },
	),
	fauxAssistantMessage(
		"工具结果已回传(演练)。JIDE 的差异化在后面:改完自己测、测完自己验。现在可以点「停止」试试中断,或「重建会话」验证恢复。",
	),
];

/** 构造 demo 模式的 createAgentSession 增量参数(model + modelRuntime) */
export async function createDemoRuntime() {
	const faux = registerFauxProvider({ tokensPerSecond: 120 });
	faux.setResponses(DEMO_SCRIPT);

	const modelRuntime = await ModelRuntime.create({
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(faux.models[0].provider, {
		baseUrl: faux.models[0].baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			baseUrl: m.baseUrl,
		})),
	});

	return {
		model: faux.getModel(),
		modelRuntime,
	};
}
