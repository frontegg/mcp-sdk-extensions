import http from 'node:http';
import { exec } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { ChatOpenAI } from '@langchain/openai';
import { createAgent } from 'langchain';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { DPoPTransport } from '@frontegg/mcp-sdk-extensions';

const MCP_SERVER_URL = process.env.MCP_SERVER_URL!;
const PORT = Number(process.env.PORT ?? 3000);

async function main() {
	if (!MCP_SERVER_URL) throw new Error('MCP_SERVER_URL is required');
	if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');

	const transport = new DPoPTransport(MCP_SERVER_URL, {
		clientMetadata: {
			client_name: 'LangChain DPoP Agent',
			redirect_uris: [`http://localhost:${PORT}/callback`],
			...(process.env.OAUTH_CLIENT_ID && { client_id: process.env.OAUTH_CLIENT_ID }),
		},
		privateJwk: process.env.DPOP_PRIVATE_JWK ? JSON.parse(process.env.DPOP_PRIVATE_JWK) : undefined,
		onAuthorizationUrl: openBrowserAndWaitForCallback,
	});

	const client = new Client({ name: 'demo-agent-langchain', version: '1.0.0' });
	await client.connect(transport);

	try {
		const { tools: mcpTools } = await client.listTools();
		console.log(
			'MCP tools:',
			mcpTools.map((t) => t.name),
		);

		const tools = mcpTools.map((t) => toLangChainTool(t, client));

		const model = new ChatOpenAI({
			model: process.env.OPENAI_MODEL ?? 'gpt-4o',
			apiKey: process.env.OPENAI_API_KEY,
		});
		const agent = createAgent({ model, tools });

		const query = process.argv[2] ?? 'List all expenses';
		console.log(`\nQuery: ${query}\n`);

		const result = await agent.invoke({
			messages: [{ role: 'user', content: query }],
		});
		const lastMessage = result.messages[result.messages.length - 1];
		console.log('Answer:', lastMessage.content);
	} finally {
		await client.close();
	}
}

// ─── MCP → LangChain tool conversion ────────────────────────────────────────

function toLangChainTool(mcpTool: McpTool, client: Client): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: mcpTool.name,
		description: mcpTool.description ?? '',
		schema: jsonSchemaToZod(mcpTool.inputSchema as Record<string, unknown>),
		func: async (args: Record<string, unknown>) => {
			const result = await client.callTool({
				name: mcpTool.name,
				arguments: args,
			});
			return JSON.stringify(result.content);
		},
	});
}

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodObject<z.core.$ZodLooseShape> {
	const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
	const required = new Set((schema.required ?? []) as string[]);
	const shape: Record<string, z.ZodType> = {};

	for (const [key, prop] of Object.entries(properties)) {
		let field: z.ZodType;
		switch (prop.type) {
			case 'string':
				field = z.string();
				break;
			case 'number':
			case 'integer':
				field = z.number();
				break;
			case 'boolean':
				field = z.boolean();
				break;
			default:
				field = z.any();
				break;
		}
		if (typeof prop.description === 'string') field = field.describe(prop.description);
		if (!required.has(key)) field = field.optional();
		shape[key] = field;
	}

	return z.object(shape);
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
