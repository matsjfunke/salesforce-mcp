import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import express, { Request, Response, NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import jsforce from "jsforce";
import { z } from "zod";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Store transports by session ID
const streamableTransports: Record<string, StreamableHTTPServerTransport> = {};

// Store current request's auth token
let currentRequestToken: string | undefined;

// Validate token
async function validateToken(token: string): Promise<boolean> {
  try {
    const conn = new jsforce.Connection({
      instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
      accessToken: token.replace("Bearer ", ""),
    });
    await conn.identity();
    return true;
  } catch {
    return false;
  }
}

// Validate request with proper error handling
async function validateRequest(): Promise<void> {
  if (!currentRequestToken) {
    const error = new Error(
      "Unauthorized: No authorization token provided."
    ) as Error & { code: number };
    error.code = 401;
    throw error;
  }

  const isValid = await validateToken(currentRequestToken);
  if (!isValid) {
    console.log("Invalid token - throwing error");
    const error = new Error(
      "Unauthorized: Invalid or expired token."
    ) as Error & { code: number };
    error.code = 401;
    throw error;
  }
}

// Create MCP server instance
const server = new Server(
  {
    name: "salesforce-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool handlers
server.setRequestHandler(
  z.object({ method: z.literal("tools/list") }),
  async () => {
    await validateRequest();

    return {
      tools: [
        {
          name: "get-current-user",
          description: "Get information about the current Salesforce user",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  }
);

server.setRequestHandler(
  z.object({
    method: z.literal("tools/call"),
    params: z.object({
      name: z.string(),
      arguments: z.any().optional(),
    }),
  }),
  async (request) => {
    if (request.params.name === "get-current-user") {
      try {
        await validateRequest();

        const conn = new jsforce.Connection({
          instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
          accessToken: currentRequestToken!.replace("Bearer ", ""),
        });
        const userInfo = await conn.identity();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  user: {
                    id: userInfo.user_id,
                    username: userInfo.username,
                    email: userInfo.email,
                    displayName: userInfo.display_name,
                    organizationId: userInfo.organization_id,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  }
);

async function runHttpServer(port: number = 3333) {
  const app = express();
  app.use(express.json());

  // Enable CORS with proper headers for MCP
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, mcp-session-id"
    );
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }
    next();
  });

  // Handle POST requests for client-to-server communication (StreamableHTTP)
  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const authHeader = req.headers["authorization"] as string | undefined;

    // Set the current request token for this request
    currentRequestToken = authHeader;

    let transport: StreamableHTTPServerTransport;

    if (sessionId && streamableTransports[sessionId]) {
      transport = streamableTransports[sessionId];
    } else {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: async (newSessionId: string) => {
          streamableTransports[newSessionId] = transport;
        },
        // DNS rebinding protection is disabled by default for backwards compatibility
        enableDnsRebindingProtection: true,
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete streamableTransports[transport.sessionId];
        }
      };

      await server.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(port, () => {
    console.log(`MCP server running on http://localhost:${port}`);
  });
}

// Start the server
runHttpServer().catch(console.error);
