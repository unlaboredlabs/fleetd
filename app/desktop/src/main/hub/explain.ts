// Why the hub link failed, in plain words with what to do about it. A WebSocket only reports a close code (1006 for
// nearly everything), so the cause comes from the socket error that preceded the close.

/** The socket error behind a close: Node's error code (ECONNREFUSED, CERT_HAS_EXPIRED…) and message. */
export interface SocketError {
  readonly code?: string | undefined;
  readonly message: string;
}

export interface Loss {
  /** One sentence, no final period (other screens append their own punctuation). */
  readonly reason: string;
  readonly fix: string;
}

/** `host:port` from the hub address, as people typed it. */
export const hubHost = (hub: string): string => {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(hub) ? hub : `http://${hub}`);
    return url.host;
  } catch {
    return hub;
  }
};

/** A tailnet address (Tailscale's 100.64.0.0/10 or a *.ts.net name): reaching it needs Tailscale up here. */
const onTailnet = (host: string): boolean => {
  const name = host.replace(/:\d+$/u, "").replace(/^\[|\]$/gu, "");
  if (name.endsWith(".ts.net")) return true;
  const v4 = /^100\.(\d+)\.\d+\.\d+$/u.exec(name);
  return v4?.[1] !== undefined && Number(v4[1]) >= 64 && Number(v4[1]) <= 127;
};

const RECONNECTS = "The app reconnects by itself.";

const unreachable = (host: string, cause: string): Loss => ({
  reason: `${host} doesn't answer (${cause})`,
  fix: onTailnet(host)
    ? "Check Tailscale is connected on this computer and on the hub's machine, and that the machine is awake."
    : "Check the hub's machine is on and awake, and that this computer is on a network that can reach it.",
});

const TLS = /^(CERT_|ERR_TLS_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_(GET|VERIFY)_|EPROTO$)/u;

/** From the socket error, or the close code when there was none. `wasOpen`: the link had connected first. */
export const explainLoss = (hub: string, code: number, reason: string, error: SocketError | undefined, wasOpen: boolean): Loss => {
  const host = hubHost(hub);
  const errCode = error?.code ?? "";
  switch (errCode) {
    case "ECONNREFUSED":
      return {
        reason: `Nothing is listening at ${host}`,
        fix: "Start the hub on that machine (`fleetd doctor` there says why it's down), or check the address and port.",
      };
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "EAI_NONAME":
      return {
        reason: `${host.replace(/:\d+$/u, "")} can't be found`,
        fix: onTailnet(host)
          ? "Check Tailscale is connected on this computer; tailnet names only resolve while it is."
          : "Check the hub address for typos, and that this computer is on the same network as the hub.",
      };
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EHOSTDOWN":
      return unreachable(host, errCode === "ETIMEDOUT" ? "timed out" : "no route to it");
    case "ECONNRESET":
    case "EPIPE":
      return {
        reason: `${host} cut the connection`,
        fix: `The hub may have restarted, or a proxy or firewall is dropping it. ${RECONNECTS}`,
      };
  }
  if (TLS.test(errCode)) {
    return {
      reason: `The secure connection to ${host} failed (${error?.message ?? errCode})`,
      fix: "If the hub serves plain HTTP, use an http:// address. Otherwise its certificate isn't one this computer trusts.",
    };
  }
  const status = /Unexpected server response: (\d+)/u.exec(error?.message ?? "")?.[1];
  if (status !== undefined) {
    return status.startsWith("5")
      ? { reason: `${host} answered with a server error (HTTP ${status})`, fix: "A proxy in front of the hub may be down. Run `fleetd doctor` on the hub." }
      : {
          reason: `${host} answered, but not as a fleetd hub (HTTP ${status})`,
          fix: "Check the address and port. If it is your hub, update it with `fleetd update` on that machine.",
        };
  }
  if (/handshake has timed out/iu.test(error?.message ?? "")) return unreachable(host, "timed out");
  if (reason !== "") return { reason: `The hub closed the connection: ${reason.replace(/\.$/u, "")}`, fix: RECONNECTS };
  switch (code) {
    case 1001:
      return { reason: "The hub is restarting or shutting down", fix: `${RECONNECTS} If it doesn't come back, run \`fleetd doctor\` on the hub.` };
    case 1011:
      return { reason: "The hub hit an internal error", fix: "Run `fleetd doctor` on the hub; its log has the details." };
  }
  if (wasOpen) return { reason: `The connection to ${host} dropped`, fix: `The hub may have restarted, or the network changed. ${RECONNECTS}` };
  if (error !== undefined) return { reason: `Can't connect to ${host}: ${error.message.replace(/\.$/u, "")}`, fix: "Check the hub is running (`fleetd doctor` on the hub) and the address is right." };
  return { reason: `The connection to ${host} ended`, fix: RECONNECTS };
};

/** The app gave up on a link itself: the hub never finished connecting, or went silent. */
export const explainAbandon = (hub: string, why: "not-ready" | "silent"): Loss => {
  const host = hubHost(hub);
  return why === "not-ready"
    ? {
        reason: `${host} accepted the connection but never finished it`,
        fix: "Check the address is your fleetd hub's (not another service on that port), and update the hub with `fleetd update` if it's old.",
      }
    : {
        reason: `${host} stopped answering`,
        fix: onTailnet(host)
          ? `The hub's machine may be asleep, or Tailscale dropped. ${RECONNECTS}`
          : `The hub's machine may be asleep or off the network. ${RECONNECTS}`,
      };
};
