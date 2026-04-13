# @frontegg/mcp-sdk-extensions

DPoP transport for the [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk). Drop-in replacement for `StreamableHTTPClientTransport` that adds [DPoP](https://datatracker.ietf.org/doc/html/rfc9449) proof-of-possession and handles the OAuth authorization code flow.

## Install

```bash
npm install @frontegg/mcp-sdk-extensions @modelcontextprotocol/sdk
```

## Usage

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DPoPTransport } from '@frontegg/mcp-sdk-extensions';

const transport = new DPoPTransport('https://your-app.mcp-gw.frontegg.com', {
	clientMetadata: {
		client_name: 'my-app',
		redirect_uris: ['http://localhost:3000/callback'],
		grant_types: ['authorization_code'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none',
	},
	onAuthorizationUrl: async (url) => {
		// Open the browser, start a callback server, return the authorization code.
		// This is entirely up to you — the transport doesn't assume a runtime.
	},
});

const client = new Client({ name: 'my-app', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(tools);
```

## How it works

When `client.connect(transport)` is called, `DPoPTransport.start()` runs the following sequence before any MCP messages are sent:

1. **Key generation** — generates an ephemeral ES256 key pair (or imports one you provide).
2. **OAuth discovery** — fetches `/.well-known/oauth-authorization-server` from the MCP server to find the real authorization server and token endpoint.
3. **Client registration** — if no `clientId` is provided, registers dynamically via [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591) (DCR).
4. **Authorization** — calls your `onAuthorizationUrl` callback with the authorization URL and waits for you to return the authorization code.
5. **Token exchange** — exchanges the code for tokens, attaching a DPoP proof to the token request.
6. **Connect** — creates an inner `StreamableHTTPClientTransport` with a `fetch` wrapper that attaches a DPoP proof and `Authorization: Bearer` header to every MCP request.

After `start()` completes, all MCP operations (`listTools`, `callTool`, etc.) are authenticated with DPoP-bound tokens.

## API

### `new DPoPTransport(serverUrl, options)`

| Parameter                    | Type                                           | Description                                                                                                                                                                               |
| ---------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serverUrl`                  | `string`                                       | MCP server URL                                                                                                                                                                            |
| `options.clientMetadata`     | `OAuthClientMetadata & { client_id?: string }` | OAuth client metadata. `redirect_uris` is required. Include `client_id` to skip DCR. Uses the SDK's [`OAuthClientMetadata`](https://github.com/modelcontextprotocol/typescript-sdk) type. |
| `options.onAuthorizationUrl` | `(url: URL) => Promise<string>`                | Called when authorization is needed. Receives the auth URL, must return the authorization code.                                                                                           |
| `options.privateJwk`         | `JsonWebKey?`                                  | ES256 private key as JWK. Omit to generate an ephemeral key per session.                                                                                                                  |

### Implements `Transport`

`DPoPTransport` implements the MCP SDK's `Transport` interface (`start`, `send`, `close`, `onmessage`, `onerror`, `onclose`), so it works anywhere the SDK expects a transport.

## Examples

Self-contained examples with their own `package.json`:

- **[`examples/basic`](./examples/basic)** — CLI MCP client that lists and calls tools.
- **[`examples/langchain`](./examples/langchain)** — LangChain agent that uses MCP tools via DPoP.

To run an example:

```bash
cd examples/basic
cp .env.example .env   # fill in your values
npm install
npm run dev
```

## Requirements

- Node.js >= 22
- `@modelcontextprotocol/sdk` >= 1.20.0
