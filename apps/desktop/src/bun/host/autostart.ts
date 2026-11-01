/**
 * autostart — 开机自启(Windows 注册表 HKCU Run 键)
 *
 * 值指向 launcher.exe(app 关闭不杀 daemon,开机自启后 daemon 由 app 首次启动拉起;
 * 纯 daemon 无窗口自启为 P4 远期)。runner 可注入供测试。
 */

import { join } from "node:path";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "JIDE";

export type SpawnSyncFn = (cmd: string[], opts?: any) => { status: number | null };

/** 计算 launcher.exe 路径(appDir = <app>/Resources/app;launcher 在 <app>/bin/) */
export function launcherPath(appDir: string): string {
	return join(appDir, "..", "..", "bin", "launcher.exe");
}

export function applyAutostart(
	enabled: boolean,
	appDir: string,
	spawnSync: SpawnSyncFn = (cmd) => Bun.spawnSync(cmd) as any,
): { ok: boolean; error?: string } {
	const exe = launcherPath(appDir);
	const r = enabled
		? spawnSync(["reg", "add", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ", "/d", `"${exe}"`, "/f"])
		: spawnSync(["reg", "delete", RUN_KEY, "/v", VALUE_NAME, "/f"]);
	const ok = r.status === 0;
	return ok ? { ok: true } : { ok: false, error: `注册表写入失败(exit ${r.status})` };
}
