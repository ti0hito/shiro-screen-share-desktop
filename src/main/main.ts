import path from "node:path";
import dotenv from "dotenv";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, protocol, Tray } from "electron";
import { autoUpdater } from "electron-updater";
import { AudioCaptureEngine } from "./audioEngine";
import { setupIpcHandlers } from "./ipcHandlers";
import { parseDeepLinkUrl, registerDeepLinkProtocol } from "./protocol";
import {
	startWebSocketServer,
	stopWebSocketServer,
} from "./websocketServer";
import { isUpdateMandatory } from "../shared/updateConfig";

// Register file scheme as privileged and secure so DocumentPictureInPicture is permitted
protocol.registerSchemesAsPrivileged([
	{
		scheme: "file",
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			corsEnabled: true,
			allowServiceWorkers: true,
		},
	},
]);

// Set Windows Application ID for Taskbar Icon & Grouping
if (process.platform === "win32") {
	app.setAppUserModelId("com.shiro.screenshare");
}

// Low Latency GPU Hardware Acceleration & Video Delivery Flags
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("enable-blink-features", "DocumentPictureInPictureAPI");
app.commandLine.appendSwitch("js-flags", "--expose-gc");

// Silence Chromium internal C++ log spam (wgc_capture_session.cc, etc.)
app.commandLine.appendSwitch("log-level", "3");
app.commandLine.appendSwitch("disable-logging");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch(
	"disable-features",
	"WindowsGraphicsCapture,WGCWindowCapturer,WGCDisplayCapturer,CalculateNativeWinOcclusion",
);

// Linux: captura de tela via PipeWire (necessária no Wayland, onde a captura passa pelo
// portal do sistema — xdg-desktop-portal — que mostra o seletor de tela/janela)
if (process.platform === "linux") {
	app.commandLine.appendSwitch("enable-features", "WebRTCPipeWireCapturer");
}

// Load .env
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let pendingDeepLink: any = null;
let appShouldQuit = false;

const audioEngine = new AudioCaptureEngine();

// Single Instance Lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	console.log(
		"[Main] Single instance lock failed. Quitting secondary instance.",
	);
	app.quit();
} else {
	app.on("second-instance", (_event, argv) => {
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.show();
			mainWindow.focus();
		}
		handleArgvDeepLink(argv);
	});
}

// Register Protocol Client
registerDeepLinkProtocol();

// A tela pede o deep link que abriu o app (ou chegou antes de ela terminar de carregar)
ipcMain.handle("get-pending-deep-link", () => {
	const params = pendingDeepLink;
	pendingDeepLink = null;
	return params;
});

function handleArgvDeepLink(argv: string[]): void {
	const deepLinkArg = argv.find((arg) => arg.startsWith("shiro://"));
	if (deepLinkArg) {
		const params = parseDeepLinkUrl(deepLinkArg);
		if (params) {
			const rendererReady = mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading();
			if (rendererReady) {
				mainWindow!.webContents.send("deep-link", params);
			} else {
				// Tela ainda carregando: ela busca o link pendente ao iniciar (get-pending-deep-link)
				pendingDeepLink = params;
			}
			if (mainWindow && !mainWindow.isDestroyed()) {
				if (mainWindow.isMinimized()) mainWindow.restore();
				mainWindow.show();
				mainWindow.focus();
			}
		}
	}
}

function getIconPath(): string {
	// .ico é formato do Windows; Linux (janela, bandeja, dock) usa PNG
	const file = process.platform === "win32" ? "icon.ico" : "icon.png";
	const candidates = [
		path.join(process.resourcesPath, file),
		path.join(__dirname, "..", "renderer", file),
		path.join(__dirname, "..", "..", file),
		path.join(process.cwd(), file),
	];
	for (const candidate of candidates) {
		if (require("node:fs").existsSync(candidate)) {
			return candidate;
		}
	}
	return path.join(__dirname, "..", "..", file);
}

function createWindow(): void {
	const iconPath = getIconPath();

	mainWindow = new BrowserWindow({
		width: 1404,
		height: 936,
		minWidth: 800,
		minHeight: 600,
		frame: false,
		titleBarStyle: "hidden",
		backgroundColor: "#0c0e14",
		icon: iconPath,
		webPreferences: {
			preload: path.join(__dirname, "..", "preload", "index.js"),
			contextIsolation: true,
			nodeIntegration: false,
			backgroundThrottling: false,
			webSecurity: false,
		},
	});

	setupIpcHandlers(mainWindow, audioEngine);

	// Bloqueia abertura do DevTools por atalhos (Ctrl+Shift+I, Ctrl+Shift+J, F12, Ctrl+U)
	const blockDevTools = (wc: Electron.WebContents) => {
		if (!app.isPackaged) return; // No modo dev, permite abrir o DevTools normalmente
		wc.on("before-input-event", (event, input) => {
			const isDevTools =
				(input.control && input.shift && (input.key.toLowerCase() === "i" || input.key.toLowerCase() === "j")) ||
				input.key === "F12" ||
				(input.control && input.key.toLowerCase() === "u");
			if (isDevTools) {
				event.preventDefault();
			}
		});
	};
	blockDevTools(mainWindow.webContents);

	mainWindow.webContents.setWindowOpenHandler(() => {
		return {
			action: "allow",
			overrideBrowserWindowOptions: {
				title: "Shiro Screen Share · Pop-out",
				frame: false,
				alwaysOnTop: true,
				skipTaskbar: false,
				backgroundColor: "#08090c",
				autoHideMenuBar: true,
				resizable: true,
				minWidth: 320,
				minHeight: 180,
				width: 720,
				height: 405,
				icon: iconPath,
				webPreferences: {
					backgroundThrottling: false,
					webSecurity: false,
				},
			},
		};
	});

	mainWindow.webContents.on("did-create-window", (childWindow) => {
		try {
			childWindow.setAlwaysOnTop(true, "screen-saver");
			if (iconPath) childWindow.setIcon(iconPath);
			childWindow.webContents.setBackgroundThrottling(false);
			blockDevTools(childWindow.webContents);
		} catch (err) {
			console.warn("[Main] Error configuring child window:", err);
		}
	});

	const htmlPath = path.join(__dirname, "..", "renderer", "index.html");
	mainWindow.loadFile(htmlPath);


	// Start WebSocket server for Stream Deck bridge
	startWebSocketServer(mainWindow);

	mainWindow.on("hide", () => {
		// Ao minimizar para a bandeja ou ocultar, limpa cache de rede/imagens e aciona coleta de lixo
		try {
			mainWindow?.webContents.session.clearCache().catch(() => {});
			if (typeof (global as any).gc === "function") {
				(global as any).gc();
			}
		} catch {
			// ignore
		}
	});

	// Limpeza periódica de cache e memória a cada 30 minutos em sessões longas
	const memoryCleanupInterval = setInterval(() => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.session.clearCache().catch(() => {});
			if (typeof (global as any).gc === "function") {
				(global as any).gc();
			}
		}
	}, 30 * 60 * 1000);

	mainWindow.on("closed", () => {
		clearInterval(memoryCleanupInterval);
		mainWindow = null;
	});

	mainWindow.on("close", (event) => {
		if (appShouldQuit) return;
		event.preventDefault();
		if (process.platform === "win32" && tray) {
			// Windows: fechar minimiza para a bandeja
			mainWindow?.hide();
		} else {
			// Linux: vários ambientes (ex.: GNOME) não exibem ícone de bandeja, e a janela
			// escondida ficaria rodando sem forma de reabrir ou fechar. Fechar encerra o app
			// (passando pelo before-quit, que sai da sala e encerra a transmissão antes).
			appShouldQuit = true;
			app.quit();
		}
	});

	createTray(iconPath);
}

function createTray(iconPath: string): void {
	// Linux também ganha ícone de bandeja (onde o ambiente suporta), mas fechar a janela encerra o app
	if (tray || (process.platform !== "win32" && process.platform !== "linux")) return;

	try {
		const icon = nativeImage.createFromPath(iconPath);

		tray = new Tray(icon);
		const contextMenu = Menu.buildFromTemplate([
			{
				label: "Abrir Shiro Screen Share",
				click: () => {
					if (mainWindow) {
						mainWindow.show();
						mainWindow.focus();
					}
				},
			},
			{
				label: "Sair",
				click: () => {
					appShouldQuit = true;
					audioEngine.stopCapture();
					app.quit();
				},
			},
		]);

		tray.setToolTip("Shiro Screen Share — Desktop Capturer");
		tray.setContextMenu(contextMenu);
		tray.on("double-click", () => {
			if (mainWindow) {
				mainWindow.show();
				mainWindow.focus();
			}
		});
	} catch (err) {
		console.warn("[Tray] Could not create system tray:", err);
	}
}

let autoUpdateEnabled: boolean = true;

export function isAutoUpdateEnabled(): boolean {
	return autoUpdateEnabled;
}

export function setAutoUpdateEnabled(enabled: boolean): void {
	autoUpdateEnabled = enabled;
	autoUpdater.autoDownload = enabled;
	autoUpdater.autoInstallOnAppQuit = enabled;
	if (!enabled) {
		console.log("[AutoUpdater] Auto updates disabled by user.");
	}
}

export function installUpdateNow(): void {
	console.log("[AutoUpdater] Installing update and restarting app...");
	autoUpdater.quitAndInstall(false, true);
}

export async function downloadUpdateNow(): Promise<unknown> {
	if (app.isPackaged) {
		console.log("[AutoUpdater] Starting manual update download...");
		return await autoUpdater.downloadUpdate();
	}
	return null;
}

export async function checkForUpdatesNow(): Promise<unknown> {
	if (app.isPackaged) {
		try {
			console.log("[AutoUpdater] Checking for updates on GitHub...");
			return await autoUpdater.checkForUpdates();
		} catch (err: any) {
			console.warn("[AutoUpdater] Error checking updates:", err?.message || err);
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send("update-error", { message: err?.message || "Falha ao verificar atualizações" });
			}
			return { error: err?.message || "Falha ao verificar atualizações" };
		}
	}
	return { isDev: true, version: app.getVersion() };
}

function setupAutoUpdater(): void {
	autoUpdater.autoDownload = autoUpdateEnabled;
	autoUpdater.autoInstallOnAppQuit = autoUpdateEnabled;

	autoUpdater.on("checking-for-update", () => {
		console.log("[AutoUpdater] Checking for updates on GitHub...");
	});

	autoUpdater.on("update-available", (info: any) => {
		const mandatory = isUpdateMandatory(info.version, info.releaseNotes, info);
		info.mandatory = mandatory;
		console.log(`[AutoUpdater] New update available: v${info.version} (mandatory: ${mandatory})`);
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("update-available", info);
		}
	});

	autoUpdater.on("update-not-available", () => {
		console.log("[AutoUpdater] App is up to date.");
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("update-not-available");
		}
	});

	autoUpdater.on("download-progress", (progressObj) => {
		console.log(
			`[AutoUpdater] Downloading update... ${progressObj.percent.toFixed(1)}%`,
		);
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("update-progress", progressObj);
		}
	});

	autoUpdater.on("update-downloaded", (info) => {
		console.log(
			"[AutoUpdater] Update downloaded. Will install automatically on app quit.",
		);
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("update-downloaded", info);
		}
	});

	autoUpdater.on("error", (err) => {
		console.warn("[AutoUpdater] Update error:", err?.message || err);
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("update-error", { message: err?.message || "Erro no auto-updater" });
		}
	});

	if (app.isPackaged && autoUpdateEnabled) {
		setTimeout(() => {
			if (autoUpdateEnabled) {
				autoUpdater.checkForUpdatesAndNotify().catch((err) => {
					console.warn("[AutoUpdater] Error checking updates:", err);
				});
			}
		}, 3000);
	}
}

app.whenReady().then(() => {
	createWindow();
	handleArgvDeepLink(process.argv);
	setupAutoUpdater();
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

// Antes de sair, dá ao renderer a chance de sair da sala / encerrar a transmissão na API.
// Sem isso, a requisição de leave feita no beforeunload morre junto com o processo e o
// usuário fica como membro-fantasma da sala no servidor.
const QUIT_CLEANUP_TIMEOUT_MS = 3000;
let quitCleanupDone = false;

app.on("before-quit", (event) => {
	if (quitCleanupDone || !mainWindow || mainWindow.isDestroyed()) return;
	event.preventDefault();
	appShouldQuit = true;

	const finish = () => {
		if (quitCleanupDone) return;
		quitCleanupDone = true;
		ipcMain.removeListener("app-quit-ready", finish);
		app.quit();
	};
	ipcMain.once("app-quit-ready", finish);
	setTimeout(finish, QUIT_CLEANUP_TIMEOUT_MS);
	mainWindow.webContents.send("app-before-quit");
});

app.on("will-quit", () => {
	audioEngine.stopCapture();
	stopWebSocketServer();
});
