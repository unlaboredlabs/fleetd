import { Notification } from "electron";
import type { NotifyRequest } from "../shared/app";
import type { Opener } from "./opener";

/**
 * Posts the renderer's notifications. When and what to notify is the renderer's call (it has the hub's
 * attention rules and which projects still need you); main only shows them and opens their target on a click.
 */
export class Notifier {
  // Held so the click handler outlives garbage collection (macOS otherwise drops it), one per tag.
  readonly #shown = new Map<string, Notification>();
  readonly #opener: Opener;

  constructor(opener: Opener) {
    this.#opener = opener;
  }

  /** False when this system shows no notifications, so Settings' test can say so. */
  show(request: NotifyRequest): boolean {
    if (!Notification.isSupported()) return false;
    this.#shown.get(request.tag)?.close();
    const notification = new Notification({ title: request.title, body: request.body, silent: request.silent === true });
    notification.on("click", () => {
      this.#opener.open(request.target);
      this.#forget(request.tag, notification);
    });
    notification.on("close", () => this.#forget(request.tag, notification));
    this.#shown.set(request.tag, notification);
    notification.show();
    return true;
  }

  #forget(tag: string, notification: Notification): void {
    if (this.#shown.get(tag) === notification) this.#shown.delete(tag);
  }
}
