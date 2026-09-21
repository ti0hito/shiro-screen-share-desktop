import {
	AppWindow,
	CheckCircle2,
	createIcons,
	Loader2,
	MicOff,
	Monitor,
	Moon,
	Play,
	PlayCircle,
	Power,
	Radio,
	RefreshCw,
	ScreenShare,
	Settings,
	ShieldCheck,
	Square,
	Sun,
	Target,
	Video,
	Volume2,
	VolumeX,
	Wifi,
	X,
	Zap,
} from "lucide";
import type {
	AudioCaptureMode,
	StreamQualityOptions,
	WindowSource,
} from "../../types/capture";
import type { DeepLinkParams } from "../../types/ipc";
import { AudioPipeline } from "./audioPipeline";
import { LiveKitPublisher } from "./livekitPublisher";
import { SourcePicker } from "./sourcePicker";
import {
	AudioVisualizer,
	setStreamStatus,
	setupWindowControls,
} from "./uiComponents";

class ShiroApp {
	private sourcePicker: SourcePicker | null = null;
	private audioPipeline: AudioPipeline = new AudioPipeline();
	private livekitPublisher: LiveKitPublisher = new LiveKitPublisher();
	private audioVisualizer: AudioVisualizer = new AudioVisualizer();
	private currentVideoTrack: MediaStreamTrack | null = null;
	private previewStream: MediaStream | null = null;
	private hasDeepLinkParams: boolean = false;
	private allSources: WindowSource[] = [];
	private selectedSourceIndex: number = -1;

	public async initialize(): Promise<void> {
		console.log("[App] Initializing Shiro Screen Share App UI...");

		setupWindowControls();
		this.setupThemeToggle();
		this.setupSourcePicker();
		this.setupAudioRadioListeners();
		this.setupQualityChangeListeners();
		this.setupPopoverToggles();
		this.setupStreamButtons();
		this.setupDeepLinkListener();
		this.setupAppSettings();
		this.setupCustomSelects();
		this.setupStreamDeckBridge();

		// Mount the canvas visualizer (does not start animation yet)
		this.audioVisualizer.mount("vu-canvas");

		// Render Lucide icons
		this.refreshIcons();

		// Initial load of windows
		await this.refreshSources();
	}

	private async setupAppSettings(): Promise<void> {
		const chkOpenAtLogin = document.getElementById(
			"chk-open-at-login",
		) as HTMLInputElement;
		const chkAutoUpdate = document.getElementById(
			"chk-auto-update",
		) as HTMLInputElement;

		if (window.api?.getAppSettings) {
			try {
				const settings = await window.api.getAppSettings();
				if (chkOpenAtLogin) chkOpenAtLogin.checked = settings.openAtLogin;
				if (chkAutoUpdate) chkAutoUpdate.checked = settings.autoUpdate;
			} catch (err) {
				console.warn("[App] Could not load app settings:", err);
			}
		}

		chkOpenAtLogin?.addEventListener("change", async () => {
			if (window.api?.setOpenAtLogin) {
				const newState = await window.api.setOpenAtLogin(
					chkOpenAtLogin.checked,
				);
				chkOpenAtLogin.checked = newState;
				console.log("[App] Start with Windows set to:", newState);
			}
		});

		chkAutoUpdate?.addEventListener("change", async () => {
			if (window.api?.setAutoUpdate) {
				const newState = await window.api.setAutoUpdate(chkAutoUpdate.checked);
				chkAutoUpdate.checked = newState;
				console.log("[App] Auto updates set to:", newState);
			}
		});

		document.querySelectorAll(".setting-toggle-row").forEach((row) => {
			row.addEventListener("click", (e) => {
				const checkbox = row.querySelector(
					'input[type="checkbox"]',
				) as HTMLInputElement | null;
				if (checkbox && e.target !== checkbox) {
					checkbox.click();
				}
			});
		});
	}

	private setupCustomSelects(): void {
		document
			.querySelectorAll<HTMLElement>(".custom-select")
			.forEach((container) => {
				const nativeSelect = container.querySelector(
					"select",
				) as HTMLSelectElement;
				const trigger = container.querySelector(
					".select-trigger",
				) as HTMLButtonElement;
				const options = container.querySelectorAll(".select-dropdown li");

				if (!nativeSelect || !trigger || !options.length) return;

				trigger.addEventListener("click", (e) => {
					e.stopPropagation();
					const wasOpen = container.classList.contains("open");
					document
						.querySelectorAll(".custom-select.open")
						.forEach((el) => el.classList.remove("open"));
					if (!wasOpen) container.classList.add("open");
				});

				options.forEach((option) => {
					option.addEventListener("click", () => {
						const value = option.getAttribute("data-value")!;
						nativeSelect.value = value;
						trigger.textContent = option.textContent;

						container
							.querySelectorAll(".select-dropdown li")
							.forEach((li) => li.classList.remove("selected"));
						option.classList.add("selected");

						container.classList.remove("open");
						nativeSelect.dispatchEvent(new Event("change", { bubbles: true }));
					});
				});
			});

		document.addEventListener("click", () => {
			document
				.querySelectorAll(".custom-select.open")
				.forEach((el) => el.classList.remove("open"));
		});
	}

	private refreshIcons(): void {
		try {
			createIcons({
				icons: {
					Sun,
					Moon,
					Monitor,
					Zap,
					Wifi,
					Target,
					RefreshCw,
					AppWindow,
					ScreenShare,
					Video,
					PlayCircle,
					Volume2,
					ShieldCheck,
					VolumeX,
					MicOff,
					Radio,
					CheckCircle2,
					Play,
					Square,
					Loader2,
					Settings,
					X,
					Power,
				},
			});
		} catch (err) {
			console.warn("[App] Icon creation warning:", err);
		}
	}

	private setupThemeToggle(): void {
		const btnToggle = document.getElementById("btn-theme-toggle");
		const savedTheme = localStorage.getItem("shiro-theme") || "dark";
		this.applyTheme(savedTheme);

		if (btnToggle) {
			btnToggle.addEventListener("click", () => {
				const currentTheme =
					document.documentElement.getAttribute("data-theme") || "dark";
				const newTheme = currentTheme === "dark" ? "light" : "dark";
				this.applyTheme(newTheme);
				localStorage.setItem("shiro-theme", newTheme);
			});
		}
	}

	private applyTheme(theme: string): void {
		document.documentElement.setAttribute("data-theme", theme);
		const btnToggle = document.getElementById("btn-theme-toggle");
		if (btnToggle) {
			btnToggle.innerHTML =
				theme === "dark"
					? '<i data-lucide="sun"></i>'
					: '<i data-lucide="moon"></i>';
			btnToggle.title =
				theme === "dark"
					? "Alternar para Tema Claro"
					: "Alternar para Tema Escuro";
			this.refreshIcons();
		}
	}

	private setupPopoverToggles(): void {
		const btnToggleSettings = document.getElementById("btn-toggle-settings");
		const btnCloseSettings = document.getElementById("btn-close-settings");
		const settingsPopover = document.getElementById("settings-popover");

		const btnToggleAudio = document.getElementById("btn-toggle-audio");
		const btnCloseAudio = document.getElementById("btn-close-audio");
		const audioPopover = document.getElementById("audio-popover");

		if (btnToggleSettings && settingsPopover) {
			btnToggleSettings.addEventListener("click", (e) => {
				e.stopPropagation();
				audioPopover?.classList.add("hidden");
				btnToggleAudio?.classList.remove("active");
				const isHidden = settingsPopover.classList.toggle("hidden");
				if (!isHidden) {
					btnToggleSettings.classList.add("active");
				} else {
					btnToggleSettings.classList.remove("active");
				}
			});
		}

		if (btnCloseSettings && settingsPopover) {
			btnCloseSettings.addEventListener("click", () => {
				settingsPopover.classList.add("hidden");
				btnToggleSettings?.classList.remove("active");
			});
		}

		if (btnToggleAudio && audioPopover) {
			btnToggleAudio.addEventListener("click", (e) => {
				e.stopPropagation();
				settingsPopover?.classList.add("hidden");
				btnToggleSettings?.classList.remove("active");
				const isHidden = audioPopover.classList.toggle("hidden");
				if (!isHidden) {
					btnToggleAudio.classList.add("active");
				} else {
					btnToggleAudio.classList.remove("active");
				}
			});
		}

		if (btnCloseAudio && audioPopover) {
			btnCloseAudio.addEventListener("click", () => {
				audioPopover.classList.add("hidden");
				btnToggleAudio?.classList.remove("active");
			});
		}
	}

	private setupSourcePicker(): void {
		const gridContainer = document.getElementById("sources-grid");
		const tabWindows = document.getElementById("tab-windows");
		const tabScreens = document.getElementById("tab-screens");
		const btnRefresh = document.getElementById("btn-refresh-sources");
		const indicator = document.querySelector(
			".tabs-indicator",
		) as HTMLElement | null;

		const moveIndicator = (tab: HTMLElement) => {
			if (!indicator) return;
			indicator.style.width = `${tab.offsetWidth}px`;
			indicator.style.left = `${tab.offsetLeft}px`;
		};

		if (gridContainer) {
			this.sourcePicker = new SourcePicker(
				gridContainer,
				(selectedSource: WindowSource) => {
					this.onSourceSelected(selectedSource);
				},
			);
		}

		if (tabWindows && tabScreens) {
			moveIndicator(tabWindows);

			tabWindows.addEventListener("click", () => {
				tabWindows.classList.add("active");
				tabScreens.classList.remove("active");
				moveIndicator(tabWindows);
				this.sourcePicker?.setFilter("window");
				this.refreshIcons();
			});

			tabScreens.addEventListener("click", () => {
				tabScreens.classList.add("active");
				tabWindows.classList.remove("active");
				moveIndicator(tabScreens);
				this.sourcePicker?.setFilter("screen");
				this.refreshIcons();
			});
		}

		if (btnRefresh) {
			btnRefresh.addEventListener("click", () => this.refreshSources());
		}

		const activeTab = document.querySelector(
			".tab-btn.active",
		) as HTMLElement | null;
		if (activeTab) {
			window.addEventListener("resize", () => moveIndicator(activeTab));
		}

		setInterval(() => this.refreshSources(), 15000);
	}

	private setupQualityChangeListeners(): void {
		const selectRes = document.getElementById("select-resolution");
		const selectFps = document.getElementById("select-fps");
		const selectBitrate = document.getElementById("select-bitrate");
		const selectPriority = document.getElementById("select-priority");

		// Resolution or FPS changes require capturing a new video track
		const onTrackConfigChanged = async () => {
			const selectedSource = this.sourcePicker?.getSelectedSource();
			if (selectedSource) {
				console.log("[App] ⚡ Real-time resolution/FPS change requested...");
				await this.onSourceSelected(selectedSource);
			}
		};

		// Bitrate or Priority changes can be updated on the active RTCRtpSender immediately
		const onEncodingParamChanged = async () => {
			const qualityOptions = this.getQualityOptions();
			if (this.livekitPublisher.getIsConnected()) {
				console.log("[App] ⚡ Real-time bitrate/priority change requested...");
				await this.livekitPublisher.updateEncodingParameters(qualityOptions);
			}
		};

		selectRes?.addEventListener("change", onTrackConfigChanged);
		selectFps?.addEventListener("change", onTrackConfigChanged);
		selectBitrate?.addEventListener("change", onEncodingParamChanged);
		selectPriority?.addEventListener("change", onEncodingParamChanged);
	}

	private async refreshSources(): Promise<void> {
		if (window.api?.getAvailableSources) {
			const sources = await window.api.getAvailableSources();
			this.allSources = sources;
			this.sourcePicker?.setSources(sources);

			// Track selected source index
			const selected = this.sourcePicker?.getSelectedSource();
			if (selected) {
				this.selectedSourceIndex = sources.findIndex(
					(s) => s.id === selected.id,
				);
			}

			this.refreshIcons();

			// Report sources to Stream Deck
			if (window.api.reportSources) {
				window.api.reportSources(
					sources.map((s) => ({
						id: s.id,
						name: s.name,
						processName: s.processName,
						sourceType: s.sourceType,
						thumbnailUrl: s.thumbnailUrl,
					})),
					this.selectedSourceIndex,
				);
			}
		}
	}

	private getQualityOptions(): StreamQualityOptions {
		const selectRes =
			(document.getElementById("select-resolution") as HTMLSelectElement)
				?.value || "1080p";
		const selectFps = parseInt(
			(document.getElementById("select-fps") as HTMLSelectElement)?.value ||
				"60",
			10,
		);
		const selectBitrate = parseInt(
			(document.getElementById("select-bitrate") as HTMLSelectElement)?.value ||
				"4500",
			10,
		);
		const selectPriority = ((
			document.getElementById("select-priority") as HTMLSelectElement
		)?.value || "maintain-framerate") as any;

		const resMap: Record<string, { width: number; height: number }> = {
			"1080p": { width: 1920, height: 1080 },
			"720p": { width: 1280, height: 720 },
			"1440p": { width: 2560, height: 1440 },
			"4k": { width: 3840, height: 2160 },
			"480p": { width: 854, height: 480 },
		};

		const dim = resMap[selectRes] || { width: 1920, height: 1080 };

		return {
			resolution: selectRes as any,
			width: dim.width,
			height: dim.height,
			fps: selectFps,
			bitrateKbps: selectBitrate,
			degradationPreference: selectPriority,
		};
	}

	private async onSourceSelected(source: WindowSource): Promise<void> {
		console.log(`[App] Selected source: ${source.name} (ID: ${source.id})`);

		// Track selected source index
		this.selectedSourceIndex = this.allSources.findIndex(
			(s) => s.id === source.id,
		);

		this.checkCanStartStream();

		const quality = this.getQualityOptions();

		// Create video stream using WebRTC desktop capturer constraints
		try {
			if (this.previewStream) {
				this.previewStream.getTracks().forEach((t) => t.stop());
			}

			const stream = await (navigator.mediaDevices as any).getUserMedia({
				audio: false,
				video: {
					mandatory: {
						chromeMediaSource: "desktop",
						chromeMediaSourceId: source.id,
						minWidth: quality.width,
						maxWidth: quality.width,
						minHeight: quality.height,
						maxHeight: quality.height,
						minFrameRate: Math.min(30, quality.fps),
						maxFrameRate: quality.fps,
					},
				},
			});

			this.previewStream = stream;
			this.currentVideoTrack = stream.getVideoTracks()[0];

			// Set contentHint = 'detail' for maximum sharpness without blurriness on static text/UI
			if (this.currentVideoTrack && "contentHint" in this.currentVideoTrack) {
				(this.currentVideoTrack as any).contentHint = "detail";
			}

			const videoElem = document.getElementById(
				"preview-video",
			) as HTMLVideoElement;
			const placeholder = document.getElementById("preview-placeholder");

			if (videoElem && placeholder) {
				videoElem.srcObject = stream;
				placeholder.style.display = "none";
				videoElem.style.transform = "translateZ(0)";
			}

			// If already live, replace video track in real-time on LiveKit!
			if (this.livekitPublisher.getIsConnected() && this.currentVideoTrack) {
				console.log(
					"[App] ⚡ Live stream active! Updating video track & settings in real-time...",
				);
				await this.livekitPublisher.replaceVideoTrack(
					this.currentVideoTrack,
					quality,
				);

				// Update process audio target if process audio mode is active
				const audioMode = this.getSelectedAudioMode();
				if (audioMode === "process" && source.pid) {
					window.api.startAudioCapture({
						mode: "process",
						targetPid: source.pid,
						targetProcessName: source.processName,
					});
				}
			}
		} catch (err) {
			console.error("[App] Error creating video preview:", err);
		}
	}

	private checkCanStartStream(): void {
		const btnStart = document.getElementById(
			"btn-start-stream",
		) as HTMLButtonElement;
		const selectedSource = this.sourcePicker?.getSelectedSource();

		if (btnStart) {
			if (this.hasDeepLinkParams && selectedSource) {
				btnStart.disabled = false;
				btnStart.title = "Iniciar transmissão na sala do Discord";
			} else if (!this.hasDeepLinkParams) {
				btnStart.disabled = true;
				btnStart.title = "Aguardando vinculação com a Atividade do Discord";
			} else if (!selectedSource) {
				btnStart.disabled = true;
				btnStart.title = "Selecione uma janela antes de transmitir";
			}
		}
	}

	private setupAudioRadioListeners(): void {
		const radioCards = document.querySelectorAll(".radio-card");
		radioCards.forEach((card) => {
			card.addEventListener("click", async () => {
				radioCards.forEach((c) => c.classList.remove("active"));
				card.classList.add("active");
				const input = card.querySelector(
					'input[type="radio"]',
				) as HTMLInputElement;
				if (input) input.checked = true;

				// Report audio mode to Stream Deck
				if (window.api?.reportAudioMode) {
					window.api.reportAudioMode(this.getSelectedAudioMode());
				}

				// If streaming, update audio capture mode live
				if (this.livekitPublisher.getIsConnected()) {
					const selectedSource = this.sourcePicker?.getSelectedSource();
					const audioMode = this.getSelectedAudioMode();
					await window.api.startAudioCapture({
						mode: audioMode,
						targetPid: selectedSource?.pid,
						targetProcessName: selectedSource?.processName,
					});
				}
			});
		});
	}

	private setAudioMode(mode: AudioCaptureMode): void {
		const radioCards = document.querySelectorAll(".radio-card");
		radioCards.forEach((card) => {
			const input = card.querySelector(
				'input[type="radio"]',
			) as HTMLInputElement;
			if (input && input.value === mode) {
				card.classList.add("active");
				input.checked = true;
			} else {
				card.classList.remove("active");
			}
		});

		// If streaming, apply the change immediately
		if (this.livekitPublisher.getIsConnected()) {
			const selectedSource = this.sourcePicker?.getSelectedSource();
			window.api.startAudioCapture({
				mode,
				targetPid: selectedSource?.pid,
				targetProcessName: selectedSource?.processName,
			});
		}

		// Report to Stream Deck
		if (window.api?.reportAudioMode) {
			window.api.reportAudioMode(mode);
		}
	}

	private getSelectedAudioMode(): AudioCaptureMode {
		const selectedRadio = document.querySelector(
			'input[name="audioMode"]:checked',
		) as HTMLInputElement;
		return (selectedRadio?.value as AudioCaptureMode) || "process";
	}

	private setupStreamButtons(): void {
		const btnStart = document.getElementById("btn-start-stream");
		const btnStop = document.getElementById("btn-stop-stream");

		if (btnStart) {
			btnStart.addEventListener("click", () => this.startStreaming());
		}

		if (btnStop) {
			btnStop.addEventListener("click", () => this.stopStreaming());
		}
	}

	private async startStreaming(): Promise<void> {
		const selectedSource = this.sourcePicker?.getSelectedSource();
		if (!selectedSource || !this.currentVideoTrack) {
			alert("Selecione uma janela antes de iniciar a transmissão.");
			return;
		}

		const roomInput = document.getElementById("input-room") as HTMLInputElement;
		const identityInput = document.getElementById(
			"input-identity",
		) as HTMLInputElement;

		const roomName = roomInput?.value.trim() || "sala-shiro-default";
		const rawIdentity =
			identityInput?.value.trim() || `user-${Math.floor(Math.random() * 1000)}`;

		// Discord Activity expects identity ending with '-capture' to bind stream to participant
		const livekitIdentity = rawIdentity.endsWith("-capture")
			? rawIdentity
			: `${rawIdentity}-capture`;

		const audioMode = this.getSelectedAudioMode();
		const qualityOptions = this.getQualityOptions();

		console.log(
			`[App] 🚀 Starting Stream — Room: ${roomName}, Identity: ${livekitIdentity}, AudioMode: ${audioMode}`,
		);
		console.log("[App] Stream Quality Settings:", qualityOptions);

		setStreamStatus(false, "Conectando...");

		// 1. Initialize Audio Engine in Main Process if audio is enabled
		let audioTrack: MediaStreamTrack | null = null;
		if (audioMode !== "disabled") {
			const audioStatus = await window.api.startAudioCapture({
				mode: audioMode,
				targetPid: selectedSource.pid,
				targetProcessName: selectedSource.processName,
			});

			console.log("[App] Audio Capture Status:", audioStatus);

			// Initialize WebAudio pipeline to convert PCM array buffers into MediaStreamTrack
			audioTrack = this.audioPipeline.initialize();

			// Attach analyser to visualizer and start animating
			const analyser = this.audioPipeline.getAnalyser();
			if (analyser) {
				this.audioVisualizer.start(analyser);
				const vuStatus = document.getElementById("vu-status-text");
				if (vuStatus) {
					vuStatus.innerText = "Recebendo áudio nativo";
					vuStatus.style.color = "#10b981";
				}
			}
		}

		// 2. Fetch LiveKit Token from backend using formatted capture identity
		try {
			const defaultBackend = "https://shiro-webapp-backend.vercel.app/";
			const defaultLivekit = "wss://livekit.shirobot.xyz";

			const backendUrl =
				typeof process !== "undefined" && process.env?.BACKEND_URL
					? process.env.BACKEND_URL
					: defaultBackend;

			const livekitWsUrl =
				typeof process !== "undefined" && process.env?.LIVEKIT_URL
					? process.env.LIVEKIT_URL
					: defaultLivekit;

			console.log(
				`[App] Fetching LiveKit Token from ${backendUrl} for ${livekitIdentity}...`,
			);
			const token = await window.api.fetchLiveKitToken(
				backendUrl,
				roomName,
				livekitIdentity,
			);

			// 3. Connect & Publish to LiveKit Room
			await this.livekitPublisher.connectAndPublish({
				wsUrl: livekitWsUrl,
				token,
				videoTrack: this.currentVideoTrack,
				audioTrack: audioTrack,
				qualityOptions: qualityOptions,
				rawIdentity: rawIdentity,
				onDisconnected: () => {
					this.stopStreaming();
				},
			});

			setStreamStatus(true, "🔴 AO VIVO");
			if (window.api) window.api.reportStreamShareState(true);

			const btnStart = document.getElementById("btn-start-stream");
			const btnStop = document.getElementById("btn-stop-stream");
			if (btnStart && btnStop) {
				btnStart.classList.add("hidden");
				btnStop.classList.remove("hidden");
			}
		} catch (err: any) {
			console.error("[App] ❌ Error launching stream:", err);
			alert(`Erro ao iniciar transmissão: ${err.message}`);
			setStreamStatus(false, "Erro ao Conectar");
			if (window.api) window.api.reportStreamShareState(false);
			this.audioPipeline.stop();
		}
	}

	private stopStreaming(): void {
		console.log("[App] Stopping stream...");
		this.livekitPublisher.disconnect();
		this.audioPipeline.stop();
		this.audioVisualizer.stop();
		const vuStatus = document.getElementById("vu-status-text");
		if (vuStatus) {
			vuStatus.innerText = "Aguardando som...";
			vuStatus.style.color = "";
		}
		if (window.api) window.api.stopAudioCapture();
		setStreamStatus(false, "Desconectado");
		if (window.api) window.api.reportStreamShareState(false);

		const btnStart = document.getElementById("btn-start-stream");
		const btnStop = document.getElementById("btn-stop-stream");
		if (btnStart && btnStop) {
			btnStart.classList.remove("hidden");
			btnStop.classList.add("hidden");
		}
	}

	private setupStreamDeckBridge(): void {
		if (!window.api) return;

		// Toggle screen sharing
		window.api.onStreamDeckToggle(() => {
			console.log("[App] Stream Deck: toggle requested");
			if (this.livekitPublisher.getIsConnected()) {
				this.stopStreaming();
			} else {
				this.startStreaming();
			}
		});

		// Respond to state query
		window.api.onStreamDeckGetState(() => {
			window.api.reportStreamShareState(
				this.livekitPublisher.getIsConnected(),
			);
		});

		// Respond to source list query
		window.api.onStreamDeckGetSources(() => {
			window.api.respondSources(
				this.allSources.map((s) => ({
					id: s.id,
					name: s.name,
					processName: s.processName,
					sourceType: s.sourceType,
					thumbnailUrl: s.thumbnailUrl,
				})),
				this.selectedSourceIndex,
			);
		});

		// Select source by index
		window.api.onStreamDeckSelectSource((index: number) => {
			console.log(`[App] Stream Deck: select source index ${index}`);
			if (index >= 0 && index < this.allSources.length) {
				const source = this.allSources[index];
				this.sourcePicker?.setSelectedSource(source);
				this.onSourceSelected(source);
			}
		});

		// Cycle to next source
		window.api.onStreamDeckCycleSource(() => {
			console.log("[App] Stream Deck: cycle source");
			if (this.allSources.length === 0) return;
			const nextIndex =
				(this.selectedSourceIndex + 1) % this.allSources.length;
			const source = this.allSources[nextIndex];
			this.sourcePicker?.setSelectedSource(source);
			this.onSourceSelected(source);
		});

		// Respond to audio mode query
		window.api.onStreamDeckGetAudioMode(() => {
			window.api.respondAudioMode(this.getSelectedAudioMode());
		});

		// Set audio mode directly
		window.api.onStreamDeckSetAudioMode(
			(mode: "process" | "system" | "disabled") => {
				console.log(`[App] Stream Deck: set audio mode to ${mode}`);
				this.setAudioMode(mode);
			},
		);

		// Cycle audio mode: process -> system -> disabled -> process
		window.api.onStreamDeckCycleAudioMode(() => {
			console.log("[App] Stream Deck: cycle audio mode");
			const modes: AudioCaptureMode[] = ["process", "system", "disabled"];
			const current = this.getSelectedAudioMode();
			const currentIdx = modes.indexOf(current);
			const nextMode = modes[(currentIdx + 1) % modes.length];
			this.setAudioMode(nextMode);
		});

		// Launch activity (click the start button or simulate deep link)
		window.api.onStreamDeckLaunchActivity(() => {
			console.log("[App] Stream Deck: launch activity");
			const btnStart = document.getElementById(
				"btn-start-stream",
			) as HTMLButtonElement;
			if (btnStart && !btnStart.disabled) {
				btnStart.click();
			}
		});

		console.log("[App] Stream Deck bridge initialized");
	}

	private setupDeepLinkListener(): void {
		if (window.api?.onDeepLinkReceived) {
			window.api.onDeepLinkReceived((params: DeepLinkParams) => {
				console.log("[App] 🔗 Deep-link parameters received:", params);
				if (params.roomName) {
					const roomInput = document.getElementById(
						"input-room",
					) as HTMLInputElement;
					if (roomInput) roomInput.value = params.roomName;
				}
				if (params.identity || params.userName || params.userId) {
					const identityInput = document.getElementById(
						"input-identity",
					) as HTMLInputElement;
					const idVal =
						params.userId || params.identity || params.userName || "";
					if (identityInput) identityInput.value = idVal;
				}

				// Update Activity Status Banner
				this.hasDeepLinkParams = true;
				this.updateActivityBanner(params);
				this.checkCanStartStream();
			});
		}
	}

	private updateActivityBanner(_params: DeepLinkParams): void {
		const connTag = document.getElementById("connection-tag");
		if (connTag) {
			connTag.classList.remove("hidden");
			this.refreshIcons();
		}
	}
}

document.addEventListener("DOMContentLoaded", () => {
	const app = new ShiroApp();
	app.initialize();
});
