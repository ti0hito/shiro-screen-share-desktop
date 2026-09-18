export class AudioPipeline {
	private audioContext: AudioContext | null = null;
	private destinationNode: MediaStreamAudioDestinationNode | null = null;
	private analyserNode: AnalyserNode | null = null;
	private pcmUnsubscribe: (() => void) | null = null;

	// Audio scheduler — 0ms artificial delay for zero audio-video desync
	private nextPlayTime: number = 0;

	public initialize(): MediaStreamTrack | null {
		this.stop();

		try {
			this.audioContext = new (
				window.AudioContext || (window as any).webkitAudioContext
			)({
				sampleRate: 48000,
				latencyHint: 0, // Request minimum hardware latency (0ms buffer)
			});

			// AnalyserNode for frequency-domain visualizer
			this.analyserNode = this.audioContext.createAnalyser();
			this.analyserNode.fftSize = 256; // 128 frequency bins, fast & smooth
			this.analyserNode.smoothingTimeConstant = 0.75; // Smooth decay without lag
			this.analyserNode.minDecibels = -90;
			this.analyserNode.maxDecibels = -10;

			this.destinationNode = this.audioContext.createMediaStreamDestination();

			// Route: bufferSource → analyser → destination
			this.analyserNode.connect(this.destinationNode);

			this.nextPlayTime = 0;

			// Listen for IPC process audio PCM data
			if (window.api?.onProcessAudioData) {
				this.pcmUnsubscribe = window.api.onProcessAudioData(
					(arrayBuffer: ArrayBuffer) => {
						this.processPcmChunk(arrayBuffer);
					},
				);
			}

			const audioTracks = this.destinationNode.stream.getAudioTracks();
			if (audioTracks.length > 0) {
				console.log(
					"[AudioPipeline] ✅ Low-latency AudioTrack initialized (48kHz, AnalyserNode active)",
				);
				return audioTracks[0];
			}
		} catch (err) {
			console.error(
				"[AudioPipeline] Error initializing WebAudio pipeline:",
				err,
			);
		}

		return null;
	}

	public getAnalyser(): AnalyserNode | null {
		return this.analyserNode;
	}

	private processPcmChunk(buffer: ArrayBuffer): void {
		if (
			!this.audioContext ||
			!this.destinationNode ||
			this.audioContext.state === "closed"
		)
			return;

		try {
			// loopback-capture delivers: interleaved signed 16-bit LE PCM, 2ch, 48kHz
			const int16Array = new Int16Array(buffer);
			const numFrames = Math.floor(int16Array.length / 2); // 2 channels interleaved
			if (numFrames <= 0) return;

			const audioBuffer = this.audioContext.createBuffer(2, numFrames, 48000);
			const ch0 = audioBuffer.getChannelData(0); // Left
			const ch1 = audioBuffer.getChannelData(1); // Right

			const scale = 1.0 / 32768.0;

			for (let i = 0; i < numFrames; i++) {
				ch0[i] = int16Array[i * 2] * scale;
				ch1[i] = int16Array[i * 2 + 1] * scale;
			}

			const currentTime = this.audioContext.currentTime;
			const chunkDuration = numFrames / 48000;

			// 1. Catch up if nextPlayTime falls behind currentTime
			if (this.nextPlayTime < currentTime) {
				this.nextPlayTime = currentTime;
			}

			// 2. Ultra-Low Latency Anti-Drift Guard: Cap maximum buffer to 5ms (0.005s)
			// Any audio queued more than 5ms ahead is snapped to currentTime immediately!
			const MAX_DRIFT_BUFFER_SEC = 0.005; // 5ms ultra-low latency cap
			if (this.nextPlayTime > currentTime + MAX_DRIFT_BUFFER_SEC) {
				this.nextPlayTime = currentTime;
			}

			const source = this.audioContext.createBufferSource();
			source.buffer = audioBuffer;
			// Route: bufferSource → analyser → destination
			source.connect(this.analyserNode!);
			source.start(this.nextPlayTime);

			this.nextPlayTime += chunkDuration;
		} catch (err) {
			console.error("[AudioPipeline] Error processing PCM chunk:", err);
		}
	}

	public getAudioTrack(): MediaStreamTrack | null {
		if (this.destinationNode) {
			const tracks = this.destinationNode.stream.getAudioTracks();
			return tracks.length > 0 ? tracks[0] : null;
		}
		return null;
	}

	public stop(): void {
		if (this.pcmUnsubscribe) {
			this.pcmUnsubscribe();
			this.pcmUnsubscribe = null;
		}

		if (this.audioContext && this.audioContext.state !== "closed") {
			try {
				this.audioContext.close();
			} catch (err) {
				console.warn("[AudioPipeline] Error closing AudioContext:", err);
			}
		}

		this.audioContext = null;
		this.destinationNode = null;
		this.analyserNode = null;
		this.nextPlayTime = 0;
	}
}
