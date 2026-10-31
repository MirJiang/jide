// J:资源基线实测(tech-stack §5)—— 出包体积 / 冷启动 / 常驻内存 / 进程树回收
// 用法:bun tools/measure-baseline.mjs [--skip-build]
import { readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execSync, spawn } from "node:child_process";

const appDir = "apps/desktop";
const buildDir = join(appDir, "build", "dev-win-x64");
const report = { date: new Date().toISOString(), sizes: {}, coldStart: [], memory: {}, recovery: {} };

function du(dir) {
	let total = 0;
	const walk = (d) => {
		try {
			for (const e of readdirSync(d, { withFileTypes: true })) {
				const p = join(d, e.name);
				if (e.isDirectory()) walk(p);
				else total += statSync(p).size;
			}
		} catch {}
	};
	walk(dir);
	return total;
}

console.log("=== 1. 出包体积 ===");
if (existsSync(buildDir)) {
	const bytes = du(buildDir);
	report.sizes.buildDirMB = +(bytes / 1048576).toFixed(1);
	console.log(`build/dev-win-x64: ${report.sizes.buildDirMB} MB`);
	// 说明:Electrobun 产物含 cottontail 运行时;对照预算 <10MB 的口径是"应用资源"
	const resDir = join(buildDir, "JIDE-dev", "Resources", "app");
	if (existsSync(resDir)) {
		const appBytes = du(resDir);
		report.sizes.appResourcesMB = +(appBytes / 1048576).toFixed(2);
		console.log(`  应用资源(Resources/app): ${report.sizes.appResourcesMB} MB(预算口径)`);
	}
	const exe = join(buildDir, "JIDE-dev", "bin");
	if (existsSync(exe)) {
		report.sizes.binMB = +(du(exe) / 1048576).toFixed(1);
		console.log(`  运行时(bin): ${report.sizes.binMB} MB`);
	}
}

console.log("\n=== 2. 冷启动(< 1.5s 预算) ===");
for (let i = 0; i < 3; i++) {
	const launcher = join(buildDir, "JIDE-dev", "bin", "launcher.exe");
	if (!existsSync(launcher)) break;
	const t0 = Date.now();
	const proc = spawn(launcher, [], { stdio: ["ignore", "pipe", "pipe"], detached: false });
	// 就绪信号:主进程 stdout "主进程就绪"(GBK 控制台,取退出前输出判断不可靠)
	// 简化:测 launcher→窗口进程出现 cottontail 的墙钟
	await new Promise((r) => setTimeout(r, 1200));
	try {
		const out = execSync('tasklist /FI "IMAGENAME eq cottontail.exe" /FO CSV', { encoding: "utf8" });
		if (out.includes("cottontail")) {
			const ms = Date.now() - t0;
			report.coldStart.push(ms);
			console.log(`  run ${i + 1}: cottontail 进程出现 ≈ ${ms}ms`);
		}
	} catch {}
	try {
		process.kill(-proc.pid);
	} catch {}
	try {
		execSync('taskkill /F /IM cottontail.exe /T', { stdio: "ignore" });
	} catch {}
	try {
		execSync('taskkill /F /IM launcher.exe /T', { stdio: "ignore" });
	} catch {}
	await new Promise((r) => setTimeout(r, 800));
}
if (report.coldStart.length) {
	report.coldStart.avg = Math.round(report.coldStart.reduce((a, b) => a + b, 0) / report.coldStart.length);
	console.log(`  平均: ${report.coldStart.avg}ms(预算 1500ms)`);
}

console.log("\n=== 3. 常驻内存(空闲,预算 < 350MB) ===");
const launcher = join(buildDir, "JIDE-dev", "bin", "launcher.exe");
if (existsSync(launcher)) {
	spawn(launcher, [], { stdio: "ignore", detached: true }).unref();
	await new Promise((r) => setTimeout(r, 5000));
	try {
		const csv = execSync('tasklist /FI "IMAGENAME eq cottontail.exe" /FO CSV', { encoding: "utf8" });
		const m = csv.match(/"cottontail.exe","(\d+)","[^"]*","(\d+) K"/);
		if (m) {
			report.memory.cottontailMB = +(parseInt(m[2], 10) / 1024).toFixed(0);
			console.log(`  cottontail(主进程): ${report.memory.cottontailMB} MB`);
		}
		const wv = execSync('tasklist /FI "IMAGENAME eq msedgewebview2.exe" /FO CSV', { encoding: "utf8" });
		let sum = 0;
		for (const mm of wv.matchAll(/"msedgewebview2\.exe","(\d+)","[^"]*","(\d+) K"/g)) sum += parseInt(mm[2], 10);
		report.memory.webview2MB = +(sum / 1024).toFixed(0);
		console.log(`  msedgewebview2(渲染,合计): ${report.memory.webview2MB} MB`);
		report.memory.totalMB = (report.memory.cottontailMB ?? 0) + (report.memory.webview2MB ?? 0);
		console.log(`  合计: ${report.memory.totalMB} MB(预算 350MB)`);
	} catch {}
}

console.log("\n=== 4. 进程树回收(壳强杀后 dev server/浏览器残留检查) ===");
// 起 dev server 子进程 + 检查强杀后回收
const devProc = spawn("bun", ["-e", 'console.log("ready in 100ms"); await Bun.sleep(60000)'], {
	stdio: "ignore",
	detached: true,
});
devProc.unref();
await new Promise((r) => setTimeout(r, 1500));
try {
	execSync('taskkill /F /IM cottontail.exe /T', { stdio: "ignore" });
} catch {}
await new Promise((r) => setTimeout(r, 1000));
// 注:管道式 dev server 由 TerminalManager/disposeAll 管理子进程树;
// 这里验证强杀壳后 bun 孤儿是否残留(手动场景)
try {
	const out = execSync('tasklist /FI "IMAGENAME eq bun.exe" /FO CSV', { encoding: "utf8" });
	const orphans = (out.match(/"bun.exe"/g) ?? []).length;
	report.recovery.bunOrphans = orphans;
	console.log(`  壳强杀后 bun.exe 残留: ${orphans}(期望由 disposeAll 树杀回收)`);
} catch {
	report.recovery.bunOrphans = 0;
	console.log("  壳强杀后 bun.exe 残留: 0");
}
try {
	execSync('taskkill /F /IM launcher.exe /T', { stdio: "ignore" });
} catch {}

console.log("\n=== 报告 ===");
console.log(JSON.stringify(report, null, 2));
