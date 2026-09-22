import http from "node:http";
import https from "node:https";
import { app, type BrowserWindow, ipcMain, nativeImage } from "electron";
import type { AudioCaptureConfig } from "../types/capture";
import type { ApiRequestOptions, ApiRequestResult } from "../types/ipc";
import type { AudioCaptureEngine } from "./audioEngine";
import {
	isAutoUpdateEnabled,
	setAutoUpdateEnabled,
	installUpdateNow,
	checkForUpdatesNow,
} from "./main";
import { scanSources } from "./windowScanner";
import {
	broadcastState,
	respondToStateRequest,
	broadcastSources,
	respondToSourceRequest,
	broadcastAudioMode,
	respondToAudioRequest,
} from "./websocketServer";

// SSE bridge: guarda a requisição HTTP ativa para poder cancelar e reconectar
let activeSseRequest: http.ClientRequest | null = null;
let currentSseUserToken: string | null = null;
let sseReconnectTimer: NodeJS.Timeout | null = null;


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

/**
 * Faz uma requisição HTTP/HTTPS injetando a API Key do .env.
 * A chave NUNCA é exposta ao renderer process.
 */
function makeSecureRequest(
	baseUrl: string,
	apiKey: string,
	opts: ApiRequestOptions,
	retries = 1,
): Promise<ApiRequestResult> {
	return new Promise((resolve) => {
		try {
			const url = new URL(opts.endpoint, baseUrl);
			const method = opts.method ?? "GET";
			const postData = opts.body ? JSON.stringify(opts.body) : undefined;

			const headers: Record<string, string | number> = {
				"Content-Type": "application/json",
				"X-API-Key": apiKey,
				"Connection": "close",
			};

			if (opts.token) {
				headers["Authorization"] = `Bearer ${opts.token}`;
			}

			if (postData) {
				headers["Content-Length"] = Buffer.byteLength(postData);
			}

			const isHttps = url.protocol === "https:";
			const client = isHttps ? https : http;

			const req = client.request(
				url,
				{ method, headers, timeout: 15000, agent: false },
				(res) => {
					let data = "";
					res.on("data", (chunk) => (data += chunk));
					res.on("end", () => {
						const status = res.statusCode ?? 0;
						try {
							resolve({ ok: status >= 200 && status < 300, status, data: JSON.parse(data) });
						} catch {
							resolve({ ok: status >= 200 && status < 300, status, data });
						}
					});
				},
			);

			req.on("error", (err) => {
				if (retries > 0 && (err.message.includes("hang up") || err.message.includes("ECONNRESET"))) {
					console.warn(`[IPC] api-request (${opts.endpoint}) tentando novamente devido a socket hang up...`);
					return resolve(makeSecureRequest(baseUrl, apiKey, opts, retries - 1));
				}
				console.error("[IPC] api-request error:", err.message);
				resolve({ ok: false, status: 0, data: { error: err.message } });
			});

			req.on("timeout", () => {
				req.destroy();
				resolve({ ok: false, status: 0, data: { error: "Request timeout (15s)" } });
			});

			if (postData) req.write(postData);
			req.end();
		} catch (err: any) {
			resolve({ ok: false, status: 0, data: { error: err.message } });
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

	ipcMain.handle("install-update", () => {
		installUpdateNow();
	});

	ipcMain.handle("check-for-updates", async () => {
		return await checkForUpdatesNow();
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

const DEFAULT_API_URL = "https://shiro-screenshare-desktop-api.vercel.app";
const DEFAULT_API_KEY = "c7c14f354ac71f78695a5529064e681d8588224515366760ed76815618d9afbb";

	/**
	 * Rota de API segura: o renderer envia endpoint + body + token JWT do usuário.
	 * O processo main injeta a X-API-Key do .env ou padrão — ela NUNCA vai para o renderer.
	 */
	ipcMain.handle(
		"api-request",
		async (_event, opts: ApiRequestOptions): Promise<ApiRequestResult> => {
			const baseUrl = process.env.SHIRO_API_URL || DEFAULT_API_URL;
			const apiKey = process.env.SHIRO_API_KEY || DEFAULT_API_KEY;

			console.log(`[IPC] api-request → ${opts.method ?? "GET"} ${opts.endpoint}`);
			return makeSecureRequest(baseUrl, apiKey, opts);
		},
	);

	// Get resources path
	ipcMain.handle("get-resources-path", () => {
		return app.isPackaged ? process.resourcesPath : "";
	});

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
		broadcastState({ isSharing });
	});

	// Stream Deck bridge: renderer responds to state query
	ipcMain.on("streamdeck-state-response", (_event, isSharing: boolean) => {
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
			broadcastSources(resizeThumbnails(sources), selectedIndex);
		},
	);

	// Stream Deck bridge: renderer responds to audio mode query
	ipcMain.on(
		"streamdeck-audio-mode-response",
		(_event, mode: "process" | "system" | "disabled") => {
			respondToAudioRequest(mode);
		},
	);

	// Stream Deck bridge: renderer reports audio mode change
	ipcMain.on(
		"streamdeck-audio-mode-report",
		(_event, mode: "process" | "system" | "disabled") => {
			broadcastAudioMode(mode);
		},
	);


	// ── SSE Bridge: o renderer pede ao main para abrir conexão SSE ──
	// A API Key é injetada aqui (processo main) — nunca exposta ao renderer
	function connectSse(userToken: string): void {
		if (activeSseRequest) {
			try {
				activeSseRequest.destroy();
			} catch {}
			activeSseRequest = null;
		}

		if (sseReconnectTimer) {
			clearTimeout(sseReconnectTimer);
			sseReconnectTimer = null;
		}

		const baseUrl = process.env.SHIRO_API_URL || DEFAULT_API_URL;
		const apiKey = process.env.SHIRO_API_KEY || DEFAULT_API_KEY;

		const encodedToken = encodeURIComponent(userToken);
		let sseUrl: URL;
		try {
			sseUrl = new URL(`/api/signal/sse?token=${encodedToken}`, baseUrl);
		} catch (err) {
			console.error("[SSE] URL inválida:", err);
			return;
		}

		const isHttps = sseUrl.protocol === "https:";
		const client = isHttps ? https : http;

		console.log(`[SSE] Abrindo conexão para ${sseUrl.origin}/api/signal/sse`);

		const scheduleReconnect = () => {
			if (!currentSseUserToken || currentSseUserToken !== userToken || window.isDestroyed()) return;
			if (sseReconnectTimer) return;
			console.log("[SSE] Reconexão agendada em 1.5s...");
			sseReconnectTimer = setTimeout(() => {
				sseReconnectTimer = null;
				if (currentSseUserToken === userToken && !window.isDestroyed()) {
					console.log("[SSE] Tentando reconectar stream SSE...");
					connectSse(userToken);
				}
			}, 1500);
		};

		const req = client.request(sseUrl, {
			method: "GET",
			headers: {
				"Accept": "text/event-stream",
				"Cache-Control": "no-cache",
				"X-API-Key": apiKey,
			},
		}, (res) => {
			if (!res.statusCode || res.statusCode >= 300) {
				console.error(`[SSE] Erro HTTP ${res.statusCode}`);
				if (!window.isDestroyed()) {
					window.webContents.send("sse-error", `HTTP ${res.statusCode}`);
				}
				scheduleReconnect();
				return;
			}

			console.log("[SSE] Conexão SSE estabelecida com sucesso.");
			let buffer = "";

			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				buffer += chunk;
				// Suporte a delimitadores \r\n\r\n ou \n\n
				const parts = buffer.split(/\r?\n\r?\n/);
				buffer = parts.pop() ?? "";

				for (const rawEvent of parts) {
					if (!rawEvent.trim()) continue;
					const lines = rawEvent.split(/\r?\n/);
					let eventType = "message";
					let dataStr = "";

					for (const line of lines) {
						if (line.startsWith("event:")) {
							eventType = line.slice(6).trim();
						} else if (line.startsWith("data:")) {
							dataStr = line.slice(5).trim();
						}
					}

					if (dataStr && eventType !== "message") {
						try {
							const data = JSON.parse(dataStr);
							console.log(`[SSE Main] Sinal recebido: ${eventType}`);
							if (!window.isDestroyed()) {
								window.webContents.send("sse-signal", eventType, data);
							}
						} catch (err) {
							console.warn("[SSE Main] Erro ao parsear JSON:", err);
						}
					}
				}
			});

			res.on("end", () => {
				console.log("[SSE] Conexão finalizada pelo servidor/timeout.");
				if (!window.isDestroyed()) {
					window.webContents.send("sse-closed");
				}
				scheduleReconnect();
			});

			res.on("error", (err) => {
				console.error("[SSE] Erro na stream de resposta:", err.message);
				scheduleReconnect();
			});
		});

		req.on("error", (err) => {
			console.error("[SSE] Erro na requisição:", err.message);
			if (!window.isDestroyed()) {
				window.webContents.send("sse-error", err.message);
			}
			scheduleReconnect();
		});

		req.end();
		activeSseRequest = req;
	}

	ipcMain.on("sse-start", (_event, userToken: string) => {
		currentSseUserToken = userToken;
		connectSse(userToken);
	});

	ipcMain.on("sse-stop", () => {
		currentSseUserToken = null;
		if (sseReconnectTimer) {
			clearTimeout(sseReconnectTimer);
			sseReconnectTimer = null;
		}
		if (activeSseRequest) {
			try {
				activeSseRequest.destroy();
			} catch {}
			activeSseRequest = null;
			console.log("[SSE] Conexão encerrada pelo renderer.");
		}
	});
}

