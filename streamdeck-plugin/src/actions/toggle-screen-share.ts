import streamDeck, {
	action,
	type KeyDownEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
	SingletonAction,
} from "@elgato/streamdeck";
import { getWsClient, type WsMessage } from "../ws-client";

@action({ UUID: "com.shiro.screenshare.toggle" })
export class ToggleScreenShareAction extends SingletonAction {
	private isSharing = false;

	constructor() {
		super();
		const client = getWsClient();
		client.onMessage((msg: WsMessage) => {
			if (msg.type === "state_changed") {
				this.isSharing = msg.payload.isSharing;
				this.updateAllInstances();
			}
		});
	}

	private updateAllInstances(): void {
		const stateIndex = this.isSharing ? 0 : 1;
		const title = this.isSharing ? "SHARING" : "START";
		this.actions.forEach((act: any) => {
			act.setState(stateIndex);
			act.setTitle(title);
		});
	}

	override onWillAppear(ev: WillAppearEvent): void {
		const stateIndex = this.isSharing ? 0 : 1;
		const title = this.isSharing ? "SHARING" : "START";
		if (ev.action.isKey()) {
			ev.action.setState(stateIndex);
			ev.action.setTitle(title);
		}
	}

	override onWillDisappear(_ev: WillDisappearEvent): void {}

	override onKeyDown(ev: KeyDownEvent): void | Promise<void> {
		const client = getWsClient();
		if (!client.isConnected) {
			ev.action.showAlert();
			return;
		}
		client.send({ type: "toggle" });
	}
}
