export default {
	scripts: {
		install: "bun install",
		start: "hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun dev",
		dev: "hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun dev --watch",
		"hmr": "hutch electrobun prepare && hutch pm exec -- vite --port 5173",
		build: "hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun build",
	},
	packageManager: "bun",
	electrobun: {
		version: "2.0.5",
	},
};
