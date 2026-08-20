import { Evidence } from "@/core/context/types";

export interface ToolResult<T = unknown> {

  success: boolean;

  data?: T;

  error?: string;

  // STEP151: web-search Toolが、複数Search Provider
  // (core/tools/search/)のうちどれが実際に結果を返したかを
  // 保持するための任意フィールド。web-search以外のToolは設定しない。
  provider?: string;

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