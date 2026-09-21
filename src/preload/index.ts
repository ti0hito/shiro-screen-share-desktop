import { contextBridge, ipcRenderer } from "electron";
import type { AudioCaptureStatus } from "../types/audio";
import type { AudioCaptureConfig, WindowSource } from "../types/capture";
import type { DeepLinkParams, ElectronAPI } from "../types/ipc";

const api: ElectronAPI = {
	getAvailableSources: (): Promise<WindowSource[]> => {
		return ipcRenderer.invoke("get-available-sources");
	},

	startAudioCapture: (
		config: AudioCaptureConfig,
	): Promise<AudioCaptureStatus> => {
		return ipcRenderer.invoke("start-audio-capture", config);
	},

	stopAudioCapture: (): Promise<void> => {
		return ipcRenderer.invoke("stop-audio-capture");
	},

	fetchLiveKitToken: (
		backendUrl: string,
		roomName: string,
		identity: string,
		userName?: string,
	): Promise<string> => {
		return ipcRenderer.invoke(
			"fetch-livekit-token",
			backendUrl,
			roomName,
			identity,
			userName,
		);
	},

	getResourcesPath: (): Promise<string> => {
		return ipcRenderer.invoke("get-resources-path");
	},

	getAppSettings: () => {
		return ipcRenderer.invoke("get-app-settings");
	},

	setOpenAtLogin: (enabled: boolean): Promise<boolean> => {
		return ipcRenderer.invoke("set-open-at-login", enabled);
	},

	setAutoUpdate: (enabled: boolean): Promise<boolean> => {
		return ipcRenderer.invoke("set-auto-update", enabled);
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

	onDeepLinkReceived: (callback: (params: DeepLinkParams) => void) => {
		const listener = (_event: any, params: DeepLinkParams) => callback(params);
		ipcRenderer.on("deep-link", listener);
		return () => ipcRenderer.removeListener("deep-link", listener);
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
		return () =>
			ipcRenderer.removeListener("streamdeck-select-source", listener);
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
		return () =>
			ipcRenderer.removeListener("streamdeck-get-audio-mode", listener);
	},
	onStreamDeckSetAudioMode: (
		callback: (mode: "process" | "system" | "disabled") => void,
	) => {
		const listener = (_event: any, mode: string) =>
			callback(mode as "process" | "system" | "disabled");
		ipcRenderer.on("streamdeck-set-audio-mode", listener);
		return () =>
			ipcRenderer.removeListener("streamdeck-set-audio-mode", listener);
	},
	onStreamDeckCycleAudioMode: (callback: () => void) => {
		const listener = (_event: any) => callback();
		ipcRenderer.on("streamdeck-cycle-audio-mode", listener);
		return () =>
			ipcRenderer.removeListener("streamdeck-cycle-audio-mode", listener);
	},
	onStreamDeckLaunchActivity: (callback: () => void) => {
		const listener = (_event: any) => callback();
		ipcRenderer.on("streamdeck-launch-activity", listener);
		return () =>
			ipcRenderer.removeListener("streamdeck-launch-activity", listener);
	},
};

try {
	contextBridge.exposeInMainWorld("api", api);
} catch (err) {
	console.error("[Preload] Failed to expose window.api contextBridge:", err);
}
