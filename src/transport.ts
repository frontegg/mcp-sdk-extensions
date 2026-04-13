import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { DPoPHandler } from "./dpop.js";

// ─── Public API ──────────────────────────────────────────────────────────────

export type DPoPTransportOptions = {
  /** OAuth redirect URL for the callback */
  redirectUrl: string;
  /**
   * Called when the user needs to authorize. Receives the authorization URL.
   * Must return a promise that resolves with the authorization code.
   */
  onAuthorizationUrl: (url: URL) => Promise<string>;
  /** OAuth client ID (omit for Dynamic Client Registration) */
  clientId?: string;
  /** ES256 private JWK (omit to generate ephemeral key) */
  privateJwk?: JsonWebKey;
};

/**
 * MCP transport with DPoP + OAuth support.
 * Drop-in replacement for StreamableHTTPClientTransport.
 *
 * ```ts
 * import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 * import { DPoPTransport } from "@anthropic/mcp-dpop";
 *
 * const transport = new DPoPTransport("https://mcp.example.com", {
 *   redirectUrl: "http://localhost:3000/callback",
 *   onAuthorizationUrl: async (url) => {
 *     // open browser, wait for callback, return the authorization code
 *   },
 * });
 * const client = new Client({ name: "my-app", version: "1.0.0" });
 * await client.connect(transport);
 * ```
 */
export class DPoPTransport implements Transport {
  private readonly _serverUrl: string;
  private readonly _options: DPoPTransportOptions;
  private _inner?: StreamableHTTPClientTransport;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(serverUrl: string, options: DPoPTransportOptions) {
    this._serverUrl = serverUrl;
    this._options = options;
  }

  async start(): Promise<void> {
    const [dpop, realTokenEndpoint] = await Promise.all([
      initHandler(this._options.privateJwk),
      discoverTokenEndpoint(this._serverUrl),
    ]);

    const provider = new DPoPOAuthProvider(
      dpop, this._options.redirectUrl, realTokenEndpoint,
      this._options.onAuthorizationUrl, this._options.clientId,
    );

    const result = await auth(provider, { serverUrl: this._serverUrl });
    if (result === "REDIRECT") {
      const code = provider.getAuthorizationCode();
      if (!code) throw new Error("OAuth redirect completed but no authorization code received");

      const exchangeResult = await auth(provider, { serverUrl: this._serverUrl, authorizationCode: code });
      if (exchangeResult !== "AUTHORIZED") throw new Error("OAuth token exchange failed");
    }

    this._inner = new StreamableHTTPClientTransport(new URL(this._serverUrl), {
      fetch: dpop.wrapFetch(provider.getAccessToken()),
    });
    this._inner.onclose = () => this.onclose?.();
    this._inner.onerror = (err) => this.onerror?.(err);
    this._inner.onmessage = (msg) => this.onmessage?.(msg);

    return this._inner.start();
  }

  async send(message: JSONRPCMessage | JSONRPCMessage[]): Promise<void> {
    if (!this._inner) throw new Error("Transport not started");
    return this._inner.send(message);
  }

  async close(): Promise<void> {
    return this._inner?.close();
  }
}

// ─── DPoP OAuth Provider (internal) ─────────────────────────────────────────

class DPoPOAuthProvider implements OAuthClientProvider {
  private readonly _dpop: DPoPHandler;
  private readonly _redirectUrl: string;
  private readonly _clientMetadataValue: OAuthClientMetadata;
  private readonly _realTokenEndpoint: string;
  private readonly _onAuthorizationUrl: (url: URL) => Promise<string>;

  private _tokens?: OAuthTokens;
  private _codeVerifier?: string;
  private _clientInfo?: OAuthClientInformationMixed;
  private _authorizationCode?: string;

  constructor(
    dpop: DPoPHandler,
    redirectUrl: string,
    realTokenEndpoint: string,
    onAuthorizationUrl: (url: URL) => Promise<string>,
    clientId?: string,
  ) {
    this._dpop = dpop;
    this._redirectUrl = redirectUrl;
    this._realTokenEndpoint = realTokenEndpoint;
    this._onAuthorizationUrl = onAuthorizationUrl;
    this._clientMetadataValue = {
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    if (clientId) this._clientInfo = { client_id: clientId };
    this.addClientAuthentication = this.addClientAuthentication.bind(this);
    this.redirectToAuthorization = this.redirectToAuthorization.bind(this);
  }

  get redirectUrl() { return this._redirectUrl; }
  get clientMetadata() { return this._clientMetadataValue; }

  clientInformation() { return this._clientInfo; }
  saveClientInformation(info: OAuthClientInformationMixed) { this._clientInfo = info; }

  tokens() { return this._tokens; }
  saveTokens(tokens: OAuthTokens) { this._tokens = tokens; }

  saveCodeVerifier(cv: string) { this._codeVerifier = cv; }
  codeVerifier() {
    if (!this._codeVerifier) throw new Error("no code verifier");
    return this._codeVerifier;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this._authorizationCode = await this._onAuthorizationUrl(url);
  }

  async addClientAuthentication(headers: Headers, _params: URLSearchParams, _url: string | URL): Promise<void> {
    const proof = await this._dpop.createProof("POST", this._realTokenEndpoint);
    headers.set("DPoP", proof);
  }

  getAuthorizationCode(): string | undefined { return this._authorizationCode; }
  getAccessToken(): string | undefined { return this._tokens?.access_token; }
}

// ─── Internals ──────────────────────────────────────────────────────────────

async function initHandler(privateJwk?: JsonWebKey): Promise<DPoPHandler> {
  const h = new DPoPHandler();
  await h.init(privateJwk);
  return h;
}

async function discoverTokenEndpoint(mcpServerUrl: string): Promise<string> {
  const res = await fetch(`${mcpServerUrl}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`OAuth discovery failed: ${res.status}`);
  const meta = await res.json() as { issuer: string };
  return `${meta.issuer}/oauth/token`;
}
