/**
 * JIDE 危险命令门禁(pi 进程内扩展,经 `pi --mode rpc -e <本文件>` 加载)
 *
 * 拦截 bash 工具调用,命中危险模式时 block,agent 会把"需用户确认"转述给用户;
 * 项目豁免:运行时读 <cwd>/.jide/allow-dangerous.json(每条为子串匹配模式)。
 * 与进程内旧 guard-extension.ts 同一套模式表;CLI 扩展 API 的 block 形状为
 * `{ block: true, reason }`(docs/extensions.md)。
 *
 * 本文件不 import 任何包 —— 由 pi 的 jiti 直接加载。
 */

import { readFileSync } from "node:fs";

const DANGEROUS_PATTERNS = [
	{ re: /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\b/i, label: "递归强制删除" },
	{ re: /\brm\s+-rf?\s+[~*\/]/i, label: "删除根/家目录" },
	{ re: /\bgit\s+push\s+.*--force/i, label: "强推" },
	{ re: /\bgit\s+reset\s+--hard/i, label: "硬重置(丢工作区)" },
	{ re: /\b(rmdir|rd)\s+\/s/i, label: "递归删目录" },
	{ re: /\bformat\s+[a-z]:/i, label: "格式化盘" },
	{ re: /\bshutdown\b|\breboot\b/i, label: "关机/重启" },
	{ re: />\s*\/dev\/sd[a-z]/i, label: "直写磁盘" },
	{ re: /\bcurl\b[^|]*\|\s*(ba)?sh\b/i, label: "管道执行远程脚本" },
];

function loadAllowList() {
	try {
		const raw = readFileSync(`${process.cwd()}/.jide/allow-dangerous.json`, "utf8");
		const arr = JSON.parse(raw);
		return Array.isArray(arr) ? arr.map(String) : [];
	} catch {
		return [];
	}
}

/** 权限模式(auto|confirm;session.setPermissionMode 写入,每次调用读盘) */
function loadMode(): "auto" | "confirm" {
	try {
		const raw = readFileSync(`${process.cwd()}/.jide/guard-mode.json`, "utf8");
		return JSON.parse(raw)?.mode === "confirm" ? "confirm" : "auto";
	} catch {
		return "auto";
	}
}

export default function (pi: any) {
	pi.on("tool_call", async (event: any, ctx: any) => {
		if (event.tool !== "bash" && event.toolName !== "bash") return;
		const cmd = String(event.args?.command ?? event.args?.cmd ?? "");
		if (!cmd) return;

		// 权限模式 confirm:每条 bash 命令先经用户确认(RPC 下 ctx.ui.confirm → 宿主 UI 卡片)
		if (loadMode() === "confirm") {
			const allowed = await ctx?.ui?.confirm?.("JIDE 权限确认", `允许执行命令?\n${cmd.slice(0, 500)}`);
			if (!allowed) {
				return {
					block: true,
					reason: "用户拒绝了该命令(权限模式:执行前确认)。请向用户说明意图后再试,或改用其他方案。",
				};
			}
		}

		const hit = DANGEROUS_PATTERNS.find((p) => p.re.test(cmd));
		if (!hit) return;
		for (const a of loadAllowList()) {
			if (cmd.includes(a)) return; // 项目豁免(子串精确匹配)
		}
		return {
			block: true,
			reason:
				`⛔ 危险命令被 JIDE 安全门禁拦截(${hit.label})。` +
				`请先在对话中向用户说明这条命令的作用与影响,征得明确同意后再执行;` +
				`用户也可在 .jide/allow-dangerous.json 中为该模式配置豁免。`,
		};
	});
}
