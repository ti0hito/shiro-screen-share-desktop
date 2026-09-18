export interface AudioCaptureStatus {
	active: boolean;
	mode: "process" | "system" | "disabled";
	pid?: number | null;
	processName?: string | null;
	samplesPerSecond: number;
	channels: number;
	method: string;
	error?: string;
}

export interface AudioVolumeStats {
	peak: number;
	rms: number;
}
