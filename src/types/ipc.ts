import type { AudioCaptureStatus } from "./audio";
import type { AudioCaptureConfig, WindowSource } from "./capture";

// Mantido para compatibilidade com protocol.ts (deep link)
export interface DeepLinkParams {
	roomName?: string;
	identity?: string;
	userName?: string;
	[key: string]: string | undefined;
}

export interface AppSettings {
	openAtLogin: boolean;
	autoUpdate: boolean;
}

export interface ApiRequestOptions {
	endpoint: string;
	method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
	body?: unknown;
	/** JWT token passado pelo renderer (não a API Key) */
	token?: string;
}

export interface ApiRequestResult {
	ok: boolean;
	status: number;
	data: unknown;
}

export interface ElectronAPI {
	// Main Process Invocations (Renderer -> Main -> Renderer)
	getAvailableSources: () => Promise<WindowSource[]>;
	startAudioCapture: (config: AudioCaptureConfig) => Promise<AudioCaptureStatus>;
	stopAudioCapture: () => Promise<void>;
	/** Rota segura: API Key é injetada pelo processo main, nunca exposta ao renderer */
	apiRequest: (opts: ApiRequestOptions) => Promise<ApiRequestResult>;
	getResourcesPath: () => Promise<string>;
	getAppSettings: () => Promise<AppSettings>;
	setOpenAtLogin: (enabled: boolean) => Promise<boolean>;
	setAutoUpdate: (enabled: boolean) => Promise<boolean>;
	minimizeWindow: () => void;
	maximizeWindow: () => void;
	closeWindow: () => void;

	/** SSE bridge: pede ao main para abrir conexão SSE (com API Key no main) */
	startSseSignaling: (userToken: string) => void;
	/** Fecha a conexão SSE no main process */
	stopSseSignaling: () => void;
	/** Recebe eventos SSE repassados pelo main process */
	onSseSignal: (callback: (event: string, data: unknown) => void) => () => void;

	// Push Event Listeners (Main -> Renderer)
	onProcessAudioData: (callback: (buffer: ArrayBuffer) => void) => () => void;
	onAudioCaptureError: (callback: (errorMsg: string) => void) => () => void;

	// Stream Deck bridge
	reportStreamShareState: (isSharing: boolean) => void;
	onStreamDeckToggle: (callback: () => void) => () => void;
	onStreamDeckGetState: (callback: () => void) => () => void;
	reportSources: (
		sources: Array<{
			id: string;
			name: string;
			processName: string;
			sourceType: "window" | "screen";
			thumbnailUrl: string;
		}>,
		selectedIndex: number,
	) => void;
	respondSources: (
		sources: Array<{
			id: string;
			name: string;
			processName: string;
			sourceType: "window" | "screen";
			thumbnailUrl: string;
		}>,
		selectedIndex: number,
	) => void;
	onStreamDeckGetSources: (callback: () => void) => () => void;
	onStreamDeckSelectSource: (callback: (index: number) => void) => () => void;
	onStreamDeckCycleSource: (callback: () => void) => () => void;
	reportAudioMode: (mode: "process" | "system" | "disabled") => void;
	respondAudioMode: (mode: "process" | "system" | "disabled") => void;
	onStreamDeckGetAudioMode: (callback: () => void) => () => void;
	onStreamDeckSetAudioMode: (
		callback: (mode: "process" | "system" | "disabled") => void,
	) => () => void;
	onStreamDeckCycleAudioMode: (callback: () => void) => () => void;
	onStreamDeckLaunchActivity: (callback: () => void) => () => void;
}

declare global {
	interface Window {
		api: ElectronAPI;
	}
}
