export class AudioPipeline {
	private audioContext: AudioContext | null = null;
	private destinationNode: MediaStreamAudioDestinationNode | null = null;
	private analyserNode: AnalyserNode | null = null;
	private scriptNode: ScriptProcessorNode | null = null;
	private pcmUnsubscribe: (() => void) | null = null;

	// Preallocated RingBuffer for stereo 48kHz audio (2 seconds buffer capacity)
	private readonly BUFFER_CAPACITY = 96000;
	private ringBufferL = new Float32Array(96000);
	private ringBufferR = new Float32Array(96000);
	private writeHead = 0;
	private readHead = 0;
	private availableFrames = 0;
	private isPrebuffered = false;
	private readonly PREBUFFER_FRAMES = 1440; // ~30ms cushion against OS jitter

	public initialize(): MediaStreamTrack | null {
		this.stop();

		try {
			this.audioContext = new (
				window.AudioContext || (window as any).webkitAudioContext
			)({
				sampleRate: 48000,
				latencyHint: "interactive",
			});

			this.writeHead = 0;
			this.readHead = 0;
			this.availableFrames = 0;
			this.isPrebuffered = false;
			this.ringBufferL.fill(0);
			this.ringBufferR.fill(0);

			// ScriptProcessorNode (1024 buffer size = ~21.3ms processing)
			this.scriptNode = this.audioContext.createScriptProcessor(1024, 0, 2);
			this.scriptNode.onaudioprocess = (e) => {
				const outL = e.outputBuffer.getChannelData(0);
				const outR = e.outputBuffer.getChannelData(1);
				const framesToRead = outL.length;

				// Wait for initial cushion before playing to avoid immediate underflow
				if (!this.isPrebuffered) {
					if (this.availableFrames >= this.PREBUFFER_FRAMES) {
						this.isPrebuffered = true;
					} else {
						outL.fill(0);
						outR.fill(0);
						return;
					}
				}

				if (this.availableFrames >= framesToRead) {
					for (let i = 0; i < framesToRead; i++) {
						outL[i] = this.ringBufferL[this.readHead];
						outR[i] = this.ringBufferR[this.readHead];
						this.readHead = (this.readHead + 1) % this.BUFFER_CAPACITY;
					}
					this.availableFrames -= framesToRead;
				} else if (this.availableFrames > 0) {
					// Read remaining frames and smoothly fade out rest to avoid clicks
					const avail = this.availableFrames;
					for (let i = 0; i < avail; i++) {
						const fade = (avail - i) / avail;
						outL[i] = this.ringBufferL[this.readHead] * fade;
						outR[i] = this.ringBufferR[this.readHead] * fade;
						this.readHead = (this.readHead + 1) % this.BUFFER_CAPACITY;
					}
					for (let i = avail; i < framesToRead; i++) {
						outL[i] = 0;
						outR[i] = 0;
					}
					this.availableFrames = 0;
					this.isPrebuffered = false; // re-accumulate cushion
				} else {
					outL.fill(0);
					outR.fill(0);
					this.isPrebuffered = false;
				}
			};

			this.analyserNode = this.audioContext.createAnalyser();
			this.analyserNode.fftSize = 256;
			this.analyserNode.smoothingTimeConstant = 0.8;
			this.analyserNode.minDecibels = -90;
			this.analyserNode.maxDecibels = -10;

			this.destinationNode = this.audioContext.createMediaStreamDestination();

			// Route: scriptNode -> analyserNode -> destinationNode
			this.scriptNode.connect(this.analyserNode);
			this.analyserNode.connect(this.destinationNode);

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
					"[AudioPipeline] ✅ Zero-jitter RingBuffer AudioTrack initialized (48kHz stereo)",
				);
				return audioTracks[0];
			}
		} catch (err) {
			console.error("[AudioPipeline] Error initializing WebAudio pipeline:", err);
		}

		return null;
	}

	public getAnalyser(): AnalyserNode | null {
		return this.analyserNode;
	}

	private processPcmChunk(buffer: ArrayBuffer): void {
		if (!this.audioContext || this.audioContext.state === "closed") return;

		try {
			const int16Array = new Int16Array(buffer);
			const numFrames = Math.floor(int16Array.length / 2);
			if (numFrames <= 0) return;

			const scale = 1.0 / 32768.0;

			// If buffer lag exceeds 200ms, gently catch up to keep real-time latency
			const MAX_LAG_FRAMES = 48000 * 0.20;
			if (this.availableFrames + numFrames > MAX_LAG_FRAMES) {
				const dropFrames = Math.min(
					this.availableFrames,
					(this.availableFrames + numFrames) - Math.floor(48000 * 0.05),
				);
				this.readHead = (this.readHead + dropFrames) % this.BUFFER_CAPACITY;
				this.availableFrames -= dropFrames;
			}

			for (let i = 0; i < numFrames; i++) {
				this.ringBufferL[this.writeHead] = int16Array[i * 2] * scale;
				this.ringBufferR[this.writeHead] = int16Array[i * 2 + 1] * scale;
				this.writeHead = (this.writeHead + 1) % this.BUFFER_CAPACITY;
			}
			this.availableFrames += numFrames;
		} catch (err) {
			console.error("[AudioPipeline] Error pushing PCM chunk to RingBuffer:", err);
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

		if (this.scriptNode) {
			try {
				this.scriptNode.disconnect();
			} catch {}
			this.scriptNode = null;
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
		this.availableFrames = 0;
		this.isPrebuffered = false;
	}
}
