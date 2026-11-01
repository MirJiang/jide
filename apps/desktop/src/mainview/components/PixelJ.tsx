/**
 * PixelJ — agent 头像:Neon J(用户设计稿 icon-design/final/neon-j.svg 的应用内移植)
 *
 * 几何双折线勾勒 J:左上横臂 + 右竖笔左弯钩;方头端点、直角转折;
 * 霓虹绿描边(浅色主题换深绿保证对比)。忙碌:亮斑沿两段笔画流动。
 */

import "./pixel-j.css";

/** 设计稿原始路径(256 viewBox,勿改比例) */
const STROKES = ["M 64 84 V 62 H 176", "M 194 100 V 152 H 134"];

export function PixelJ({
	cell = 4,
	busy = false,
	glow = false,
	title,
}: {
	/** 尺寸档:边长 ≈ 7×cell + 8(px) */
	cell?: number;
	busy?: boolean;
	/** 静止时也带微光(如标题栏 logo) */
	glow?: boolean;
	title?: string;
}) {
	const size = 7 * cell + 8;
	return (
		<span className={`pj ${busy ? "pj-busy" : ""} ${glow ? "pj-glow" : ""}`} title={title} aria-hidden>
			<svg width={size} height={size} viewBox="0 0 256 256" fill="none">
				{STROKES.map((d, i) => (
					<path key={i} d={d} pathLength={100} className="pj-trace" strokeLinecap="square" strokeLinejoin="miter" />
				))}
				{busy &&
					STROKES.map((d, i) => (
						<path
							key={`r${i}`}
							d={d}
							pathLength={100}
							className="pj-run"
							strokeDasharray="22 78"
							strokeLinecap="square"
							style={{ animationDelay: `${i * -450}ms` }}
						/>
					))}
			</svg>
		</span>
	);
}
