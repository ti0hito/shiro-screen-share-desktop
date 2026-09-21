import http from "node:http";
import https from "node:https";
import { app, type BrowserWindow, ipcMain, nativeImage } from "electron";
import type { AudioCaptureConfig } from "../types/capture";
import type { AudioCaptureEngine } from "./audioEngine";
import { isAutoUpdateEnabled, setAutoUpdateEnabled } from "./main";
import { scanSources } from "./windowScanner";

type SourceEntry = {
	id: string;
	name: string;
	processName: string;
	sourceType: "window" | "screen";
	thumbnailUrl: string;
};

function resizeThumbnails(sources: SourceEntry[]): SourceEntry[] {
	return sources.map((s) => {
		if (!s.thumbnailUrl) return s;
		try {
			const img = nativeImage.createFromDataURL(s.thumbnailUrl);
			const resized = img.resize({ width: 72, height: 72, quality: "best" });
			return { ...s, thumbnailUrl: resized.toDataURL() };
		} catch {
			return s;
		}
	});
}

export function setupIpcHandlers(
	window: BrowserWindow,
	audioEngine: AudioCaptureEngine,
): void {
	// Settings IPC Handlers
	ipcMain.handle("get-app-settings", () => {
		const loginSettings = app.getLoginItemSettings();
		return {
			openAtLogin: loginSettings.openAtLogin,
			autoUpdate: isAutoUpdateEnabled(),
		};
	});

	ipcMain.handle("set-open-at-login", (_event, enabled: boolean) => {
		app.setLoginItemSettings({
			openAtLogin: enabled,
			openAsHidden: false,
		});
		console.log(`[IPC] Open at login set to: ${enabled}`);
		return app.getLoginItemSettings().openAtLogin;
	});

	ipcMain.handle("set-auto-update", (_event, enabled: boolean) => {
		setAutoUpdateEnabled(enabled);
		console.log(`[IPC] Auto update set to: ${enabled}`);
		return enabled;
	});

	// Get available window & screen sources with PID resolution
	ipcMain.handle("get-available-sources", async () => {
		try {
			return await scanSources();
		} catch (err: any) {
			console.error("[IPC] Error in get-available-sources:", err);
			return [];
		}
	});

	// Start process audio capture
	ipcMain.handle(
		"start-audio-capture",
		async (_event, config: AudioCaptureConfig) => {
			try {
				return await audioEngine.startCapture(config, window);
			} catch (err: any) {
				console.error("[IPC] Error starting audio capture:", err);
				return {
					active: false,
					mode: "disabled",
					samplesPerSecond: 48000,
					channels: 2,
					method: "failed",
					error: err.message,
				};
			}
		},
	);

	// Stop process audio capture
	ipcMain.handle("stop-audio-capture", async () => {
		audioEngine.stopCapture();
	});

	// Fetch LiveKit Token from shiro-web-backend HTTP API
	ipcMain.handle(
		"fetch-livekit-token",
		async (
			_event,
			backendUrl: string,
			roomName: string,
			identity: string,
			userName?: string,
		): Promise<string> => {
			return new Promise((resolve, reject) => {
				try {
					const url = new URL("/api/get-token", backendUrl);
					const postData = JSON.stringify({
						roomName,
						identity,
						name: userName || identity,
					});

					const isHttps = url.protocol === "https:";
					const client = isHttps ? https : http;

					const req = client.request(
						url,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								"Content-Length": Buffer.byteLength(postData),
							},
							timeout: 10000,
						},
						(res) => {
							let data = "";
							res.on("data", (chunk) => (data += chunk));
							res.on("end", () => {
								if (
									res.statusCode &&
									res.statusCode >= 200 &&
									res.statusCode < 300
								) {
									try {
										const parsed = JSON.parse(data);
										if (parsed.token) {
											resolve(parsed.token);
										} else {
											reject(
												new Error('Backend response missing "token" property'),
											);
										}
									} catch (e: any) {
										reject(
											new Error(
												`Failed to parse backend JSON response: ${e.message}`,
											),
										);
									}
								} else {
									reject(
										new Error(
											`Backend HTTP error status ${res.statusCode}: ${data}`,
										),
									);
								}
							});
						},
					);

					req.on("error", (err) => reject(err));
					req.on("timeout", () => {
						req.destroy();
						reject(new Error("Backend request timeout (10s)"));
					});

					req.write(postData);
					req.end();
				} catch (err: any) {
					reject(err);
				}
			});
		},
	);

	// Window Controls IPC
	ipcMain.on("window-minimize", () => {
		if (window && !window.isDestroyed()) window.minimize();
	});

	ipcMain.on("window-maximize", () => {
		if (window && !window.isDestroyed()) {
			if (window.isMaximized()) window.unmaximize();
			else window.maximize();
		}
	});

	ipcMain.on("window-close", () => {
		if (window && !window.isDestroyed()) window.close();
	});

	// Stream Deck bridge: renderer reports its screen-share state
	ipcMain.on("streamdeck-state-report", (_event, isSharing: boolean) => {
		const { broadcastState } = require("./websocketServer");
		broadcastState({ isSharing });
	});

	// Stream Deck bridge: renderer responds to state query
	ipcMain.on("streamdeck-state-response", (_event, isSharing: boolean) => {
		const { respondToStateRequest } = require("./websocketServer");
		respondToStateRequest({ isSharing });
	});

	// Stream Deck bridge: renderer responds to source query
	ipcMain.on(
		"streamdeck-sources-response",
		(
			_event,
			sources: Array<{
				id: string;
				name: string;
				processName: string;
				sourceType: "window" | "screen";
				thumbnailUrl: string;
			}>,
			selectedIndex: number,
		) => {
			const { respondToSourceRequest } = require("./websocketServer");
			respondToSourceRequest(resizeThumbnails(sources), selectedIndex);
		},
	);

	// Stream Deck bridge: renderer reports source list update
	ipcMain.on(
		"streamdeck-sources-report",
		(
			_event,
			sources: Array<{
				id: string;
				name: string;
				processName: string;
				sourceType: "window" | "screen";
				thumbnailUrl: string;
			}>,
			selectedIndex: number,
		) => {
			const { broadcastSources } = require("./websocketServer");
			broadcastSources(resizeThumbnails(sources), selectedIndex);
		},
	);

	// Stream Deck bridge: renderer responds to audio mode query
	ipcMain.on(
		"streamdeck-audio-mode-response",
		(_event, mode: "process" | "system" | "disabled") => {
			const { respondToAudioRequest } = require("./websocketServer");
			respondToAudioRequest(mode);
		},
	);

	// Stream Deck bridge: renderer reports audio mode change
	ipcMain.on(
		"streamdeck-audio-mode-report",
		(_event, mode: "process" | "system" | "disabled") => {
			const { broadcastAudioMode } = require("./websocketServer");
			broadcastAudioMode(mode);
		},
	);
}
