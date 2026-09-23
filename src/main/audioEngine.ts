import type { BrowserWindow } from "electron";
import loopback from "loopback-capture";
import type { AudioCaptureStatus } from "../types/audio";
import type { AudioCaptureConfig } from "../types/capture";
import { findCandidatePids } from "./windowScanner";

export class AudioCaptureEngine {
	private activeCapture: any = null;
	private currentStatus: AudioCaptureStatus = {
		active: false,
		mode: "disabled",
		samplesPerSecond: 48000,
		channels: 2,
		method: "none",
	};

	/**
	 * Starts capturing process audio for a specific target PID.
	 * If process mode is requested, strictly locks audio capture to target PID & child processes.
	 */
	public async startCapture(
		config: AudioCaptureConfig,
		window: BrowserWindow,
	): Promise<AudioCaptureStatus> {
		this.stopCapture();

		if (config.mode === "disabled") {
			this.currentStatus = {
				active: false,
				mode: "disabled",
				samplesPerSecond: 48000,
				channels: 2,
				method: "none",
			};
			return this.currentStatus;
		}

		// Process loopback mode
		if (config.mode === "process" && config.targetPid && config.targetPid > 0) {
			const candidatePids = findCandidatePids(
				config.targetPid,
				config.targetProcessName,
			);
			console.log(
				`[AudioEngine] 🎯 Candidate PIDs for isolated process audio:`,
				candidatePids,
			);

			for (const targetPid of candidatePids) {
				try {
					console.log(
						`[AudioEngine] 🔊 Activating WASAPI Process Loopback — PID: ${targetPid} (${config.targetProcessName}) + child processes`,
					);
					const processSuccess = await this.tryProcessLoopback(
						targetPid,
						window,
					);
					if (processSuccess) {
						this.currentStatus = {
							active: true,
							mode: "process",
							pid: targetPid,
							processName: config.targetProcessName,
							samplesPerSecond: 48000,
							channels: 2,
							method: "wasapi-process-loopback",
						};
						// Notify renderer of confirmed process audio mode
						if (window && !window.isDestroyed()) {
							window.webContents.send("audio-mode-status", {
								mode: "process",
								pid: targetPid,
								processName: config.targetProcessName,
							});
						}
						return this.currentStatus;
					}
				} catch (err: any) {
					console.warn(
						`[AudioEngine] ⚠️ Process loopback init failed for PID ${targetPid}:`,
						err.message,
					);
				}
			}

			console.warn(
				"[AudioEngine] WASAPI Process Loopback could not bind to candidate PIDs. Falling back to system loopback...",
			);
		}

		// System loopback mode (or fallback if process capture failed completely)
		try {
			console.log(`[AudioEngine] Initiating System WASAPI Loopback Capture`);
			const systemSuccess = await this.trySystemLoopback(window);
			if (systemSuccess) {
				this.currentStatus = {
					active: true,
					mode: "system",
					samplesPerSecond: 48000,
					channels: 2,
					method: "wasapi-system-loopback",
				};
				if (window && !window.isDestroyed()) {
					window.webContents.send("audio-mode-status", { mode: "system" });
				}
				return this.currentStatus;
			}
		} catch (err: any) {
			console.error(`[AudioEngine] System loopback capture failed:`, err);
			this.currentStatus = {
				active: false,
				mode: "disabled",
				samplesPerSecond: 48000,
				channels: 2,
				method: "failed",
				error: err.message,
			};
			return this.currentStatus;
		}

		return this.currentStatus;
	}

	private tryProcessLoopback(
		pid: number,
		window: BrowserWindow,
	): Promise<boolean> {
		return new Promise((resolve, reject) => {
			try {
				const capture = new loopback.LoopbackCapture();

				// Pass includeChildren = true to capture the entire target process tree
				capture.start(pid, true, (chunk: Buffer) => {
					if (chunk && chunk.length > 0 && window && !window.isDestroyed()) {
						const arrayBuffer = chunk.buffer.slice(
							chunk.byteOffset,
							chunk.byteOffset + chunk.byteLength,
						);
						window.webContents.send("process-audio-data", arrayBuffer);
					}
				});

				this.activeCapture = capture;
				console.log(
					`[AudioEngine] ✅ WASAPI Process Loopback active for PID ${pid}`,
				);
				resolve(true);
			} catch (err) {
				reject(err);
			}
		});
	}

	private trySystemLoopback(window: BrowserWindow): Promise<boolean> {
		return new Promise((resolve, reject) => {
			try {
				const capture = new loopback.LoopbackCapture();

				capture.startSystemAudio((chunk: Buffer) => {
					if (chunk && chunk.length > 0 && window && !window.isDestroyed()) {
						const arrayBuffer = chunk.buffer.slice(
							chunk.byteOffset,
							chunk.byteOffset + chunk.byteLength,
						);
						window.webContents.send("process-audio-data", arrayBuffer);
					}
				});

				this.activeCapture = capture;
				console.log(`[AudioEngine] ✅ System WASAPI Loopback active`);
				resolve(true);
			} catch (err) {
				reject(err);
			}
		});
	}

	public stopCapture(): void {
		if (this.activeCapture) {
			try {
				this.activeCapture.stop();
			} catch (err) {
				console.warn("[AudioEngine] Warning stopping capture:", err);
			}
			this.activeCapture = null;
		}
		this.currentStatus = {
			active: false,
			mode: "disabled",
			samplesPerSecond: 48000,
			channels: 2,
			method: "none",
		};
	}

	public getStatus(): AudioCaptureStatus {
		return this.currentStatus;
	}
}
