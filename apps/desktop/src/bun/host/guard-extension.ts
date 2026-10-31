/**
 * 危险命令确认门禁(§7.5 / D04):
 *
 * pi 扩展拦截 tool_call(bash)→ 命中危险模式时 block 并让 agent
 * 转向用户确认(在对话中询问);项目可配置豁免(.jide/allow-dangerous.json)。
 * 工具被 block 时返回可恢复语义:agent 会把"需用户确认"转述给用户。
 */

export const DANGEROUS_PATTERNS: Array<{ re: RegExp; label: string }> = [
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

export function isDangerous(command: string): { hit: boolean; label?: string } {
	for (const p of DANGEROUS_PATTERNS) {
		if (p.re.test(command)) return { hit: true, label: p.label };
	}
	return { hit: false };
}

/** pi 扩展(pi.on tool_call 拦截;返回 block 决策) */
export function createGuardExtension(allowList: string[] = []) {
	const allowed = new Set(allowList);
	return {
		name: "jide-guard",
		setup(pi: any) {
			pi.on("tool_call", async (event: any, ctx: any) => {
				if (event.tool !== "bash" && event.toolName !== "bash") return;
				const cmd = String(event.args?.command ?? event.args?.cmd ?? "");
				if (!cmd) return;
				const { hit, label } = isDangerous(cmd);
				if (!hit) return;
				// 项目豁免(按模式精确匹配)
				for (const a of allowed) {
					if (cmd.includes(a)) return;
				}
				return {
					decision: "block" as const,
					reason:
						`⛔ 危险命令被 JIDE 安全门禁拦截(${label ?? "未分类"})。` +
						`请先在对话中向用户说明这条命令的作用与影响,征得明确同意后再执行;` +
						`用户也可在 .jide/allow-dangerous.json 中为该模式配置豁免。`,
				};
			});
		},
	};
}
