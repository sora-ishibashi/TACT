// =========================
// Workflow Log
// =========================

export interface WorkflowLog {
  agent: string;
  message: string;
  timestamp: number;
}

// =========================
// Workflow Event
// =========================

export interface WorkflowEvent {
  type:
    | "start"
    | "complete"
    | "failed";

  agent: string;

  timestamp: number;
}

// =========================
// Brain Rule
// =========================

export interface BrainRule {

  // 改善対象
  targetAgent?: string;

  // 改善内容
  rule: string;

  // なぜ必要か
  reason: string;

  // 優先度
  priority?:
    | "low"
    | "medium"
    | "high";

  // 作成日時
  createdAt: number;
}

// =========================
// Execution Record
// =========================

export interface ExecutionRecord {

  id: string;

  userInput: string;

  mode:
    | "quick"
    | "think"
    | "deep";

  agents: string[];

  outputs: Record<string, unknown>;

  quality?: {
    score: number;
    issues: string[];
    improvements: BrainRule[];
  };

  duration?: number;

  success?: boolean;

  failedAgents?: string[];

  reviewerAgent?: string;

  cost?: {
    tokens: number;
    estimatedUSD: number;
  };

  createdAt: number;
}

// =========================
// Evidence
// =========================

export interface Evidence {

  // 一意ID
  id: string;

  // 一言で表したEvidence
  claim: string;

  // ResearcherのEvidence(JSON文字列)
  evidence: string;

  // 出典URL
  source?: string;

  // 信頼度
  confidence:
    | "low"
    | "medium"
    | "high";

  // Evidence品質
  score: number;

  // 時間情報
  publishedAt?: string;

  updatedAt?: string;

  retrievedAt?: string;

  // 出典分類
  sourceType?:
    | "official"
    | "government"
    | "paper"
    | "news"
    | "media"
    | "community"
    | "unknown";

  // メタデータ
  isPrimarySource?: boolean;

  freshnessScore?: number;

  hash?: string;

  // 作成者
  createdBy: string;

  // 作成日時
  createdAt: number;

  // タグ（検索用）
tags: string[];

references?: string[];
}

// =========================
// Workflow Context
// =========================

export interface WorkflowContext {

  // =====================
  // User
  // =====================

  userInput: string;

  mode:
    | "quick"
    | "think"
    | "deep";

  // =====================
  // Agent Output
  // =====================

  outputs: Record<string, unknown>;

  stepOutputs: Record<
    string,
    {
      agent: string;
      output: unknown;
    }
  >;

  // =====================
  // Memory
  // =====================

  memory: Record<
    string,
    (
      | string
      | BrainRule
    )[]
  >;

// =====================
// Shared Evidence
// =====================

evidence: Evidence[];

// =====================
// Agent Handoffs
// =====================

handoffs: Record<string, unknown>;

// =====================
// Runtime
// =====================

agentStatus: Record<string, string>;

  reviewHistory: unknown[];

  logs: WorkflowLog[];

  events: WorkflowEvent[];

  // =====================
  // Final
  // =====================

  finalOutput: unknown;

  // =====================
  // Self Improvement
  // =====================

  executionRecord?: ExecutionRecord;
}