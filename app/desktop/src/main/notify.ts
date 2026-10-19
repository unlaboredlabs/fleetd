import { Notification } from "electron";
import type { NotifyRequest } from "../shared/app";
import type { Opener } from "./opener";

/**
 * Posts the renderer's notifications. When and what to notify is the renderer's call (it has the hub's
 * attention rules and the open asks); main only shows them and opens their target on a click.
 */
export class Notifier {
  // Held so the click handler outlives garbage collection (macOS otherwise drops it), one per tag.
  readonly #shown = new Map<string, Notification>();
  readonly #opener: Opener;

  constructor(opener: Opener) {
    this.#opener = opener;
  }

  show(request: NotifyRequest): void {
    if (!Notification.isSupported()) return;
    this.#shown.get(request.tag)?.close();
    const notification = new Notification({ title: request.title, body: request.body });
    notification.on("click", () => {
      this.#opener.open(request.target);
      this.#forget(request.tag, notification);
    });
    notification.on("close", () => this.#forget(request.tag, notification));
    this.#shown.set(request.tag, notification);
    notification.show();
  }

  #forget(tag: string, notification: Notification): void {
    if (this.#shown.get(tag) === notification) this.#shown.delete(tag);
  }
}
