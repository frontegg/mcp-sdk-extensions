import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;

function toBase64url(buffer: ArrayBuffer | Uint8Array): string {
  const buf = buffer instanceof ArrayBuffer
    ? Buffer.from(buffer)
    : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJson(obj: unknown): string {
  return toBase64url(Buffer.from(JSON.stringify(obj)));
}

export class DPoPHandler {
  private keyPair: CryptoKeyPair | null = null;
  private publicJwk: JsonWebKey | null = null;

  async init(privateJwk?: JsonWebKey): Promise<void> {
    if (privateJwk) {
      if (privateJwk.kty !== "EC" || privateJwk.crv !== "P-256") {
        throw new Error("DPoPHandler: key must be EC P-256");
      }
      const privateKey = await subtle.importKey(
        "jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"],
      );
      const publicJwk: JsonWebKey = { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y };
      const publicKey = await subtle.importKey(
        "jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"],
      );
      this.keyPair = { privateKey, publicKey } as CryptoKeyPair;
      this.publicJwk = publicJwk;
    } else {
      this.keyPair = await subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
      ) as CryptoKeyPair;
      const jwk = await subtle.exportKey("jwk", this.keyPair!.publicKey);
      this.publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    }
  }

  async createProof(htm: string, htu: string, accessToken?: string): Promise<string> {
    if (!this.keyPair || !this.publicJwk) throw new Error("DPoPHandler not initialized");

    const header = { typ: "dpop+jwt", alg: "ES256", jwk: this.publicJwk };
    const payload: Record<string, unknown> = {
      jti: toBase64url(webcrypto.getRandomValues(new Uint8Array(16))),
      htm: htm.toUpperCase(),
      htu,
      iat: Math.floor(Date.now() / 1000),
    };
    if (accessToken) {
      payload.ath = toBase64url(await subtle.digest("SHA-256", new TextEncoder().encode(accessToken)));
    }

    const signingInput = new TextEncoder().encode(`${encodeJson(header)}.${encodeJson(payload)}`);
    const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keyPair.privateKey, signingInput);
    return `${encodeJson(header)}.${encodeJson(payload)}.${toBase64url(sig)}`;
  }

  wrapFetch(accessToken?: string): typeof fetch {
    return async (input, init?) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
      const proof = await this.createProof((init?.method ?? "GET").toUpperCase(), `${url.origin}${url.pathname}`, accessToken);
      const headers = new Headers(init?.headers);
      headers.set("DPoP", proof);
      if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
      return fetch(input, { ...init, headers });
    };
  }
}
