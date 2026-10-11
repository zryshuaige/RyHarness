import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, app } from "electron";
import { RyAgentServer } from "@ryagent/server";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

//#region electron/capture.ts
async function runCapture(server, here, createWindow) {
	const dataDir = join(tmpdir(), `ryagent-capture-${Date.now()}`);
	await fetch(`${server.url}/api/agents/ryen`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider: "mock" })
	});
	const coder = await (await fetch(`${server.url}/api/agents`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			templateKey: "coding",
			name: "CodeBot",
			provider: "mock",
			model: "mock"
		})
	})).json();
	const conv = await (await fetch(`${server.url}/api/conversations`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			kind: "group",
			memberAgentIds: ["ryen", coder.agent.id],
			title: "产品三人组"
		})
	})).json();
	await fetch(`${server.url}/api/conversations/${conv.conversation.id}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "大家好，这是界面截图测试" })
	});
	console.log("[capture] seed done");
	const window = await createWindow();
	window.webContents.on("console-message", (_event, _level, message) => {
		console.log("[renderer]", message);
	});
	window.webContents.on("did-fail-load", (_e, code, text) => {
		console.log("[capture] fail-load", code, text);
	});
	await new Promise((resolve) => {
		window.webContents.once("did-finish-load", () => {
			resolve();
		});
	});
	await new Promise((resolve) => {
		return setTimeout(resolve, 3500);
	});
	const image = await window.webContents.capturePage();
	writeFileSync(join(here, "capture.png"), image.toPNG());
	console.log("[capture] saved capture.png");
	await window.close();
	rmSync(dataDir, {
		recursive: true,
		force: true,
		maxRetries: 5
	});
}

//#endregion
//#region electron/main.ts
/**
* Electron 主进程：内嵌启动 @ryagent/server（随机端口），创建窗口。
* 开发模式加载 Vite dev server（RYAGENT_DEV_SERVER_URL），生产模式
* serve 渲染层构建产物（renderer/dist）。
*/
const here = dirname(fileURLToPath(import.meta.url));
async function createWindow(apiBase, show = true) {
	const window = new BrowserWindow({
		width: 1320,
		height: 840,
		minWidth: 1024,
		minHeight: 680,
		show,
		backgroundColor: "#FAF7F2",
		title: "RyAgent",
		icon: join(here, "../assets/icon-256.png"),
		webPreferences: {
			preload: join(here, "preload.mjs"),
			contextIsolation: true,
			nodeIntegration: false,
			...show ? {} : { offscreen: true }
		}
	});
	const devServerUrl = process.env.RYAGENT_DEV_SERVER_URL;
	if (devServerUrl !== void 0 && devServerUrl.length > 0) await window.loadURL(`${devServerUrl}${devServerUrl.includes("?") ? "&" : "?"}api=${encodeURIComponent(apiBase)}`);
	else await window.loadFile(join(here, "../renderer/dist/index.html"), { search: `?api=${encodeURIComponent(apiBase)}` });
	return window;
}
async function main() {
	await app.whenReady();
	const server = await RyAgentServer.create({
		port: Number(process.env.RYAGENT_PORT ?? "0") || 0,
		host: "127.0.0.1",
		dataDir: process.env.RYAGENT_DATA_DIR ?? join(app.getPath("userData"), "ryagent-data")
	});
	await createWindow(server.url);
	if (process.env.RYAGENT_CAPTURE === "1") {
		await runCapture(server, here, () => {
			return createWindow(server.url, false);
		});
		app.exit(0);
		return;
	}
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow(server.url);
	});
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});
	app.on("before-quit", () => {
		server.close();
	});
}
main();

//#endregion
export {  };