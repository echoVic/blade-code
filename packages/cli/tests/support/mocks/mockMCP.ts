import { vi } from 'vitest';
import { EventEmitter } from 'events';

export interface MockMCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MockMCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MockMCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface MockMCPServerConfig {
  name: string;
  tools?: MockMCPTool[];
  resources?: MockMCPResource[];
  prompts?: MockMCPPrompt[];
  capabilities?: {
    tools?: boolean;
    resources?: boolean;
    prompts?: boolean;
  };
}

export class MockMCPClient extends EventEmitter {
  private serverName: string;
  private tools: MockMCPTool[];
  private resources: MockMCPResource[];
  private prompts: MockMCPPrompt[];
  private capabilities: { tools?: boolean; resources?: boolean; prompts?: boolean };
  private connected = false;
  private toolCallHistory: Array<{ name: string; args: Record<string, unknown> }> = [];
  private mockToolResults: Map<string, unknown> = new Map();

  constructor(config: MockMCPServerConfig) {
    super();
    this.serverName = config.name;
    this.tools = config.tools || [];
    this.resources = config.resources || [];
    this.prompts = config.prompts || [];
    this.capabilities = config.capabilities || {
      tools: true,
      resources: true,
      prompts: true,
    };
  }

  async connect(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.connected = true;
    this.emit('connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.emit('disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  getServerName(): string {
    return this.serverName;
  }

  async listTools(): Promise<MockMCPTool[]> {
    if (!this.capabilities.tools) {
      throw new Error('Server does not support tools');
    }
    return this.tools;
  }

  async listResources(): Promise<MockMCPResource[]> {
    if (!this.capabilities.resources) {
      throw new Error('Server does not support resources');
    }
    return this.resources;
  }

  async listPrompts(): Promise<MockMCPPrompt[]> {
    if (!this.capabilities.prompts) {
      throw new Error('Server does not support prompts');
    }
    return this.prompts;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) {
      throw new Error('Not connected to MCP server');
    }

    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    this.toolCallHistory.push({ name, args });

    if (this.mockToolResults.has(name)) {
      return this.mockToolResults.get(name);
    }

    return { success: true, result: `Mock result for ${name}` };
  }

  async readResource(uri: string): Promise<{ contents: string; mimeType?: string }> {
    if (!this.connected) {
      throw new Error('Not connected to MCP server');
    }

    const resource = this.resources.find((r) => r.uri === uri);
    if (!resource) {
      throw new Error(`Resource not found: ${uri}`);
    }

    return {
      contents: `Mock contents for ${uri}`,
      mimeType: resource.mimeType || 'text/plain',
    };
  }

  async getPrompt(
    name: string,
    args?: Record<string, unknown>
  ): Promise<{ messages: Array<{ role: string; content: string }> }> {
    if (!this.connected) {
      throw new Error('Not connected to MCP server');
    }

    const prompt = this.prompts.find((p) => p.name === name);
    if (!prompt) {
      throw new Error(`Prompt not found: ${name}`);
    }

    return {
      messages: [
        {
          role: 'user',
          content: `Mock prompt content for ${name} with args: ${JSON.stringify(args)}`,
        },
      ],
    };
  }

  setMockToolResult(toolName: string, result: unknown): void {
    this.mockToolResults.set(toolName, result);
  }

  addTool(tool: MockMCPTool): void {
    this.tools.push(tool);
  }

  addResource(resource: MockMCPResource): void {
    this.resources.push(resource);
  }

  addPrompt(prompt: MockMCPPrompt): void {
    this.prompts.push(prompt);
  }

  getToolCallHistory(): Array<{ name: string; args: Record<string, unknown> }> {
    return [...this.toolCallHistory];
  }

  getLastToolCall(): { name: string; args: Record<string, unknown> } | undefined {
    return this.toolCallHistory[this.toolCallHistory.length - 1];
  }

  reset(): void {
    this.toolCallHistory = [];
    this.mockToolResults.clear();
    this.connected = false;
  }
}

export const createMockMCPClient = (
  config?: Partial<MockMCPServerConfig>
): MockMCPClient => {
  return new MockMCPClient({
    name: config?.name || 'mock-mcp-server',
    tools: config?.tools || [
      {
        name: 'mock_tool',
        description: 'A mock tool for testing',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string' },
          },
        },
      },
    ],
    resources: config?.resources || [
      {
        uri: 'mock://resource',
        name: 'Mock Resource',
        description: 'A mock resource for testing',
      },
    ],
    prompts: config?.prompts || [
      {
        name: 'mock_prompt',
        description: 'A mock prompt for testing',
      },
    ],
    capabilities: config?.capabilities,
  });
};

export class MockMCPRegistry {
  private clients: Map<string, MockMCPClient> = new Map();
  private enabledServers: Set<string> = new Set();

  registerServer(name: string, client: MockMCPClient): void {
    this.clients.set(name, client);
  }

  unregisterServer(name: string): void {
    this.clients.delete(name);
    this.enabledServers.delete(name);
  }

  getClient(name: string): MockMCPClient | undefined {
    return this.clients.get(name);
  }

  getAllClients(): Map<string, MockMCPClient> {
    return new Map(this.clients);
  }

  enableServer(name: string): void {
    this.enabledServers.add(name);
  }

  disableServer(name: string): void {
    this.enabledServers.delete(name);
  }

  isServerEnabled(name: string): boolean {
    return this.enabledServers.has(name);
  }

  getEnabledServers(): string[] {
    return Array.from(this.enabledServers);
  }

  async connectAll(): Promise<void> {
    const connectPromises = Array.from(this.clients.values()).map((client) =>
      client.connect()
    );
    await Promise.all(connectPromises);
  }

  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.clients.values()).map((client) =>
      client.disconnect()
    );
    await Promise.all(disconnectPromises);
  }

  reset(): void {
    this.clients.clear();
    this.enabledServers.clear();
  }
}

export const createMockMCPRegistry = (): MockMCPRegistry => {
  return new MockMCPRegistry();
};

export const createMockMCPService = () => {
  const registry = new MockMCPRegistry();

  return {
    registerServer: vi.fn(registry.registerServer.bind(registry)),
    unregisterServer: vi.fn(registry.unregisterServer.bind(registry)),
    getClient: vi.fn(registry.getClient.bind(registry)),
    getAllClients: vi.fn(registry.getAllClients.bind(registry)),
    enableServer: vi.fn(registry.enableServer.bind(registry)),
    disableServer: vi.fn(registry.disableServer.bind(registry)),
    isServerEnabled: vi.fn(registry.isServerEnabled.bind(registry)),
    getEnabledServers: vi.fn(registry.getEnabledServers.bind(registry)),
    connectAll: vi.fn(registry.connectAll.bind(registry)),
    disconnectAll: vi.fn(registry.disconnectAll.bind(registry)),
    reset: registry.reset.bind(registry),
    _registry: registry,
  };
};
