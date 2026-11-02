/**
 * preload:向渲染层注入 window.jide 桥(与 mainview/rpc.ts 的 JideClient 一一对应)
 * 沙箱模式安全面:仅 contextBridge + ipcRenderer,无 Node 能力泄漏。
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("jide", {
	request: (method: string, params: unknown) => ipcRenderer.invoke("jide:request", method, params),
	resync: (lastSeq: number) => ipcRenderer.send("jide:resync", lastSeq),
	onEvent: (cb: (event: unknown) => void) => {
		ipcRenderer.on("jide:event", (_event, event: unknown) => cb(event));
	},
});
