/**
 * JIDE 记忆注入(pi 进程内扩展,经 `pi --mode rpc -e <本文件>` 加载)
 *
 * 宿主把三级记忆文本写到 <会话目录>/.jide-memory.md,并以环境变量
 * JIDE_MEMORY_FILE 传路径;本扩展在每次 prompt 前(before_agent_start)
 * 把内容追加到 systemPrompt —— 等价于旧进程内 agentsFilesOverride 注入。
 *
 * 本文件不 import 任何包 —— 由 pi 的 jiti 直接加载。
 */

import { readFileSync } from "node:fs";

function loadMemory() {
	try {
		const p = process.env.JIDE_MEMORY_FILE;
		if (!p) return "";
		return readFileSync(p, "utf8");
	} catch {
		return "";
	}
}

export default function (pi) {
	pi.on("before_agent_start", async (event) => {
		const memory = loadMemory();
		if (!memory?.trim()) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n<jide_memory>\n${memory.trim()}\n</jide_memory>`,
		};
	});
}
