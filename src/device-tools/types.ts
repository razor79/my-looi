export type DeviceToolParameterSchema = Record<string, unknown>;

export interface DeviceToolDefinition {
  name: string;
  description: string;
  parameters: DeviceToolParameterSchema;
  timeoutMs?: number;
}

export interface DeviceToolCall {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export type DeviceToolExecutor = (args: Record<string, unknown>) => Promise<unknown> | unknown;
