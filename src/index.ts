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

// Store auth data by session ID
const authData: Record<string, { token: string }> = {};

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
  async () => ({
    tools: [
      {
        name: "get-current-user",
        description: "Get information about the current Salesforce user",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  })
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
        // Try to find an active session with auth data
        let activeAuth: { token: string } | undefined;

        for (const [sessionId, auth] of Object.entries(authData)) {
          if (auth && auth.token) {
            activeAuth = auth;
            break;
          }
        }

        if (!activeAuth || !activeAuth.token) {
          return {
            content: [
              {
                type: "text",
                text: "Error: No authorization token found. Make sure Bearer token is provided in Authorization header.",
              },
            ],
          };
        }

        // Use the instance URL from environment variable
        const instanceUrl = process.env.SALESFORCE_INSTANCE_URL;

        // Create Salesforce connection using the Bearer token
        const conn = new jsforce.Connection({
          instanceUrl: instanceUrl,
          accessToken: activeAuth.token.replace("Bearer ", ""),
        });

        // Query current user information
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
              text: `Error: Failed to get Salesforce user: ${
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
    // Check for existing session ID
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    console.info("mcp-session-id:", sessionId);

    // Extract Authorization header to store for later use
    const authHeader = req.headers["authorization"] as string | undefined;

    if (authHeader) {
      console.info(
        "Received Authorization header:",
        authHeader.substring(0, 20) + "..."
      );
    }

    let transport: StreamableHTTPServerTransport;

    if (sessionId && streamableTransports[sessionId]) {
      // Reuse existing transport
      transport = streamableTransports[sessionId];
      console.info("Reusing existing transport for session:", sessionId);

      // Update auth data if provided
      if (authHeader) {
        authData[sessionId] = {
          token: authHeader,
        };
        console.info("Updated auth data for session:", sessionId);
      }
    } else {
      //if (!sessionId && isInitializeRequest(req.body))
      // New initialization request
      console.info("Creating new StreamableHTTP transport for initialization");
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId: string) => {
          // Store the transport by session ID
          streamableTransports[newSessionId] = transport;
          console.info("Stored new transport for session:", newSessionId);

          // Store auth data if provided
          if (authHeader) {
            authData[newSessionId] = {
              token: authHeader,
            };
            console.info("Stored auth data for new session:", newSessionId);
          }
        },
        // DNS rebinding protection is disabled by default for backwards compatibility
        enableDnsRebindingProtection: true,
      });

      // Clean up transport when closed
      transport.onclose = () => {
        if (transport.sessionId) {
          delete streamableTransports[transport.sessionId];
          delete authData[transport.sessionId];
          console.info(
            "Cleaned up transport and auth data for session:",
            transport.sessionId
          );
        }
      };

      // Connect the existing server to this transport
      await server.connect(transport);
    }

    // Handle the request
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(port, () => {
    console.log(`MCP server running on http://localhost:${port}`);
  });
}

// Start the server
runHttpServer().catch(console.error);
