import { Notice, Platform, Plugin } from "obsidian";

/**
 * ステータス表示。デスクトップはステータスバー、
 * モバイルは長時間処理のみ Notice（進捗を上書き更新）。
 */
export class StatusDisplay {
	private el: HTMLElement | null = null;
	private progressNotice: Notice | null = null;

	constructor(plugin: Plugin) {
		if (!Platform.isMobile) {
			this.el = plugin.addStatusBarItem();
			this.set("");
		}
	}

	set(text: string): void {
		if (this.el) this.el.setText(text ? `GDSync: ${text}` : "");
	}

	/** 長時間処理の進捗。モバイルでは Notice を使い回して更新 */
	progress(text: string): void {
		this.set(text);
		if (Platform.isMobile) {
			if (!this.progressNotice) {
				this.progressNotice = new Notice(`GDSync: ${text}`, 0);
			} else {
				this.progressNotice.setMessage(`GDSync: ${text}`);
			}
		}
	}

	endProgress(finalText?: string): void {
		this.set("");
		if (this.progressNotice) {
			this.progressNotice.hide();
			this.progressNotice = null;
		}
		if (finalText) new Notice(`GDSync: ${finalText}`);
	}
}
