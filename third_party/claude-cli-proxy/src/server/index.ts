/**
 * Express HTTP Server
 *
 * Provides OpenAI-compatible API endpoints that wrap Claude Code CLI
 */

import express, { Express, Request, Response, NextFunction } from "express";
import { createServer, Server } from "http";
import { timingSafeEqual } from "crypto";
import { handleChatCompletions, handleModels, handleHealth, handleHealthDeep, handlePricing, handleResponses, handleTraceGet, handleTraceList } from "./routes.js";
import { handleMetrics } from "./metrics.js";

export interface ServerConfig {
  port: number;
  host?: string;
}

let serverInstance: Server | null = null;

/**
 * Create and configure the Express app
 */
function createApp(): Express {
  const app = express();

  // The embedded C.le helper can spend subscription quota, so it is never an
  // unauthenticated loopback endpoint. Standalone upstream behavior is kept.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const secret = process.env.CLE_PROXY_AUTH_TOKEN;
    if (!secret) return next();
    const provided = req.header("authorization") || "";
    const expected = Buffer.from(`Bearer ${secret}`);
    const actual = Buffer.from(provided);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.status(401).json({ error: { message: "Unauthorized", type: "authentication_error" } });
      return;
    }
    next();
  });

  // Middleware
  app.use(express.json({ limit: "10mb" }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!process.env.CLE_CREDENTIAL_URL || req.method !== "POST" ||
        !/\/(chat\/completions|responses)$/.test(req.path)) return next();
    // The upstream converter only supports text. Fail explicitly rather than
    // silently discarding images or files sent by the caller.
    const containsUnsupported = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.some(containsUnsupported);
      if (!value || typeof value !== "object") return false;
      const item = value as Record<string, unknown>;
      if (["image_url", "input_image", "image", "input_file", "file"].includes(String(item.type))) return true;
      return containsUnsupported(item.content);
    };
    if (containsUnsupported(req.body?.messages) || containsUnsupported(req.body?.input)) {
      res.status(400).json({ error: { message: "Claude CLI 通道暂不支持图片或文件输入，请使用其他支持该功能的渠道", type: "invalid_request_error", code: "unsupported_content" } });
      return;
    }
    next();
  });

  // Request logging (debug mode)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (process.env.DEBUG) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
    next();
  });

  // CORS headers for local development
  app.use((_req: Request, res: Response, next: NextFunction) => {
    if (process.env.CLE_PROXY_AUTH_TOKEN) return next();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    next();
  });

  // Handle OPTIONS preflight
  app.options("*", (_req: Request, res: Response) => {
    res.sendStatus(200);
  });

  // Routes — register both /v1/* and /* paths so clients that omit the
  // /v1 prefix (e.g. OpenCLAW's openai-completions provider) still work.
  app.get("/health", handleHealth);
  app.get("/healthz/deep", handleHealthDeep);
  app.get("/metrics", handleMetrics);
  app.get("/pricing", handlePricing);
  app.get("/v1/pricing", handlePricing);
  app.get("/v1/models", handleModels);
  app.get("/models", handleModels);
  app.post("/v1/chat/completions", handleChatCompletions);
  app.post("/chat/completions", handleChatCompletions);
  app.post("/v1/responses", handleResponses);
  app.post("/responses", handleResponses);
  app.get("/traces", handleTraceList);
  app.get("/traces/:id", handleTraceGet);

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        message: "Not found",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[Server Error]:", err.message);
    res.status(500).json({
      error: {
        message: err.message,
        type: "server_error",
        code: null,
      },
    });
  });

  return app;
}

/**
 * Start the HTTP server
 */
export async function startServer(config: ServerConfig): Promise<Server> {
  const { port, host = "127.0.0.1" } = config;

  if (serverInstance) {
    console.log("[Server] Already running, returning existing instance");
    return serverInstance;
  }

  const app = createApp();

  return new Promise((resolve, reject) => {
    serverInstance = createServer(app);

    serverInstance.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });

    serverInstance.listen(port, host, () => {
      console.log(`[Server] Claude Code CLI provider running at http://${host}:${port}`);
      console.log(`[Server] OpenAI-compatible endpoint: http://${host}:${port}/v1/chat/completions`);
      resolve(serverInstance!);
    });
  });
}

/**
 * Stop the HTTP server
 */
export async function stopServer(): Promise<void> {
  if (!serverInstance) {
    return;
  }

  return new Promise((resolve, reject) => {
    serverInstance!.close((err) => {
      if (err) {
        reject(err);
      } else {
        console.log("[Server] Stopped");
        serverInstance = null;
        resolve();
      }
    });
  });
}

/**
 * Get the current server instance
 */
export function getServer(): Server | null {
  return serverInstance;
}
