// =========================
// TACT Core — CoreContext (STEP175)
// =========================
//
// 重要な区別: 既存のWorkflowContext(core/context/types.ts)は
// 「1回のWorkflow実行の間だけ生きる実行コンテキスト」であり、今回も
// 一切変更しない。CoreContextはそれとは全く別の、TACT Coreが
// 「このユーザー・この組織・このプロジェクト・この会話について、
// 現時点で何を知っているか」を表す集約型である。
//
// STEP175時点では型定義のみ。実際にDBから全データを集約して
// CoreContextを構築するロジック(loadContext())は
// core/tact-core/types.tsのCoreCapability interfaceとして契約だけを
// 定義し、実装はmockCoreCapability.ts(in-memoryの最小実装、DB接続なし)
// に留める。

import { User, Organization } from "../users/types";
import { Project } from "../projects/types";
import { CoreMemory } from "../memory/types";
import { KnowledgeItem, Example } from "../knowledge/types";
import { CoreExecution } from "../execution/types";

export interface CoreContext {

  user?: User;

  organization?: Organization;

  project?: Project;

  // 既存のConversation(core/conversation/types.ts)のidをそのまま
  // 参照する想定。CoreContext自体はConversation型を持ち込まない
  // (Conversation本体の責務はConversation層に残す)。
  conversationId?: string;

  memories: CoreMemory[];

  knowledge: KnowledgeItem[];

  examples: Example[];

  recentExecutions: CoreExecution[];

}
