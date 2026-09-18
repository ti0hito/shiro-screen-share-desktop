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
}

declare global {
	interface Window {
		api: ElectronAPI;
	}
}
