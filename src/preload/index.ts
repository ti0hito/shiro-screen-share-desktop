import { contextBridge, ipcRenderer } from "electron";
import type { AudioCaptureStatus } from "../types/audio";
import type { AudioCaptureConfig, WindowSource } from "../types/capture";
import type { ApiRequestOptions, ApiRequestResult, AppSettings, ElectronAPI } from "../types/ipc";

const api: ElectronAPI = {
	getAvailableSources: (): Promise<WindowSource[]> => {
		return ipcRenderer.invoke("get-available-sources");
	},

	startAudioCapture: (config: AudioCaptureConfig): Promise<AudioCaptureStatus> => {
		return ipcRenderer.invoke("start-audio-capture", config);
	},

	stopAudioCapture: (): Promise<void> => {
		return ipcRenderer.invoke("stop-audio-capture");
	},

	/**
	 * Rota segura para API Vercel.
	 * O renderer passa endpoint + body + JWT do usuário.
	 * A X-API-Key é injetada pelo processo main — nunca exposta aqui.
	 */
	apiRequest: (opts: ApiRequestOptions): Promise<ApiRequestResult> => {
		return ipcRenderer.invoke("api-request", opts);
	},

	openExternal: (url: string): Promise<boolean> => {
		return ipcRenderer.invoke("open-external", url);
	},

	getResourcesPath: (): Promise<string> => {
		return ipcRenderer.invoke("get-resources-path");
	},

	getAppSettings: (): Promise<AppSettings> => {
		return ipcRenderer.invoke("get-app-settings");
	},

	setOpenAtLogin: (enabled: boolean): Promise<boolean> => {
		return ipcRenderer.invoke("set-open-at-login", enabled);
	},

	setAutoUpdate: (enabled: boolean): Promise<boolean> => {
		return ipcRenderer.invoke("set-auto-update", enabled);
	},

	installUpdate: (): Promise<void> => {
		return ipcRenderer.invoke("install-update");
	},

	checkForUpdates: (): Promise<unknown> => {
		return ipcRenderer.invoke("check-for-updates");
	},

	onUpdateAvailable: (callback: (info: { version: string }) => void) => {
		const listener = (_event: any, info: any) => callback(info);
		ipcRenderer.on("update-available", listener);
		return () => ipcRenderer.removeListener("update-available", listener);
	},

	onUpdateProgress: (callback: (progress: { percent: number; bytesPerSecond: number }) => void) => {
		const listener = (_event: any, progress: any) => callback(progress);
		ipcRenderer.on("update-progress", listener);
		return () => ipcRenderer.removeListener("update-progress", listener);
	},

	onUpdateDownloaded: (callback: (info: { version: string }) => void) => {
		const listener = (_event: any, info: any) => callback(info);
		ipcRenderer.on("update-downloaded", listener);
		return () => ipcRenderer.removeListener("update-downloaded", listener);
	},

	onAppBeforeQuit: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("app-before-quit", listener);
		return () => ipcRenderer.removeListener("app-before-quit", listener);
	},

	appQuitReady: (): void => {
		ipcRenderer.send("app-quit-ready");
	},

	minimizeWindow: (): void => {
		ipcRenderer.send("window-minimize");
	},

	maximizeWindow: (): void => {
		ipcRenderer.send("window-maximize");
	},

	closeWindow: (): void => {
		ipcRenderer.send("window-close");
	},

	onProcessAudioData: (callback: (buffer: ArrayBuffer) => void) => {
		const listener = (_event: any, buffer: ArrayBuffer) => callback(buffer);
		ipcRenderer.on("process-audio-data", listener);
		return () => ipcRenderer.removeListener("process-audio-data", listener);
	},

	// SSE bridge: pede ao main process para abrir/fechar conexão SSE com API Key
	startSseSignaling: (userToken: string): void => {
		ipcRenderer.send("sse-start", userToken);
	},

	stopSseSignaling: (): void => {
		ipcRenderer.send("sse-stop");
	},

	// Recebe eventos SSE repassados pelo main process
	onSseSignal: (callback: (event: string, data: unknown) => void) => {
		const listener = (_event: any, sseEvent: string, data: unknown) => callback(sseEvent, data);
		ipcRenderer.on("sse-signal", listener);
		return () => ipcRenderer.removeListener("sse-signal", listener);
	},

	onAudioCaptureError: (callback: (errorMsg: string) => void) => {
		const listener = (_event: any, errorMsg: string) => callback(errorMsg);
		ipcRenderer.on("audio-capture-error", listener);
		return () => ipcRenderer.removeListener("audio-capture-error", listener);
	},

	// Stream Deck bridge
	reportStreamShareState: (isSharing: boolean): void => {
		ipcRenderer.send("streamdeck-state-report", isSharing);
	},
	onStreamDeckToggle: (callback: () => void) => {
		const listener = (_event: any) => callback();
		ipcRenderer.on("streamdeck-toggle", listener);
		return () => ipcRenderer.removeListener("streamdeck-toggle", listener);
	},
	onStreamDeckGetState: (callback: () => void) => {
		const listener = (_event: any) => callback();
		ipcRenderer.on("streamdeck-get-state", listener);
		return () => ipcRenderer.removeListener("streamdeck-get-state", listener);
	},
	reportSources: (
		sources: Array<{
			id: string;
			name: string;
			processName: string;
			sourceType: "window" | "screen";
			thumbnailUrl: string;
		}>,
		selectedIndex: number,
	): void => {
		ipcRenderer.send("streamdeck-sources-report", sources, selectedIndex);
	},
	respondSources: (
		sources: Array<{
			id: string;
			name: string;
			processName: string;
			sourceType: "window" | "screen";
			thumbnailUrl: string;
		}>,
		selectedIndex: number,
	): void => {
		ipcRenderer.send("streamdeck-sources-response", sources, selectedIndex);
	},
	onStreamDeckGetSources: (callback: () => void) => {
		const listener = (_event: any) => callback();
		ipcRenderer.on("streamdeck-get-sources", listener);
		return () => ipcRenderer.removeListener("streamdeck-get-sources", listener);
	},
	onStreamDeckSelectSource: (callback: (index: number) => void) => {
		const listener = (_event: any, index: number) => callback(index);
		ipcRenderer.on("streamdeck-select-source", listener);
		return () => ipcRenderer.removeListener("streamdeck-select-source", listener);
	},
	onStreamDeckCycleSource: (callback: () => void) => {
		const listener = (_event: any) => callback();
		ipcRenderer.on("streamdeck-cycle-source", listener);
		return () => ipcRenderer.removeListener("streamdeck-cycle-source", listener);
	},
	reportAudioMode: (mode: "process" | "system" | "disabled"): void => {
		ipcRenderer.send("streamdeck-audio-mode-report", mode);
	},
	respondAudioMode: (mode: "process" | "system" | "disabled"): void => {
		ipcRenderer.send("streamdeck-audio-mode-response", mode);
	},
	onStreamDeckGetAudioMode: (callback: () => void) => {
		const listener = (_event: any) => callback();
		ipcRenderer.on("streamdeck-get-audio-mode", listener);
		return () => ipcRenderer.removeListener("streamdeck-get-audio-mode", listener);
	},
	onStreamDeckSetAudioMode: (
		callback: (mode: "process" | "system" | "disabled") => void,
	) => {
		const listener = (_event: any, mode: string) =>
			callback(mode as "process" | "system" | "disabled");
		ipcRenderer.on("streamdeck-set-audio-mode", listener);
		return () => ipcRenderer.removeListener("streamdeck-set-audio-mode", listener);
	},
	onStreamDeckCycleAudioMode: (callback: () => void) => {
		const listener = (_event: any) => callback();
		ipcRenderer.on("streamdeck-cycle-audio-mode", listener);
		return () => ipcRenderer.removeListener("streamdeck-cycle-audio-mode", listener);
	},
	onStreamDeckLaunchActivity: (callback: () => void) => {
		const listener = (_event: any) => callback();
		ipcRenderer.on("streamdeck-launch-activity", listener);
		return () => ipcRenderer.removeListener("streamdeck-launch-activity", listener);
	},
};

try {
	contextBridge.exposeInMainWorld("api", api);
} catch (err) {
	console.error("[Preload] Failed to expose window.api contextBridge:", err);
}
