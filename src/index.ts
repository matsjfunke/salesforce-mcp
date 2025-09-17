import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import express, { Request, Response, NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import jsforce from "jsforce";
import { z } from "zod";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Store transports and tokens by session ID
const streamableTransports: Record<string, StreamableHTTPServerTransport> = {};
const sessionTokens: Record<string, string> = {};
// Store current request token for the active request
let currentRequestToken: string | undefined;

// Validate token
async function validateToken(token: string): Promise<boolean> {
  try {
    const cleanToken = token.replace("Bearer ", "");
    console.log("🔍 Clean token for Salesforce:", cleanToken);

    const conn = new jsforce.Connection({
      instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
      accessToken: cleanToken,
    });

    console.log("🔍 Calling Salesforce identity API...");
    const identity = await conn.identity();
    console.log("✅ Token validation successful, identity:", {
      user_id: identity.user_id,
      username: identity.username,
      organization_id: identity.organization_id,
    });
    return true;
  } catch (error) {
    console.log("❌ Token validation failed:", {
      message: error instanceof Error ? error.message : String(error),
      status:
        error instanceof Error && "status" in error
          ? (error as any).status
          : "unknown",
      statusCode:
        error instanceof Error && "statusCode" in error
          ? (error as any).statusCode
          : "unknown",
    });
    return false;
  }
}

// Validate request with proper error handling - called on EVERY request
async function validateRequest(authHeader: string): Promise<void> {
  console.log("🔍 Starting token validation process...");

  if (!authHeader) {
    console.log("❌ No authorization header provided");
    const error = new Error(
      "Unauthorized: No authorization token provided."
    ) as Error & { code: number };
    error.code = 401;
    throw error;
  }

  console.log("🔍 Authorization header found, validating with Salesforce...");
  const isValid = await validateToken(authHeader);
  if (!isValid) {
    console.log("❌ Token validation failed - throwing error");
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
  async (request, extra) => {
    if (request.params.name === "get-current-user") {
      try {
        // Use the current request token that was set during the HTTP request
        if (!currentRequestToken) {
          throw new Error("No valid token found for current request");
        }

        const conn = new jsforce.Connection({
          instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
          accessToken: currentRequestToken.replace("Bearer ", ""),
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
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const authHeader = req.headers["authorization"] as string | undefined;

      if (!sessionId) {
        console.log("🔗 MCP connection attempt with authHeader:", authHeader);
      }

      // ALWAYS validate the auth token on every request, regardless of existing session
      await validateRequest(authHeader!);

      // Set the current request token for use in tool handlers
      currentRequestToken = authHeader!;

      let transport: StreamableHTTPServerTransport;

      if (sessionId && streamableTransports[sessionId]) {
        transport = streamableTransports[sessionId];
        console.log(
          `🔄 Reusing existing session ${sessionId} with fresh token validation \n`
        );
        // Update token for existing session (even though we validated it)
        sessionTokens[sessionId] = authHeader!;
      } else {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: async (newSessionId: string) => {
            streamableTransports[newSessionId] = transport;
            // Store the token for this session
            sessionTokens[newSessionId] = authHeader!;
            console.log(`✅ Session ${newSessionId} initialized with token`);
          },
          // DNS rebinding protection is disabled by default for backwards compatibility
          enableDnsRebindingProtection: true,
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            delete streamableTransports[transport.sessionId];
            delete sessionTokens[transport.sessionId];
            console.log(`🧹 Cleaned up session ${transport.sessionId}`);
          }
        };

        await server.connect(transport);
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("❌ MCP request error:", error);
      if (error instanceof Error && "code" in error && error.code === 401) {
        res.status(401).json({
          error: "Unauthorized",
          message: error.message,
        });
      } else {
        res.status(500).json({
          error: "Internal Server Error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  app.listen(port, () => {
    console.log(`MCP server running on http://localhost:${port}`);
  });
}

// Start the server
runHttpServer().catch(console.error);
