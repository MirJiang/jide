/**
 * autostart — 开机自启(Windows 注册表 HKCU Run 键)
 *
 * 值指向 app 主程序(由壳经 env JIDE_APP_EXE 注入;app 关闭不杀 daemon,
 * 开机自启后 daemon 由 app 首次启动拉起;纯 daemon 无窗口自启为 P4 远期)。
 * runner 可注入供测试。
 */

import { spawnSync } from "../../runtime";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "JIDE";

export type SpawnSyncFn = (cmd: string[], opts?: any) => { status: number | null };

export function applyAutostart(
	enabled: boolean,
	exePath: string,
	run: SpawnSyncFn = spawnSync,
): { ok: boolean; error?: string } {
	const r = enabled
		? run(["reg", "add", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ", "/d", `"${exePath}"`, "/f"])
		: run(["reg", "delete", RUN_KEY, "/v", VALUE_NAME, "/f"]);
	const ok = r.status === 0;
	return ok ? { ok: true } : { ok: false, error: `注册表写入失败(exit ${r.status})` };
}
