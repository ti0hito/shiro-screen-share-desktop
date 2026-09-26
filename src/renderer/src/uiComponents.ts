export function setupWindowControls(): void {
	const btnMinimize = document.getElementById("btn-minimize");
	const btnMaximize = document.getElementById("btn-maximize");
	const btnClose = document.getElementById("btn-close");

	if (btnMinimize) {
		btnMinimize.addEventListener("click", () => {
			if (window.api) window.api.minimizeWindow();
		});
	}

	if (btnMaximize) {
		btnMaximize.addEventListener("click", () => {
			if (window.api) window.api.maximizeWindow();
		});
	}

	if (btnClose) {
		btnClose.addEventListener("click", () => {
			if (window.api) window.api.closeWindow();
		});
	}
}

/**
 * Genuine canvas-based audio visualizer using Web Audio AnalyserNode.
 * Renders a frequency bar chart with color-graded intensity in real-time.
 */
export class AudioVisualizer {
	private canvas: HTMLCanvasElement | null = null;
	private ctx: CanvasRenderingContext2D | null = null;
	private analyser: AnalyserNode | null = null;
	private dataArray: Uint8Array<ArrayBuffer> | null = null;
	private animationId: number | null = null;
	private isRunning: boolean = false;

	public mount(canvasId: string): void {
		this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
		if (!this.canvas) {
			console.warn(`[AudioVisualizer] Canvas #${canvasId} not found`);
			return;
		}
		this.ctx = this.canvas.getContext("2d");
	}

	public start(analyser: AnalyserNode): void {
		this.analyser = analyser;
		this.dataArray = new Uint8Array(analyser.frequencyBinCount);
		this.isRunning = true;
		this.renderFrame();
	}

	public stop(): void {
		this.isRunning = false;
		this.analyser = null;
		this.dataArray = null;
		if (this.animationId !== null) {
			cancelAnimationFrame(this.animationId);
			this.animationId = null;
		}
		this.clearCanvas();
	}

	private clearCanvas(): void {
		if (!this.canvas || !this.ctx) return;
		const { width, height } = this.canvas;
		this.ctx.clearRect(0, 0, width, height);
	}

	private renderFrame(): void {
		if (
			!this.isRunning ||
			!this.analyser ||
			!this.dataArray ||
			!this.canvas ||
			!this.ctx
		)
			return;

		this.animationId = requestAnimationFrame(() => this.renderFrame());

		this.analyser.getByteFrequencyData(this.dataArray);

		// Sync canvas buffer to its CSS size every frame (handles resize)
		const cssW = this.canvas.clientWidth;
		const cssH = this.canvas.clientHeight;
		if (this.canvas.width !== cssW || this.canvas.height !== cssH) {
			this.canvas.width = cssW;
			this.canvas.height = cssH;
		}

		const W = this.canvas.width;
		const H = this.canvas.height;
		const ctx = this.ctx;

		// Clear with transparent fill
		ctx.clearRect(0, 0, W, H);

		// We'll render the lower half of the frequency spectrum (most audible range)
		// fftSize=256 → frequencyBinCount=128; we'll use bins 0..95 (skip ultra-high freq)
		const totalBins = this.dataArray.length;
		const usedBins = Math.floor(totalBins * 0.75); // keep 75% of bins (bass to high-mid)
		const barCount = Math.min(usedBins, 48); // max 48 visual bars
		const step = Math.floor(usedBins / barCount);

		const gap = 2;
		const barW = Math.max(1, (W - gap * (barCount - 1)) / barCount);

		for (let i = 0; i < barCount; i++) {
			// Average a small bin window for smoother bars
			let sum = 0;
			for (let j = 0; j < step; j++) {
				sum += this.dataArray[i * step + j];
			}
			const magnitude = sum / step / 255; // 0..1

			const barH = Math.max(2, magnitude * H);
			const x = i * (barW + gap);
			const y = H - barH;

			// Color: green (low) → yellow (mid) → red (high)
			const hue = (1 - magnitude) * 120; // 120=green, 60=yellow, 0=red
			const saturation = 85;
			const lightness = 45 + magnitude * 15; // brighter at peaks
			const alpha = 0.75 + magnitude * 0.25;

			ctx.fillStyle = `hsla(${hue}, ${saturation}%, ${lightness}%, ${alpha})`;
			ctx.beginPath();
			ctx.roundRect(x, y, barW, barH, [2, 2, 0, 0]);
			ctx.fill();
		}
	}
}

export function setStreamStatus(isLive: boolean, text?: string): void {
	const streamBadge = document.getElementById("stream-badge");
	const btnStart = document.getElementById(
		"btn-start-stream",
	) as HTMLButtonElement;
	const btnStop = document.getElementById(
		"btn-stop-stream",
	) as HTMLButtonElement;

	if (streamBadge) {
		if (isLive) {
			streamBadge.className = "badge badge-live";
			streamBadge.innerText = text || "AO VIVO";
		} else {
			streamBadge.className = "badge badge-offline";
			streamBadge.innerText = text || "Desconectado";
		}
	}

	if (btnStart && btnStop) {
		if (isLive) {
			btnStart.classList.add("hidden");
			btnStop.classList.remove("hidden");
		} else {
			btnStart.classList.remove("hidden");
			btnStop.classList.add("hidden");
		}
	}
}
