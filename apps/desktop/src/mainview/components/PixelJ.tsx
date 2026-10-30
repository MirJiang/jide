/**
 * PixelJ — 内置 agent 头像:像素风大写 J
 *
 *  - 静止:品牌蓝双色调像素块
 *  - 忙碌(agent 运行中/任务中):像素格沿字形轮廓依次明暗变化(追光延迟),
 *    形成"旋转"的视觉节律 —— 不用变换,纯 brightness 波
 */

import "./pixel-j.css";

/** 6×8 像素 J 字形(1 = 点亮) */
const GLYPH: number[][] = [
	[1, 1, 1, 1, 1, 0],
	[0, 0, 0, 1, 1, 0],
	[0, 0, 0, 1, 1, 0],
	[0, 0, 0, 1, 1, 0],
	[0, 0, 0, 1, 1, 0],
	[1, 0, 0, 1, 1, 0],
	[1, 1, 0, 1, 1, 0],
	[0, 1, 1, 1, 1, 0],
];

/**
 * 追光顺序:沿字形外轮廓一圈(顺时针),内部格随列走 —— 产生旋转感。
 * 计算每格的相位(0..1):按 (x, y) 在轮廓路径中的位置。
 */
function phaseFor(x: number, y: number, w: number, h: number): number {
	// 顶部行:左→右;右列:下;底部行:右→左;左列:上 —— 周长归一化
	const top = x / w;
	const right = y / h;
	const bottom = 1 - x / w;
	const left = 1 - y / h;
	// 取该格在"顺时针扫描"下的最大相位贡献(近似):外圈格主导
	const isEdge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
	if (isEdge) {
		// 顺时针参数化:top(0-0.25) right(0.25-0.5) bottom(0.5-0.75) left(0.75-1)
		if (y === 0) return top * 0.25;
		if (x === w - 1) return 0.25 + right * 0.25;
		if (y === h - 1) return 0.5 + bottom * 0.25;
		return 0.75 + left * 0.25;
	}
	// 内部格:按列给相位(跟右侧竖笔走,视觉像整字扫过)
	return (x / w) * 0.5 + 0.1;
}

export function PixelJ({
	cell = 4,
	busy = false,
	glow = false,
	title,
}: {
	/** 像素格边长(px) */
	cell?: number;
	busy?: boolean;
	/** 静止时也带微光(如标题栏 logo) */
	glow?: boolean;
	title?: string;
}) {
	const h = GLYPH.length;
	const w = GLYPH[0].length;
	const cells: React.ReactNode[] = [];
	let k = 0;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (!GLYPH[y][x]) continue;
			const phase = phaseFor(x, y, w, h);
			cells.push(
				<span
					key={k++}
					className="pj-cell"
					style={
						{
							width: cell,
							height: cell,
							"--pj-delay": `${(-phase * 900).toFixed(0)}ms`,
						} as React.CSSProperties
					}
				/>,
			);
		}
	}
	return (
		<span
			className={`pj ${busy ? "pj-busy" : ""} ${glow ? "pj-glow" : ""}`}
			title={title}
			style={{ gridTemplateColumns: `repeat(${w}, ${cell}px)`, gridAutoRows: `${cell}px` } as React.CSSProperties}
			aria-hidden
		>
			{cells}
		</span>
	);
}
