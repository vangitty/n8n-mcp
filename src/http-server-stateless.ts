#!/usr/bin/env node
/**
 * Stateless HTTP server for n8n-MCP
 *
 * This server follows the same pattern as the Zoho MCP Server:
 * - No sessions, no state storage
 * - Per-request context extraction from headers
 * - Simple HTTP endpoints: /tools/list, /tools/call
 * - One shared N8NDocumentationMCPServer instance
 *
 * This eliminates session expiration issues completely.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
import { N8NDocumentationMCPServer } from './mcp/server';
import { logger } from './utils/logger';
import { AuthManager } from './utils/auth';
import { PROJECT_VERSION } from './utils/version';
import { getStartupBaseUrl, formatEndpointUrls, detectBaseUrl } from './utils/url-detector';
import { InstanceContext, validateInstanceContext } from './types/instance-context';
import { n8nDocumentationToolsFinal } from './mcp/tools';
import { n8nManagementTools } from './mcp/tools-n8n-manager';
import { isN8nApiConfigured } from './config/n8n-api';

dotenv.config();

/**
 * Extract instance context from request headers
 * Used for multi-tenant support - each request can target a different n8n instance
 */
function extractInstanceContext(req: express.Request): InstanceContext | undefined {
  const n8nUrl = req.headers['x-n8n-url'] as string | undefined;
  const n8nKey = req.headers['x-n8n-key'] as string | undefined;
  const instanceId = req.headers['x-instance-id'] as string | undefined;

  // If no headers provided, use environment defaults
  if (!n8nUrl && !n8nKey) {
    const envUrl = process.env.N8N_API_URL;
    const envKey = process.env.N8N_API_KEY;

    if (envUrl || envKey) {
      return {
        n8nApiUrl: envUrl,
        n8nApiKey: envKey,
        instanceId: 'default'
      };
    }
    return undefined;
  }

  const context: InstanceContext = {
    n8nApiUrl: n8nUrl,
    n8nApiKey: n8nKey,
    instanceId: instanceId || 'header-provided'
  };

  // Validate context
  const validation = validateInstanceContext(context);
  if (!validation.valid) {
    logger.warn('Invalid instance context from headers', {
      errors: validation.errors,
      hasUrl: !!n8nUrl,
      hasKey: !!n8nKey
    });
    return undefined;
  }

  return context;
}

export class StatelessHTTPServer {
  private authToken: string | null = null;
  private expressServer: any;
  private mcpServer: N8NDocumentationMCPServer | null = null;
  private serverReady: Promise<void>;

  // Tool registry for quick lookup
  private toolRegistry: Map<string, {
    name: string;
    description: string;
    inputSchema: any;
  }> = new Map();

  constructor() {
    this.validateEnvironment();
    this.serverReady = this.initializeToolRegistry();
  }

  /**
   * Load auth token from environment variable or file
   */
  private loadAuthToken(): string | null {
    if (process.env.AUTH_TOKEN) {
      logger.info('Using AUTH_TOKEN from environment variable');
      return process.env.AUTH_TOKEN;
    }

    if (process.env.AUTH_TOKEN_FILE) {
      try {
        const token = readFileSync(process.env.AUTH_TOKEN_FILE, 'utf-8').trim();
        logger.info(`Loaded AUTH_TOKEN from file: ${process.env.AUTH_TOKEN_FILE}`);
        return token;
      } catch (error) {
        logger.error(`Failed to read AUTH_TOKEN_FILE: ${process.env.AUTH_TOKEN_FILE}`, error);
        return null;
      }
    }

    return null;
  }

  /**
   * Validate required environment variables
   */
  private validateEnvironment(): void {
    this.authToken = this.loadAuthToken();

    if (!this.authToken || this.authToken.trim() === '') {
      const message = 'No authentication token found. Set AUTH_TOKEN environment variable or AUTH_TOKEN_FILE.';
      logger.error(message);
      throw new Error(message);
    }

    this.authToken = this.authToken.trim();

    if (this.authToken.length < 32) {
      logger.warn('AUTH_TOKEN should be at least 32 characters for security');
    }

    const isDefaultToken = this.authToken === 'REPLACE_THIS_AUTH_TOKEN_32_CHARS_MIN_abcdefgh';
    const isProduction = process.env.NODE_ENV === 'production';

    if (isDefaultToken && isProduction) {
      const message = 'Cannot start in production with default AUTH_TOKEN';
      logger.error(message);
      throw new Error(message);
    }

    if (isDefaultToken) {
      logger.warn('⚠️ Using default AUTH_TOKEN - CHANGE IMMEDIATELY!');
    }
  }

  /**
   * Initialize the tool registry from the n8n documentation tools
   * This is async because the MCP server needs to initialize its database
   */
  private async initializeToolRegistry(): Promise<void> {
    logger.info('Initializing tool registry...');

    // Create a shared MCP server instance for tool execution
    // This singleton will be reused across all requests
    this.mcpServer = new N8NDocumentationMCPServer();

    // Wait for the MCP server to initialize its database
    // The server has an internal 'initialized' promise we need to wait for
    await (this.mcpServer as any).initialized;

    // Register all documentation tools
    for (const tool of n8nDocumentationToolsFinal) {
      this.toolRegistry.set(tool.name, {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      });
    }

    // Register n8n management tools if API is configured
    if (isN8nApiConfigured()) {
      for (const tool of n8nManagementTools) {
        this.toolRegistry.set(tool.name, {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        });
      }
      logger.info(`n8n API configured - management tools enabled`);
    }

    logger.info(`Tool registry initialized with ${this.toolRegistry.size} tools`);
  }

  /**
   * Validate authentication token
   */
  private validateAuth(req: express.Request): boolean {
    const authHeader = req.headers.authorization;
    const queryToken = req.query.token as string | undefined;

    let token: string | null = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (queryToken) {
      token = queryToken.trim();
    }

    if (!token) {
      return false;
    }

    return this.authToken !== null &&
           AuthManager.timingSafeCompare(token, this.authToken);
  }

  /**
   * Handle /tools/list endpoint
   */
  private async handleToolsList(req: express.Request, res: express.Response): Promise<void> {
    // Ensure server is ready
    await this.serverReady;

    const tools = Array.from(this.toolRegistry.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));

    res.json({
      tools
    });
  }

  /**
   * Handle /tools/call endpoint
   */
  private async handleToolCall(req: express.Request, res: express.Response): Promise<void> {
    // Ensure server is ready
    await this.serverReady;

    const { name, arguments: args } = req.body;

    if (!name) {
      res.status(400).json({
        error: {
          code: -32602,
          message: 'Missing required parameter: name'
        }
      });
      return;
    }

    const tool = this.toolRegistry.get(name);
    if (!tool) {
      res.status(404).json({
        error: {
          code: -32601,
          message: `Unknown tool: ${name}`
        }
      });
      return;
    }

    try {
      // Extract instance context from headers for multi-tenant support
      const instanceContext = extractInstanceContext(req);

      // Update the MCP server's instance context for this request
      if (instanceContext && this.mcpServer) {
        (this.mcpServer as any).instanceContext = instanceContext;
      }

      logger.info(`Executing tool: ${name}`, {
        hasContext: !!instanceContext,
        instanceId: instanceContext?.instanceId
      });

      // Use the MCP server's executeTool method
      const result = await this.mcpServer!.executeTool(name, args || {});

      res.json({
        content: [{
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        }]
      });
    } catch (error) {
      logger.error(`Tool execution failed: ${name}`, error);

      res.status(500).json({
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Tool execution failed'
        }
      });
    }
  }

  /**
   * Start the HTTP server
   */
  async start(): Promise<void> {
    const app = express();

    // JSON body parser
    app.use(express.json({ limit: '10mb' }));

    // Trust proxy configuration
    const trustProxy = process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : 0;
    if (trustProxy > 0) {
      app.set('trust proxy', trustProxy);
    }

    // Security headers
    app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      next();
    });

    // CORS configuration
    app.use((req, res, next) => {
      const allowedOrigin = process.env.CORS_ORIGIN || '*';
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-N8N-URL, X-N8N-Key, X-Instance-ID');
      res.setHeader('Access-Control-Max-Age', '86400');

      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    });

    // Request logging
    app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('user-agent')
      });
      next();
    });

    // Rate limiting for API endpoints
    const apiLimiter = rateLimit({
      windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW || '900000'),
      max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '100'),
      message: { error: { code: -32000, message: 'Too many requests' } },
      standardHeaders: true,
      legacyHeaders: false
    });

    // ===== PUBLIC ENDPOINTS =====

    // Root endpoint with API information
    app.get('/', (req, res) => {
      const port = parseInt(process.env.PORT || '3000');
      const host = process.env.HOST || '0.0.0.0';
      const baseUrl = detectBaseUrl(req, host, port);

      res.json({
        name: 'n8n Documentation MCP Server (Stateless)',
        version: PROJECT_VERSION,
        mode: 'stateless',
        description: 'Stateless MCP server - no session management, per-request context',
        endpoints: {
          health: { url: `${baseUrl}/health`, method: 'GET', auth: false },
          toolsList: { url: `${baseUrl}/tools/list`, method: 'GET', auth: true },
          toolsCall: { url: `${baseUrl}/tools/call`, method: 'POST', auth: true }
        },
        authentication: {
          type: 'Bearer Token',
          header: 'Authorization: Bearer <token>',
          alternative: 'Query parameter: ?token=<token>'
        },
        multiTenant: {
          description: 'Pass n8n instance details via headers for multi-tenant use',
          headers: {
            'X-N8N-URL': 'n8n API URL (e.g., https://n8n.example.com/api/v1)',
            'X-N8N-Key': 'n8n API key',
            'X-Instance-ID': 'Optional instance identifier'
          }
        },
        documentation: 'https://github.com/czlonkowski/n8n-mcp'
      });
    });

    // Health check endpoint
    app.get('/health', async (req, res) => {
      // Check if server is initialized (non-blocking)
      let initialized = false;
      try {
        await Promise.race([
          this.serverReady.then(() => { initialized = true; }),
          new Promise(resolve => setTimeout(resolve, 100))
        ]);
      } catch {
        // Server not ready yet
      }

      res.json({
        status: initialized ? 'ok' : 'initializing',
        mode: 'stateless',
        version: PROJECT_VERSION,
        uptime: Math.floor(process.uptime()),
        tools: this.toolRegistry.size,
        initialized,
        n8nApiConfigured: isN8nApiConfigured(),
        memory: {
          used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          unit: 'MB'
        },
        timestamp: new Date().toISOString()
      });
    });

    // ===== AUTHENTICATED ENDPOINTS =====

    // Authentication middleware for protected endpoints
    const authMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
      if (!this.validateAuth(req)) {
        logger.warn('Authentication failed', {
          ip: req.ip,
          path: req.path
        });
        res.status(401).json({
          error: {
            code: -32001,
            message: 'Unauthorized'
          }
        });
        return;
      }
      next();
    };

    // List available tools
    app.get('/tools/list', apiLimiter, authMiddleware, async (req, res) => {
      await this.handleToolsList(req, res);
    });

    // Call a tool
    app.post('/tools/call', apiLimiter, authMiddleware, async (req, res) => {
      await this.handleToolCall(req, res);
    });

    // ===== MCP COMPATIBILITY ENDPOINTS =====
    // These provide backwards compatibility with MCP SDK clients

    // MCP info endpoint (for discovery)
    app.get('/mcp', (req, res) => {
      res.json({
        protocolVersion: '2024-11-05',
        serverInfo: {
          name: 'n8n-mcp',
          version: PROJECT_VERSION
        },
        capabilities: {
          tools: {}
        },
        note: 'This is a stateless server. Use /tools/list and /tools/call endpoints.'
      });
    });

    // MCP JSON-RPC endpoint (minimal compatibility)
    app.post('/mcp', apiLimiter, authMiddleware, async (req, res) => {
      // Ensure server is ready
      await this.serverReady;

      const { method, params, id } = req.body;

      try {
        if (method === 'initialize') {
          res.json({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'n8n-mcp', version: PROJECT_VERSION }
            }
          });
          return;
        }

        if (method === 'tools/list') {
          const tools = Array.from(this.toolRegistry.values()).map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
          }));

          res.json({
            jsonrpc: '2.0',
            id,
            result: { tools }
          });
          return;
        }

        if (method === 'tools/call') {
          const { name, arguments: args } = params || {};
          const tool = this.toolRegistry.get(name);

          if (!tool) {
            res.json({
              jsonrpc: '2.0',
              id,
              error: { code: -32601, message: `Unknown tool: ${name}` }
            });
            return;
          }

          // Update instance context for this request
          const instanceContext = extractInstanceContext(req);
          if (instanceContext && this.mcpServer) {
            (this.mcpServer as any).instanceContext = instanceContext;
          }

          // Use executeTool method
          const result = await this.mcpServer!.executeTool(name, args || {});

          res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
              }]
            }
          });
          return;
        }

        // Unknown method
        res.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        });
      } catch (error) {
        logger.error('MCP request error', error);
        res.json({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Internal error'
          }
        });
      }
    });

    // 404 handler
    app.use((req, res) => {
      res.status(404).json({
        error: 'Not found',
        message: `Cannot ${req.method} ${req.path}`
      });
    });

    // Error handler
    app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.error('Express error handler:', err);

      if (!res.headersSent) {
        res.status(500).json({
          error: {
            code: -32603,
            message: 'Internal server error'
          }
        });
      }
    });

    // Start server
    const port = parseInt(process.env.PORT || '3000');
    const host = process.env.HOST || '0.0.0.0';

    this.expressServer = app.listen(port, host, () => {
      const baseUrl = getStartupBaseUrl(host, port);

      logger.info('n8n MCP Stateless HTTP Server started', {
        port,
        host,
        version: PROJECT_VERSION,
        tools: this.toolRegistry.size
      });

      console.log(`n8n MCP Stateless HTTP Server running on ${host}:${port}`);
      console.log(`Mode: STATELESS (no sessions, no expiration)`);
      console.log(`Tools loaded: ${this.toolRegistry.size}`);
      console.log(`Health: ${baseUrl}/health`);
      console.log(`Tools list: ${baseUrl}/tools/list`);
      console.log(`Tools call: ${baseUrl}/tools/call`);
      console.log(`MCP endpoint: ${baseUrl}/mcp (JSON-RPC compatible)`);
      console.log('\nPress Ctrl+C to stop the server');
    });

    // Handle server errors
    this.expressServer.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${port} is already in use`);
        process.exit(1);
      } else {
        logger.error('Server error:', error);
        process.exit(1);
      }
    });
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down Stateless HTTP server...');

    if (this.mcpServer && typeof (this.mcpServer as any).close === 'function') {
      try {
        await (this.mcpServer as any).close();
      } catch (error) {
        logger.warn('Error closing MCP server:', error);
      }
    }

    if (this.expressServer) {
      await new Promise<void>((resolve) => {
        this.expressServer.close(() => {
          logger.info('HTTP server closed');
          resolve();
        });
      });
    }

    logger.info('Stateless HTTP server shutdown completed');
  }
}

// Start if called directly
if (require.main === module) {
  const server = new StatelessHTTPServer();

  const shutdown = async () => {
    await server.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
    shutdown();
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
    shutdown();
  });

  server.start().catch(error => {
    logger.error('Failed to start Stateless HTTP server:', error);
    process.exit(1);
  });
}
