/**
 * CredentialStore — 凭据零留存(§7.4):模型密钥仅存 Windows 凭据库
 *
 * 实现:WinRT PasswordVault(每用户加密存储,系统管理)
 * 经 PowerShell 访问;非 Windows 平台回退环境变量(仅开发)。
 * 任何日志/记忆/回放不含凭据(本模块永不打印值)。
 */

import type { EmitFn } from "./agent-host";

const RESOURCE = "JIDE";

function ps(script: string): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(
		[
			"powershell.exe",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null; " +
				script,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	return (async () => {
		const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		return { code: await proc.exited, out: out.trim(), err: err.trim() };
	})();
}

export class CredentialStore {
	private emit: EmitFn = () => {};

	bindEmitter(emit: EmitFn) {
		this.emit = emit;
	}

	private get vaultExpr() {
		return "(New-Object Windows.Security.Credentials.PasswordVault)";
	}

	/** 写入(凭据库;user 形如 "model-key" / "model-config") */
	async set(user: string, secret: string): Promise<{ ok: boolean; error?: string }> {
		if (process.platform !== "win32") return { ok: false, error: "非 Windows:开发期用环境变量 JIDE_*" };
		// 先删旧(PasswordVault 无 upsert)
		await this.delete(user);
		const r = await ps(
			`$v = ${this.vaultExpr}; ` +
				`$c = New-Object Windows.Security.Credentials.PasswordCredential('${RESOURCE}', '${user}', $args[0]); ` +
				`$v.Add($c); 'OK'`,
			// Bun.spawn 无法传 $args → 改为拼接(值经 Base64 防注入)
		).catch(() => null);
		void r;
		// 用 Base64 传值,避免引号注入
		const b64 = Buffer.from(secret, "utf8").toString("base64");
		const script =
			`$v = ${this.vaultExpr}; ` +
			`$sec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); ` +
			`$c = New-Object Windows.Security.Credentials.PasswordCredential('${RESOURCE}', '${user}', $sec); ` +
			`$v.Add($c); 'OK'`;
		const r2 = await ps(script);
		if (r2.code !== 0 || !r2.out.includes("OK")) return { ok: false, error: "凭据库写入失败" };
		return { ok: true };
	}

	/** 读取(永不打印值) */
	async get(user: string): Promise<string | null> {
		if (process.platform !== "win32") return process.env[`JIDE_${user.replace(/-/g, "_").toUpperCase()}`] ?? null;
		const r = await ps(
			`$v = ${this.vaultExpr}; ` +
				`try { $c = $v.Retrieve('${RESOURCE}', '${user}'); ` +
				`[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($c.Password)) } catch { 'MISSING' }`,
		);
		if (r.code !== 0 || r.out === "MISSING" || !r.out) return null;
		try {
			return Buffer.from(r.out, "base64").toString("utf8");
		} catch {
			return null;
		}
	}

	async delete(user: string): Promise<void> {
		if (process.platform !== "win32") return;
		await ps(
			`$v = ${this.vaultExpr}; ` +
				`try { $c = $v.Retrieve('${RESOURCE}', '${user}'); $v.Remove($c) } catch { }`,
		);
	}

	/** 列出 user 名(不含值) */
	async listUsers(): Promise<string[]> {
		if (process.platform !== "win32") return [];
		const r = await ps(`$v = ${this.vaultExpr}; try { ($v.RetrieveAll() | Where-Object { $_.Resource -eq '${RESOURCE}' } | ForEach-Object { $_.UserName }) -join '\n' } catch { '' }`);
		return r.out.split(/\r?\n/).filter(Boolean);
	}
}
