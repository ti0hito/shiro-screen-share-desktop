import type { AudioCaptureStatus } from "./audio";
import type { AudioCaptureConfig, WindowSource } from "./capture";

export interface DeepLinkParams {
	roomName?: string;
	identity?: string;
	userName?: string;
	backendUrl?: string;
	livekitUrl?: string;
	[key: string]: string | undefined;
}

export interface AppSettings {
	openAtLogin: boolean;
	autoUpdate: boolean;
}

export interface ElectronAPI {
	// Main Process Invocations (Renderer -> Main -> Renderer)
	getAvailableSources: () => Promise<WindowSource[]>;
	startAudioCapture: (
		config: AudioCaptureConfig,
	) => Promise<AudioCaptureStatus>;
	stopAudioCapture: () => Promise<void>;
	fetchLiveKitToken: (
		backendUrl: string,
		roomName: string,
		identity: string,
		userName?: string,
	) => Promise<string>;
	getResourcesPath: () => Promise<string>;
	getAppSettings: () => Promise<AppSettings>;
	setOpenAtLogin: (enabled: boolean) => Promise<boolean>;
	setAutoUpdate: (enabled: boolean) => Promise<boolean>;
	minimizeWindow: () => void;
	maximizeWindow: () => void;
	closeWindow: () => void;

	// Push Event Listeners (Main -> Renderer)
	onProcessAudioData: (callback: (buffer: ArrayBuffer) => void) => () => void;
	onDeepLinkReceived: (
		callback: (params: DeepLinkParams) => void,
	) => () => void;
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
