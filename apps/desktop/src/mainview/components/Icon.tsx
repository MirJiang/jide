/** remixicon 统一入口(name 为完整类名,如 "ri-folder-3-line") */

import type { CSSProperties } from "react";

export function Icon({
	name,
	size = 14,
	color,
	className,
	style,
}: {
	name: string;
	size?: number;
	color?: string;
	className?: string;
	style?: CSSProperties;
}) {
	return (
		<i
			className={className ? `${name} ${className}` : name}
			style={{ fontSize: size, color, ...style }}
			aria-hidden
		/>
	);
}
