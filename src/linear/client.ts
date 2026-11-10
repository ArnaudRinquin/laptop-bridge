import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../log";
import type { LinearConfig } from "../config";

export const TOKEN_PATH = join(homedir(), ".config", "slack-trigger", "linear-token.json");
const TOKEN_URL = "https://api.linear.app/oauth/token";
const GRAPHQL_URL = "https://api.linear.app/graphql";

interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  /** Unix ms. Access tokens last 24h; the refresh token rotates on every use. */
  expiresAt: number;
  scope?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** App-actor token for the personal workspace, with refresh. Never logged. */
export class LinearClient {
  private token: StoredToken | undefined;
  private refreshing: Promise<void> | undefined;

  constructor(
    private config: LinearConfig,
    private tokenPath = TOKEN_PATH,
  ) {
    try {
      this.token = JSON.parse(readFileSync(tokenPath, "utf8"));
    } catch {
      // not installed yet
    }
  }

  get installed() {
    return Boolean(this.token);
  }

  async exchangeCode(code: string, redirectUri: string) {
    this.store(
      await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    );
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (!this.token) throw new Error("Linear app not installed — open /install/linear on the bridge");
    if (Date.now() > this.token.expiresAt - 5 * 60_000) await this.refresh();
    let res = await this.post(query, variables);
    if (res.status === 401) {
      await this.refresh();
      res = await this.post(query, variables);
    }
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || body.errors?.length) {
      throw new Error(`linear graphql ${res.status}: ${body.errors?.map((e) => e.message).join("; ") ?? "no detail"}`);
    }
    return body.data as T;
  }

  private post(query: string, variables: Record<string, unknown>) {
    return fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token!.accessToken}` },
      body: JSON.stringify({ query, variables }),
    });
  }

  private refresh() {
    this.refreshing ??= (async () => {
      try {
        if (!this.token?.refreshToken) throw new Error("no refresh token — reinstall via /install/linear");
        this.store(await this.tokenRequest({ grant_type: "refresh_token", refresh_token: this.token.refreshToken }));
        log("linear: access token refreshed");
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...params,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
    });
    const body = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(`linear token ${res.status}: ${body.error ?? "?"} ${body.error_description ?? ""}`);
    }
    return body;
  }

  private store(t: TokenResponse) {
    this.token = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? this.token?.refreshToken,
      expiresAt: Date.now() + (t.expires_in ?? 24 * 3600) * 1000,
      scope: t.scope,
    };
    mkdirSync(dirname(this.tokenPath), { recursive: true });
    const tmp = `${this.tokenPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.token), { mode: 0o600 });
    renameSync(tmp, this.tokenPath);
    chmodSync(this.tokenPath, 0o600);
  }
}
