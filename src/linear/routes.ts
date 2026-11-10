import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import express from "express";
import { log } from "../log";
import type { LinearConfig } from "../config";
import type { LinearClient } from "./client";

export const EVENTS_PATH = join(homedir(), ".cache", "slack-to-laptop", "linear-events.jsonl");
const SCOPES = "read,write,app:assignable,app:mentionable,initiative:read,initiative:write";
const MAX_SKEW_MS = 60_000;

export function verifySignature(secret: string, rawBody: Buffer, signature: string | undefined) {
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(signature ?? "", "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export type LinearEventHandler = (event: Record<string, unknown>, eventType: string) => Promise<void>;

/**
 * Everything under /linear is reachable from the internet (Tailscale Funnel
 * forwards that path only), so nothing there acts before the signature or the
 * OAuth state is checked. /install/linear stays outside it: localhost only.
 * Must be mounted BEFORE express.json() — the signature covers the raw bytes.
 */
export function mountLinear(
  app: express.Express,
  config: LinearConfig,
  client: LinearClient,
  onEvent: LinearEventHandler,
  capturePath = EVENTS_PATH,
) {
  const redirectUri = `${config.publicUrl}/linear/oauth/callback`;
  const pendingStates = new Map<string, number>();
  const seenDeliveries = new Map<string, number>();
  setInterval(() => {
    const cutoff = Date.now() - 24 * 3600_000;
    for (const [id, at] of seenDeliveries) if (at < cutoff) seenDeliveries.delete(id);
  }, 3600_000).unref();

  app.get("/install/linear", (_req, res) => {
    const state = randomBytes(24).toString("hex");
    pendingStates.set(state, Date.now());
    const url = new URL("https://linear.app/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES,
      actor: "app",
      prompt: "consent",
      state,
    }).toString();
    res.redirect(url.toString());
  });

  app.get("/linear/oauth/callback", async (req, res) => {
    const state = String(req.query.state ?? "");
    const issuedAt = pendingStates.get(state);
    pendingStates.delete(state);
    if (!issuedAt || Date.now() - issuedAt > 10 * 60_000) {
      res.status(400).send("Unknown or expired state — start again from /install/linear on the laptop.");
      return;
    }
    if (typeof req.query.code !== "string") {
      res.status(400).send(`Linear returned no code: ${String(req.query.error ?? "unknown error")}`);
      return;
    }
    try {
      await client.exchangeCode(req.query.code, redirectUri);
      log("linear: app installed, token stored");
      res.send("Laptop is installed in Linear. You can close this tab.");
    } catch (err) {
      log(`linear: code exchange failed: ${err}`);
      res.status(500).send("Token exchange failed — see the bridge log.");
    }
  });

  app.post("/linear/webhook", express.raw({ type: "*/*", limit: "2mb" }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifySignature(config.webhookSecret, raw, req.get("linear-signature"))) {
      log("linear: webhook rejected (bad signature)");
      res.sendStatus(401);
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      res.sendStatus(400);
      return;
    }
    const sentAt = Number(event.webhookTimestamp);
    if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > MAX_SKEW_MS) {
      log("linear: webhook rejected (stale timestamp)");
      res.sendStatus(401);
      return;
    }
    // Linear wants a 200 within 5s; the work happens after the ack.
    res.sendStatus(200);

    const delivery = req.get("linear-delivery") ?? "";
    if (delivery && seenDeliveries.has(delivery)) {
      log(`linear: dropping redelivered ${delivery}`);
      return;
    }
    if (delivery) seenDeliveries.set(delivery, Date.now());

    const eventType = req.get("linear-event") ?? String(event.type ?? "?");
    log(`linear: event ${eventType}/${String(event.action ?? "?")} delivery=${delivery}`);
    try {
      appendFileSync(capturePath, `${JSON.stringify({ receivedAt: Date.now(), eventType, delivery, event })}\n`, {
        mode: 0o600,
      });
    } catch (err) {
      log(`linear: event capture failed: ${err}`);
    }
    void onEvent(event, eventType).catch((err) => log(`linear: handler failed for ${eventType}: ${err}`));
  });
}
