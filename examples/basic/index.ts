import http from 'node:http';
import { exec } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DPoPTransport } from '@frontegg/mcp-sdk-extensions';

const MCP_SERVER_URL = process.env.MCP_SERVER_URL!;
const PORT = Number(process.env.PORT ?? 3000);

async function main() {
	if (!MCP_SERVER_URL) throw new Error('MCP_SERVER_URL is required');

	const transport = new DPoPTransport(MCP_SERVER_URL, {
		clientMetadata: {
			client_name: 'Demo for DPoP',
			redirect_uris: [`http://localhost:${PORT}/callback`],
			...(process.env.OAUTH_CLIENT_ID && { client_id: process.env.OAUTH_CLIENT_ID }),
		},
		privateJwk: process.env.DPOP_PRIVATE_JWK ? JSON.parse(process.env.DPOP_PRIVATE_JWK) : undefined,
		onAuthorizationUrl: openBrowserAndWaitForCallback,
	});

	const client = new Client({ name: 'demo-agent', version: '1.0.0' });
	await client.connect(transport);

	try {
		const { tools } = await client.listTools();
		console.log(
			'Available tools:',
			tools.map((t) => t.name),
		);

		if (tools.length) {
			const result = await client.callTool({
				name: tools[0].name,
				arguments: {},
			});
			console.log('Result:', JSON.stringify(result.content, null, 2));
		}
	} finally {
		await client.close();
	}
}

// ─── CLI OAuth callback helper ──────────────────────────────────────────────

function openBrowserAndWaitForCallback(authUrl: URL): Promise<string> {
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const url = new URL(req.url!, `http://localhost:${PORT}`);
			if (!url.pathname.endsWith('/callback')) return;

			const error = url.searchParams.get('error');
			const code = url.searchParams.get('code');

			res.writeHead(200, { 'Content-Type': 'text/html' });
			if (error || !code) {
				res.end('<h1>Authorization failed</h1><p>You can close this tab.</p>');
				server.close();
				reject(new Error(`OAuth error: ${error ?? 'missing code'}`));
				return;
			}

			res.end('<h1>Authorized</h1><p>You can close this tab.</p>');
			server.close();
			resolve(code);
		});

		server.listen(PORT, () => {
			console.log(`\nOpen this URL to authorize:\n\n  ${authUrl}\n`);
			const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
			exec(`${cmd} "${authUrl}"`);
		});
	});
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
