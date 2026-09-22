export type SourceType = "window" | "screen";

export interface WindowSource {
	id: string; // Electron DesktopCapturer source ID (e.g. "window:131232:0")
	name: string; // Window Title (e.g. "League of Legends")
	sourceType: SourceType; // 'window' or 'screen'
	pid: number; // Process ID resolved via Win32 API GetWindowThreadProcessId
	hwnd: number; // Win32 Window Handle integer
	processName: string; // Executable name (e.g. "LeagueClient.exe")
	thumbnailUrl: string; // Real-time preview thumbnail Data URL
	appIconUrl?: string; // Executable Icon Data URL if available
}

export type AudioCaptureMode = "process" | "system" | "disabled";

export interface AudioCaptureConfig {
	mode: AudioCaptureMode;
	targetPid?: number | null;
	targetProcessName?: string | null;
	sampleRate?: number;
	channels?: number;
}

export interface StreamQualityOptions {
	resolution: "1080p" | "720p" | "1440p" | "4k" | "480p";
	width: number;
	height: number;
	fps: number;
	bitrateKbps: number;
	degradationPreference:
		| "maintain-resolution"
		| "maintain-framerate"
		| "balanced";
}

export interface StreamStartParams {
	sourceId: string;
	roomName: string;
	identity: string;
	userName?: string;
	backendUrl?: string;
	audioConfig: AudioCaptureConfig;
	qualityOptions?: StreamQualityOptions;
}
