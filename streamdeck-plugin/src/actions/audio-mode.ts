import streamDeck, {
	action,
	type KeyDownEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
	SingletonAction,
} from "@elgato/streamdeck";
import { getWsClient, type WsMessage, type AudioMode } from "../ws-client";

const MODE_LABELS: Record<AudioMode, string> = {
	process: "APP",
	system: "SYS",
	disabled: "MUTE",
};

const MODE_STATES: Record<AudioMode, number> = {
	process: 0,
	system: 1,
	disabled: 2,
};

@action({ UUID: "com.shiro.screenshare.audio-mode" })
export class AudioModeAction extends SingletonAction {
	private currentMode: AudioMode = "process";

	constructor() {
		super();
		const client = getWsClient();
		client.onMessage((msg: WsMessage) => {
			if (msg.type === "audio_mode_changed") {
				this.currentMode = msg.payload.mode;
				this.updateAllInstances();
			}
		});
	}

	private updateAllInstances(): void {
		const title = MODE_LABELS[this.currentMode] ?? "AUDIO";
		const stateIdx = MODE_STATES[this.currentMode] ?? 0;
		for (const act of (this.actions as any)) {
			if (act.isKey()) {
				act.setState(stateIdx);
				act.setTitle(title);
			}
		}
	}

	override onWillAppear(ev: WillAppearEvent): void {
		const client = getWsClient();
		client.send({ type: "get_audio_mode" });
		if (ev.action.isKey()) {
			ev.action.setTitle(MODE_LABELS[this.currentMode]);
			ev.action.setState(MODE_STATES[this.currentMode]);
		}
	}

	override onWillDisappear(_ev: WillDisappearEvent): void {}

	override onKeyDown(ev: KeyDownEvent): void | Promise<void> {
		const client = getWsClient();
		if (!client.isConnected) {
			ev.action.showAlert();
			return;
		}
		client.send({ type: "cycle_audio_mode" });
	}
}
