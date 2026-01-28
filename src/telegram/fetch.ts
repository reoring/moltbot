import * as net from "node:net";
import process from "node:process";

import { Agent } from "undici";

import { resolveFetch } from "../infra/fetch.js";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveTelegramAutoSelectFamilyDecision } from "./network-config.js";

let appliedAutoSelectFamily: boolean | null = null;
const log = createSubsystemLogger("telegram/network");

const IPV4_AGENT = new Agent({
  connect: {
    family: 4,
  },
});

// Node 22 workaround: disable autoSelectFamily to avoid Happy Eyeballs timeouts.
// See: https://github.com/nodejs/node/issues/54359
function applyTelegramNetworkWorkarounds(network?: TelegramNetworkConfig): void {
  const decision = resolveTelegramAutoSelectFamilyDecision({ network });
  if (decision.value === null || decision.value === appliedAutoSelectFamily) return;
  appliedAutoSelectFamily = decision.value;

  if (typeof net.setDefaultAutoSelectFamily === "function") {
    try {
      net.setDefaultAutoSelectFamily(decision.value);
      const label = decision.source ? ` (${decision.source})` : "";
      log.info(`telegram: autoSelectFamily=${decision.value}${label}`);
    } catch {
      // ignore if unsupported by the runtime
    }
  }
}

function shouldForceTelegramIpv4(
  network?: TelegramNetworkConfig,
  env?: NodeJS.ProcessEnv,
): boolean {
  const e = env ?? process.env;
  const envForce = e.MOLTBOT_TELEGRAM_FORCE_IPV4 ?? e.CLAWDBOT_TELEGRAM_FORCE_IPV4;
  if (envForce && envForce !== "0" && envForce.toLowerCase() !== "false") return true;

  const envDisable = e.MOLTBOT_TELEGRAM_NO_FORCE_IPV4 ?? e.CLAWDBOT_TELEGRAM_NO_FORCE_IPV4;
  if (envDisable && envDisable !== "0" && envDisable.toLowerCase() !== "false") return false;

  if (typeof network?.forceIpv4 === "boolean") return network.forceIpv4;

  // Default: force IPv4 on macOS where IPv6 is commonly broken in VM setups.
  return process.platform === "darwin";
}

function forceIpv4Fetch(input: RequestInfo | URL, init?: RequestInit): ReturnType<typeof fetch> {
  const base = init ? { ...init } : {};
  // Node's fetch is undici-backed and honors dispatcher per-request.
  return fetch(input, { ...base, dispatcher: IPV4_AGENT } as RequestInit);
}

// Prefer wrapped fetch when available to normalize AbortSignal across runtimes.
export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
  options?: { network?: TelegramNetworkConfig },
): typeof fetch | undefined {
  applyTelegramNetworkWorkarounds(options?.network);
  if (proxyFetch) return resolveFetch(proxyFetch);
  const fetchImpl = shouldForceTelegramIpv4(options?.network)
    ? resolveFetch(forceIpv4Fetch)
    : resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }
  return fetchImpl;
}
