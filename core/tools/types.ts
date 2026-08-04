import { Evidence } from "@/core/context/types";

export interface ToolResult<T = unknown> {

  success: boolean;

  data?: T;

  error?: string;

}

export interface ToolProperty {

  type: string;

  description?: string;

}

export interface ToolParameterSchema {

  type: "object";

  properties: Record<string, ToolProperty>;

  required?: string[];

}

export interface Tool {

  id: string;

  description: string;

  parameters: ToolParameterSchema;

  execute(
    input: Record<string, unknown>
  ): Promise<ToolResult>;

}

export interface TactToolRequest {

  tool: string;

  arguments?: Record<string, unknown>;

}