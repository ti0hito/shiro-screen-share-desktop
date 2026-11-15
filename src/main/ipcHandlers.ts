import http from "node:http";
import https from "node:https";
import { app, BrowserWindow, ipcMain, nativeImage, shell } from "electron";
import type { AudioCaptureConfig } from "../types/capture";
import type { ApiRequestOptions, ApiRequestResult, DiscordPresenceState } from "../types/ipc";
import type { AudioCaptureEngine } from "./audioEngine";
import {
	isAutoUpdateEnabled,
	setAutoUpdateEnabled,
	installUpdateNow,
	checkForUpdatesNow,
	downloadUpdateNow,
	isDiscordRpcEnabled,
	setDiscordRpcEnabled,
	updateDiscordPresence,
} from "./main";
import { scanSources } from "./windowScanner";
import {
	broadcastState,
	respondToStateRequest,
	broadcastSources,
	respondToSourceRequest,
	broadcastAudioMode,
	respondToAudioRequest,
	hasStreamDeckClients,
} from "./websocketServer";

// Definidos pelo esbuild em scripts/build-main.mjs (SHIRO_API_KEY embaralhada)
declare const __SHIRO_API_KEY_DATA__: string;
declare const __SHIRO_API_KEY_SALT__: string;

// SSE bridge: guarda a requisição HTTP ativa para poder cancelar e reconectar
let activeSseRequest: http.ClientRequest | null = null;
let currentSseUserToken: string | null = null;
let sseReconnectTimer: NodeJS.Timeout | null = null;
// Watchdog: o servidor manda ": ping" a cada 15s. Sem nenhum dado por 45s, a conexão está
// morta mesmo sem erro/fim (socket meio-aberto após queda de rede ou suspensão do PC).
// Sem SSE não há sinalização P2P e o vídeo não consegue voltar — por isso reconecta.
const SSE_IDLE_TIMEOUT_MS = 45_000;
let sseWatchdogTimer: NodeJS.Timeout | null = null;

function clearSseWatchdog(): void {
	if (sseWatchdogTimer) {
		clearInterval(sseWatchdogTimer);
		sseWatchdogTimer = null;
	}
}

// Agents com keep-alive: reaproveitam a conexão TLS entre requisições em vez de
// abrir um handshake novo a cada chamada. Sockets ociosos são fechados após 20s.
const keepAliveOptions = { keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 6, maxFreeSockets: 2, timeout: 20_000 };
const httpsAgent = new https.Agent(keepAliveOptions);
const httpAgent = new http.Agent(keepAliveOptions);

const SAFE_IMAGE_MAX_BYTES = 8 * 1024 * 1024; // 8 MB máx
const SAFE_IMAGE_MAX_DIMENSION = 4096; // 4096px máx por eixo
const SAFE_IMAGE_MAX_PIXELS = 4096 * 3072; // ~12.5 MP máx (proteção contra decompression bomb)
const safeImageProbeCache = new Map<string, { safe: boolean; width?: number; height?: number; reason?: string }>();

function isBlockedHost(hostname: string): boolean {
	const h = hostname.toLowerCase().trim();
	if (
		!h ||
		h === "localhost" ||
		h.endsWith(".local") ||
		h.endsWith(".internal") ||
		h === "[::1]" ||
		h.startsWith("[fc") ||
		h.startsWith("[fd") ||
		h.startsWith("[fe80:")
	) {
		return true;
	}
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
		const parts = h.split(".").map((n) => parseInt(n, 10));
		if (
			parts[0] === 0 ||
			parts[0] === 10 ||
			parts[0] === 127 ||
			(parts[0] === 169 && parts[1] === 254) ||
			(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
			(parts[0] === 192 && parts[1] === 168) ||
			parts[0] >= 224
		) {
			return true;
		}
	}
	return false;
}

function parseImageHeaderDimensions(buf: Buffer): { width: number; height: number } | null {
	if (buf.length < 24) return null;

	// PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR
	if (
		buf[0] === 0x89 &&
		buf[1] === 0x50 &&
		buf[2] === 0x4e &&
		buf[3] === 0x47 &&
		buf[4] === 0x0d &&
		buf[5] === 0x0a &&
		buf[6] === 0x1a &&
		buf[7] === 0x0a
	) {
		const width = buf.readUInt32BE(16);
		const height = buf.readUInt32BE(20);
		return { width, height };
	}

	// GIF: GIF87a ou GIF89a
	if (
		buf[0] === 0x47 &&
		buf[1] === 0x49 &&
		buf[2] === 0x46 &&
		buf[3] === 0x38 &&
		(buf[4] === 0x37 || buf[4] === 0x39) &&
		buf[5] === 0x61
	) {
		const width = buf.readUInt16LE(6);
		const height = buf.readUInt16LE(8);
		return { width, height };
	}

	// WebP: RIFF....WEBP
	if (
		buf.length >= 30 &&
		buf.toString("ascii", 0, 4) === "RIFF" &&
		buf.toString("ascii", 8, 12) === "WEBP"
	) {
		const chunkType = buf.toString("ascii", 12, 16);
		if (chunkType === "VP8 " && buf.length >= 30) {
			const width = buf.readUInt16LE(26) & 0x3fff;
			const height = buf.readUInt16LE(28) & 0x3fff;
			return { width, height };
		}
		if (chunkType === "VP8L" && buf.length >= 25) {
			const b0 = buf[21];
			const b1 = buf[22];
			const b2 = buf[23];
			const b3 = buf[24];
			const width = 1 + (((b1 & 0x3f) << 8) | b0);
			const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
			return { width, height };
		}
		if (chunkType === "VP8X" && buf.length >= 30) {
			const width = 1 + buf.readUIntLE(24, 3);
			const height = 1 + buf.readUIntLE(27, 3);
			return { width, height };
		}
	}

	// JPEG: FF D8 ... SOF markers
	if (buf[0] === 0xff && buf[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < buf.length) {
			if (buf[offset] !== 0xff) {
				offset++;
				continue;
			}
			const marker = buf[offset + 1];
			if (marker === 0xff) {
				offset++;
				continue;
			}
			// SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
			if (
				(marker >= 0xc0 && marker <= 0xc3) ||
				(marker >= 0xc5 && marker <= 0xc7) ||
				(marker >= 0xc9 && marker <= 0xcb) ||
				(marker >= 0xcd && marker <= 0xcf)
			) {
				const height = buf.readUInt16BE(offset + 5);
				const width = buf.readUInt16BE(offset + 7);
				return { width, height };
			}
			if (marker === 0xd9 || marker === 0xda) break;
			const segLen = buf.readUInt16BE(offset + 2);
			if (segLen < 2) break;
			offset += 2 + segLen;
		}
	}

	return null;
}

function probeSafeImageUrl(
	rawUrl: string,
	redirectsLeft = 3,
): Promise<{ safe: boolean; width?: number; height?: number; reason?: string }> {
	return new Promise((resolve) => {
		try {
			if (!rawUrl || typeof rawUrl !== "string" || rawUrl.length > 1000) {
				return resolve({ safe: false, reason: "URL inválida" });
			}
			const url = new URL(rawUrl);
			if (url.protocol !== "https:" || url.username || url.password || isBlockedHost(url.hostname)) {
				return resolve({ safe: false, reason: "Host ou protocolo não permitido" });
			}
			const lowerPath = url.pathname.toLowerCase();
			if (/\.(svg|svgz|ico|bmp|tif|tiff|html|htm|php|exe|zip|rar|pdf|xml)$/i.test(lowerPath)) {
				return resolve({ safe: false, reason: "Formato de arquivo bloqueado" });
			}

			let settled = false;
			const finish = (result: { safe: boolean; width?: number; height?: number; reason?: string }) => {
				if (settled) return;
				settled = true;
				resolve(result);
			};

			const req = https.request(
				url,
				{
					method: "GET",
					timeout: 4500,
					headers: {
						"User-Agent": "ShiroScreenShare-ImageGuard/1.0",
						Accept: "image/webp,image/png,image/jpeg,image/gif,image/avif;q=0.9",
						Range: "bytes=0-65535",
					},
				},
				(res) => {
					const status = res.statusCode ?? 0;
					if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
						res.resume();
						if (redirectsLeft <= 0) {
							return finish({ safe: false, reason: "Muitos redirecionamentos" });
						}
						try {
							const nextUrl = new URL(res.headers.location, url).toString();
							return void probeSafeImageUrl(nextUrl, redirectsLeft - 1).then(finish);
						} catch {
							return finish({ safe: false, reason: "Redirecionamento inválido" });
						}
					}

					if (status !== 200 && status !== 206) {
						res.resume();
						return finish({ safe: false, reason: `HTTP ${status}` });
					}

					const contentType = String(res.headers["content-type"] || "").toLowerCase().split(";")[0].trim();
					const allowedTypes = new Set([
						"image/jpeg",
						"image/jpg",
						"image/png",
						"image/gif",
						"image/webp",
						"image/avif",
					]);
					if (!allowedTypes.has(contentType)) {
						res.destroy();
						return finish({ safe: false, reason: `Content-Type não permitido: ${contentType}` });
					}

					const contentLength = parseInt(String(res.headers["content-length"] || "0"), 10);
					if (Number.isFinite(contentLength) && contentLength > SAFE_IMAGE_MAX_BYTES) {
						res.destroy();
						return finish({ safe: false, reason: "Imagem excede 8 MB" });
					}

					const contentRange = String(res.headers["content-range"] || "");
					const rangeMatch = contentRange.match(/\/(\d+)$/);
					if (rangeMatch) {
						const totalSize = parseInt(rangeMatch[1], 10);
						if (Number.isFinite(totalSize) && totalSize > SAFE_IMAGE_MAX_BYTES) {
							res.destroy();
							return finish({ safe: false, reason: "Imagem excede 8 MB" });
						}
					}

					const chunks: Buffer[] = [];
					let bytesRead = 0;

					res.on("data", (chunk: Buffer) => {
						chunks.push(chunk);
						bytesRead += chunk.length;
						if (bytesRead >= 65536) {
							res.destroy();
						}
					});

					const evaluateHeader = () => {
						const headerBuf = Buffer.concat(chunks);
						if (headerBuf.length < 16) {
							return finish({ safe: false, reason: "Cabeçalho de imagem incompleto" });
						}
						const dims = parseImageHeaderDimensions(headerBuf);
						if (dims) {
							if (
								dims.width <= 0 ||
								dims.height <= 0 ||
								dims.width > SAFE_IMAGE_MAX_DIMENSION ||
								dims.height > SAFE_IMAGE_MAX_DIMENSION ||
								dims.width * dims.height > SAFE_IMAGE_MAX_PIXELS
							) {
								return finish({
									safe: false,
									reason: `Dimensões inseguras (${dims.width}x${dims.height})`,
								});
							}
							return finish({ safe: true, width: dims.width, height: dims.height });
						}
						// Para AVIF (ISOBMFF) onde dimensões podem estar em box ispe e o tamanho total foi validado
						if (contentType === "image/avif" && headerBuf.includes(Buffer.from("ftyp"))) {
							return finish({ safe: true });
						}
						return finish({ safe: false, reason: "Assinatura binária da imagem inválida" });
					};

					res.on("end", evaluateHeader);
					res.on("close", evaluateHeader);
					res.on("error", () => finish({ safe: false, reason: "Erro na leitura da imagem" }));
				},
			);

			req.on("timeout", () => {
				req.destroy();
				finish({ safe: false, reason: "Timeout ao verificar imagem" });
			});
			req.on("error", () => {
				finish({ safe: false, reason: "Erro de rede ao verificar imagem" });
			});
			req.end();
		} catch {
			resolve({ safe: false, reason: "URL malformada" });
		}
	});
}


type SourceEntry = {
	id: string;
	name: string;
	processName: string;
	sourceType: "window" | "screen" | "camera";
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
				// Versão do app: diagnóstico e versão mínima exigida pela API
				"X-App-Version": app.getVersion(),
			};

			if (opts.token) {
				headers["Authorization"] = `Bearer ${opts.token}`;
			}

			if (postData) {
				headers["Content-Length"] = Buffer.byteLength(postData);
			}

			const isHttps = url.protocol === "https:";
			const client = isHttps ? https : http;
			const agent = isHttps ? httpsAgent : httpAgent;

			const req = client.request(
				url,
				{ method, headers, timeout: 15000, agent },
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
			discordRpc: isDiscordRpcEnabled(),
			version: app.getVersion(),
			isDev: !app.isPackaged,
			platform: process.platform,
			// Wayland: captura de tela só pelo portal do sistema (seletor nativo a cada captura)
			isWayland:
				process.platform === "linux" &&
				(process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY),
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

	ipcMain.handle("set-discord-rpc-enabled", (_event, enabled: boolean) => {
		setDiscordRpcEnabled(Boolean(enabled));
		console.log(`[IPC] Discord RPC set to: ${Boolean(enabled)}`);
		return Boolean(enabled);
	});

	ipcMain.on("update-discord-presence", (_event, state: DiscordPresenceState) => {
		if (state && typeof state.mode === "string") {
			updateDiscordPresence(state);
		}
	});

	ipcMain.handle("install-update", () => {
		installUpdateNow();
	});

	ipcMain.handle("check-for-updates", async () => {
		return await checkForUpdatesNow();
	});

	ipcMain.handle("download-update", async () => {
		return await downloadUpdateNow();
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

const DEFAULT_API_URL = "https://share.shirobot.xyz";

	ipcMain.handle("get-api-url", () => {
		return process.env.SHIRO_API_URL || DEFAULT_API_URL;
	});

	/**
	 * Chave da API: .env (desenvolvimento) ou a embutida no build por scripts/build-main.mjs.
	 * Não fica no código-fonte (repositório público). Embaralhada no binário, não criptografada:
	 * a proteção real da API é o JWT.
	 */
	const DEFAULT_API_KEY = (() => {
		try {
			const data = Buffer.from(__SHIRO_API_KEY_DATA__, "base64");
			const salt = Buffer.from(__SHIRO_API_KEY_SALT__, "base64");
			return Buffer.from(data.map((byte, i) => byte ^ salt[i % salt.length])).toString("utf8");
		} catch {
			return "";
		}
	})();

	/**
	 * Rota de API segura: o renderer envia endpoint + body + token JWT do usuário.
	 * O processo main injeta a X-API-Key do .env ou padrão — ela NUNCA vai para o renderer.
	 */
	ipcMain.handle(
		"api-request",
		async (_event, opts: ApiRequestOptions): Promise<ApiRequestResult> => {
			const baseUrl = process.env.SHIRO_API_URL || DEFAULT_API_URL;
			const apiKey = process.env.SHIRO_API_KEY || DEFAULT_API_KEY;

			console.log(`[IPC] api-request -> ${opts.method ?? "GET"} ${opts.endpoint}`);
			return makeSecureRequest(baseUrl, apiKey, opts);
		},
	);

	// Abre links externos no navegador padrão (apenas domínios permitidos)
	
	// Autenticação / Vínculo com Discord abrindo diretamente no navegador padrão do sistema (onde o usuário já está logado)
	ipcMain.handle("auth:discord", async (_event, { action, token }: { action: "login" | "link"; token?: string }) => {
		return new Promise((resolve) => {
			let completed = false;
			let timeoutTimer: NodeJS.Timeout | null = null;

			const server = http.createServer((req, res) => {
				const reqUrl = new URL(req.url || "", `http://${req.headers.host || "127.0.0.1"}`);
				if (reqUrl.pathname === "/callback") {
					const tokenParam = reqUrl.searchParams.get("token");
					const userParam = reqUrl.searchParams.get("user");
					const errorParam = reqUrl.searchParams.get("error");

					res.writeHead(200, {
						"Content-Type": "text/html; charset=utf-8",
						"Access-Control-Allow-Origin": "*",
					});
					res.end(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Shiro Screen Share — Conectado</title>
  <style>
    body {
      background: #09090b;
      color: #f4f4f5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      text-align: center;
    }
    .card {
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 12px;
      padding: 32px 28px;
      max-width: 360px;
      box-shadow: 0 16px 40px rgba(0,0,0,0.6);
    }
    h2 { color: #a855f7; margin: 0 0 8px 0; font-size: 18px; }
    p { color: #a1a1aa; font-size: 13px; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h2>✨ Conectado com sucesso!</h2>
    <p>Você já pode fechar esta aba e voltar para o aplicativo Shiro Screen Share.</p>
  </div>
  <script>setTimeout(function() { window.close(); }, 1200);</script>
</body>
</html>`);

					if (!completed) {
						completed = true;
						if (timeoutTimer) clearTimeout(timeoutTimer);
						server.close();

						if (window && !window.isDestroyed()) {
							window.show();
							window.focus();
						}

						if (errorParam) {
							resolve({ ok: false, error: errorParam });
						} else if (userParam) {
							try {
								const user = JSON.parse(userParam);
								resolve({ ok: true, token: tokenParam || undefined, user });
							} catch {
								resolve({ ok: true, token: tokenParam || undefined });
							}
						} else {
							resolve({ ok: true, token: tokenParam || undefined });
						}
					}
				} else {
					res.writeHead(404);
					res.end();
				}
			});

			server.listen(0, "127.0.0.1", () => {
				const addr = server.address() as any;
				const port = addr?.port;
				if (!port) {
					resolve({ ok: false, error: "Falha ao iniciar servidor local de autenticação." });
					return;
				}

				const baseUrl = process.env.SHIRO_API_URL || DEFAULT_API_URL;
				const authUrl = `${baseUrl}/api/auth/discord/authorize?action=${action || "login"}${token ? `&token=${encodeURIComponent(token)}` : ""}&platform=desktop&port=${port}`;

				shell.openExternal(authUrl);

				timeoutTimer = setTimeout(() => {
					if (!completed) {
						completed = true;
						try { server.close(); } catch {}
						resolve({ ok: false, error: "Tempo limite para autenticação excedido." });
					}
				}, 180000); // 3 minutos de timeout
			});

			server.on("error", (err) => {
				if (!completed) {
					completed = true;
					if (timeoutTimer) clearTimeout(timeoutTimer);
					resolve({ ok: false, error: `Erro no servidor de autenticação: ${err.message}` });
				}
			});
		});
	});

	ipcMain.handle("open-external", async (_event, rawUrl: string) => {
		try {
			const url = new URL(rawUrl);
			const allowed = url.protocol === "https:" && (url.hostname === "shirobot.xyz" || url.hostname.endsWith(".shirobot.xyz"));
			if (!allowed) {
				console.warn(`[IPC] open-external bloqueado: ${rawUrl}`);
				return false;
			}
			await shell.openExternal(url.toString());
			return true;
		} catch (err: any) {
			console.error("[IPC] open-external error:", err.message);
			return false;
		}
	});

	ipcMain.handle("probe-safe-image", async (_event, rawUrl: string) => {
		const key = String(rawUrl || "").trim();
		if (safeImageProbeCache.has(key)) {
			return safeImageProbeCache.get(key)!;
		}
		const result = await probeSafeImageUrl(key);
		if (safeImageProbeCache.size >= 300) {
			const firstKey = safeImageProbeCache.keys().next().value;
			if (firstKey) safeImageProbeCache.delete(firstKey);
		}
		safeImageProbeCache.set(key, result);
		if (!result.safe) {
			console.warn(`[IPC] Imagem bloqueada pelo ImageGuard (${result.reason}): ${key}`);
		}
		return result;
	});

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

	ipcMain.on("window-focus", () => {
		if (window && !window.isDestroyed()) {
			if (window.isMinimized()) window.restore();
			window.show();
			window.focus();
		}
	});

	// Stream Deck bridge: renderer reports its screen-share state
	ipcMain.on("streamdeck-state-report", (_event, isSharing: boolean) => {
		broadcastState({ isSharing });
		respondToStateRequest({ isSharing });
	});

	// Stream Deck bridge: renderer responds to state query
	ipcMain.on("streamdeck-state-response", (_event, isSharing: boolean) => {
		broadcastState({ isSharing });
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
				sourceType: "window" | "screen" | "camera";
				thumbnailUrl: string;
			}>,
			selectedIndex: number,
		) => {
			if (!hasStreamDeckClients()) return;
			const resized = resizeThumbnails(sources);
			broadcastSources(resized, selectedIndex);
			respondToSourceRequest(resized, selectedIndex);
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
				sourceType: "window" | "screen" | "camera";
				thumbnailUrl: string;
			}>,
			selectedIndex: number,
		) => {
			if (!hasStreamDeckClients()) return;
			const resized = resizeThumbnails(sources);
			broadcastSources(resized, selectedIndex);
			respondToSourceRequest(resized, selectedIndex);
		},
	);

	// Stream Deck bridge: renderer responds to audio mode query
	ipcMain.on(
		"streamdeck-audio-mode-response",
		(_event, mode: "process" | "system" | "disabled") => {
			broadcastAudioMode(mode);
			respondToAudioRequest(mode);
		},
	);

	// Stream Deck bridge: renderer reports audio mode change
	ipcMain.on(
		"streamdeck-audio-mode-report",
		(_event, mode: "process" | "system" | "disabled") => {
			broadcastAudioMode(mode);
			respondToAudioRequest(mode);
		},
	);


	// ── SSE Bridge: o renderer pede ao main para abrir conexão SSE ──
	// A API Key é injetada aqui (processo main) — nunca exposta ao renderer
	function connectSse(userToken: string): void {
		if (activeSseRequest) {
			try {
				const reqToDestroy = activeSseRequest;
				activeSseRequest = null;
				reqToDestroy.destroy();
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
			console.error("[SSE] URL invalida:", err);
			return;
		}

		const isHttps = sseUrl.protocol === "https:";
		const client = isHttps ? https : http;

		console.log(`[SSE] Abrindo conexao para ${sseUrl.origin}/api/signal/sse`);

		const scheduleReconnect = () => {
			if (!currentSseUserToken || currentSseUserToken !== userToken || window.isDestroyed()) return;
			if (sseReconnectTimer) return;
			console.log("[SSE] Reconexao agendada em 1.5s...");
			sseReconnectTimer = setTimeout(() => {
				sseReconnectTimer = null;
				if (currentSseUserToken === userToken && !window.isDestroyed()) {
					console.log("[SSE] Tentando reconectar stream SSE...");
					connectSse(userToken);
				}
			}, 1500);
		};

		let lastDataAt = Date.now();
		clearSseWatchdog();
		sseWatchdogTimer = setInterval(() => {
			if (Date.now() - lastDataAt < SSE_IDLE_TIMEOUT_MS) return;
			console.warn(`[SSE] Sem dados ha ${Math.round((Date.now() - lastDataAt) / 1000)}s. Reconectando...`);
			clearSseWatchdog();
			try {
				req.destroy();
			} catch {}
			if (activeSseRequest === req) activeSseRequest = null;
			scheduleReconnect();
		}, 10_000);

		const req = client.request(sseUrl, {
			method: "GET",
			headers: {
				"Accept": "text/event-stream",
				"Cache-Control": "no-cache",
				"X-API-Key": apiKey,
				"X-App-Version": app.getVersion(),
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

			console.log("[SSE] Conexao SSE estabelecida com sucesso.");
			let buffer = "";

			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				lastDataAt = Date.now();
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
				console.log("[SSE] Conexao finalizada pelo servidor/timeout.");
				if (!window.isDestroyed()) {
					window.webContents.send("sse-closed");
				}
				scheduleReconnect();
			});

			res.on("error", (err) => {
				if (req.destroyed) return;
				console.error("[SSE] Erro na stream de resposta:", err.message);
				scheduleReconnect();
			});
		});

		req.on("error", (err) => {
			if (req.destroyed) return;
			console.error("[SSE] Erro na requisicao:", err.message);
			if (!window.isDestroyed()) {
				window.webContents.send("sse-error", err.message);
			}
			scheduleReconnect();
		});

		// Keep-alive TCP ajuda o sistema a detectar a queda da conexão mais cedo
		req.on("socket", (socket) => socket.setKeepAlive(true, 15_000));
		req.end();
		activeSseRequest = req;
	}

	ipcMain.on("sse-start", (_event, userToken: string) => {
		currentSseUserToken = userToken;
		connectSse(userToken);
	});

	ipcMain.on("sse-stop", () => {
		clearSseWatchdog();
		currentSseUserToken = null;
		if (sseReconnectTimer) {
			clearTimeout(sseReconnectTimer);
			sseReconnectTimer = null;
		}
		if (activeSseRequest) {
			try {
				const reqToDestroy = activeSseRequest;
				activeSseRequest = null;
				reqToDestroy.destroy();
			} catch {}
			activeSseRequest = null;
			console.log("[SSE] Conexao encerrada pelo renderer.");
		}
	});
}

