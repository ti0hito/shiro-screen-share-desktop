import { Room, RoomEvent, Track } from "livekit-client";
import type { StreamQualityOptions } from "../../types/capture";

export interface LiveKitPublishOptions {
	wsUrl: string;
	token: string;
	videoTrack: MediaStreamTrack;
	audioTrack?: MediaStreamTrack | null;
	qualityOptions?: StreamQualityOptions;
	rawIdentity?: string;
	onDisconnected?: () => void;
}

export class LiveKitPublisher {
	private room: Room | null = null;
	private isConnected: boolean = false;

	public async connectAndPublish(
		options: LiveKitPublishOptions,
	): Promise<Room> {
		this.disconnect();

		this.room = new Room({
			adaptiveStream: false,
			dynacast: false,
			videoCaptureDefaults: {
				resolution: {
					width: options.qualityOptions?.width || 1920,
					height: options.qualityOptions?.height || 1080,
				},
			},
		});

		this.room.on(RoomEvent.Disconnected, (reason) => {
			console.log("[LiveKit] Disconnected from room:", reason);
			this.isConnected = false;
			if (options.onDisconnected) {
				options.onDisconnected();
			}
		});

		this.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
			const remainingCount = this.room?.remoteParticipants.size || 0;
			console.log(
				`[LiveKit] Participant disconnected: ${participant.identity}. Remaining remote: ${remainingCount}`,
			);

			const mainUser = options.rawIdentity
				? options.rawIdentity.replace("-capture", "")
				: "";
			const disconnectedUser = participant.identity
				? participant.identity.replace("-capture", "")
				: "";

			const isMainUser = mainUser && disconnectedUser === mainUser;

			if (isMainUser || remainingCount === 0) {
				console.log(
					"[LiveKit] 🛑 Main user or all participants left the activity. Auto-stopping stream...",
				);
				this.disconnect();
				if (options.onDisconnected) {
					options.onDisconnected();
				}
			}
		});

		console.log(`[LiveKit] Connecting to room ${options.wsUrl}...`);
		await this.room.connect(options.wsUrl, options.token);
		this.isConnected = true;
		console.log("[LiveKit] ✅ Connected to room successfully!");

		// Set contentHint to motion for fluid screen/game capture
		if (options.videoTrack && "contentHint" in options.videoTrack) {
			options.videoTrack.contentHint = "motion";
		}

		const maxBitrateBps = (options.qualityOptions?.bitrateKbps || 4500) * 1000;
		const maxFramerate = options.qualityOptions?.fps || 60;

		// Publish Screen Video Track
		if (options.videoTrack) {
			console.log(
				`[LiveKit] Publishing screen share video track (Bitrate: ${maxBitrateBps / 1000}Kbps, FPS: ${maxFramerate})...`,
			);
			const pub = await this.room.localParticipant.publishTrack(
				options.videoTrack,
				{
					name: "screen-video",
					source: Track.Source.ScreenShare,
					videoCodec: "vp8",
					simulcast: false,
					videoEncoding: {
						maxBitrate: maxBitrateBps,
						maxFramerate: maxFramerate,
					},
				},
			);

			// Apply real-time sender parameters for resolution preservation
			try {
				const sender = pub.track?.sender;
				if (sender && typeof sender.getParameters === "function") {
					const params = sender.getParameters();
					if (params && params.encodings) {
						params.encodings.forEach((enc) => {
							enc.maxBitrate = maxBitrateBps;
							enc.maxFramerate = maxFramerate;
							enc.scaleResolutionDownBy = 1.0;
							enc.priority = "high";
						});
						params.degradationPreference =
							options.qualityOptions?.degradationPreference ||
							"maintain-framerate";
						await sender.setParameters(params);
						console.log(
							"[LiveKit] ✅ RTCRtpSender parameters applied (maintain-framerate zero-delay):",
							params,
						);
					}
				}
			} catch (err) {
				console.warn("[LiveKit] Warning setting RTCRtpSender parameters:", err);
			}
		}

		// Publish Isolated Process Audio Track
		if (options.audioTrack) {
			console.log(
				"[LiveKit] Publishing isolated process audio track with zero DTX latency...",
			);
			await this.room.localParticipant.publishTrack(options.audioTrack, {
				name: "screen-audio",
				source: Track.Source.ScreenShareAudio,
				dtx: false,
				red: false,
			});
		}

		return this.room;
	}

	public disconnect(): void {
		if (this.room) {
			try {
				this.room.disconnect();
			} catch (err) {
				console.warn("[LiveKit] Warning during disconnect:", err);
			}
			this.room = null;
		}
		this.isConnected = false;
	}

	public getIsConnected(): boolean {
		return this.isConnected;
	}

	/**
	 * Dynamically replaces the published screen video track in real-time
	 */
	public async replaceVideoTrack(
		newTrack: MediaStreamTrack,
		qualityOptions: StreamQualityOptions,
	): Promise<void> {
		if (!this.room || !this.isConnected) return;

		if ("contentHint" in newTrack) {
			newTrack.contentHint = "detail";
		}

		const videoPub = Array.from(
			this.room.localParticipant.videoTrackPublications.values(),
		).find((pub) => pub.source === Track.Source.ScreenShare);

		if (videoPub?.track) {
			console.log(
				"[LiveKit] ⚡ Replacing screen share video track in real-time...",
			);
			await (videoPub.track as any).replaceTrack(newTrack);
			await this.updateEncodingParameters(qualityOptions);
			console.log(
				"[LiveKit] ✅ Video track replaced in real-time successfully!",
			);
		}
	}

	/**
	 * Dynamically updates live WebRTC encoding parameters (bitrate, FPS, priority)
	 */
	public async updateEncodingParameters(
		qualityOptions: StreamQualityOptions,
	): Promise<void> {
		if (!this.room || !this.isConnected) return;

		const videoPub = Array.from(
			this.room.localParticipant.videoTrackPublications.values(),
		).find((pub) => pub.source === Track.Source.ScreenShare);

		if (videoPub?.track) {
			try {
				const sender = videoPub.track.sender;
				if (sender && typeof sender.getParameters === "function") {
					const params = sender.getParameters();
					const maxBitrateBps = (qualityOptions.bitrateKbps || 4500) * 1000;
					const maxFramerate = qualityOptions.fps || 60;

					if (params?.encodings) {
						params.encodings.forEach((enc) => {
							enc.maxBitrate = maxBitrateBps;
							enc.maxFramerate = maxFramerate;
							enc.scaleResolutionDownBy = 1.0;
							enc.priority = "high";
						});
						params.degradationPreference =
							qualityOptions.degradationPreference || "maintain-resolution";
						await sender.setParameters(params);
						console.log(
							`[LiveKit] ⚡ Real-time parameters updated: ${qualityOptions.bitrateKbps}Kbps, ${maxFramerate}FPS, ${qualityOptions.degradationPreference}`,
						);
					}
				}
			} catch (err) {
				console.warn(
					"[LiveKit] Warning updating RTCRtpSender parameters:",
					err,
				);
			}
		}
	}
}
