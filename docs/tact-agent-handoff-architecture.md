# TACT Core Agent Handoff 基盤

対象: `core/tact-agent/`。「複数の開発Agent（Claude Code・Codex等）が同一プロジェクトを継続して開発するための状態管理・引き継ぎ基盤」の最小実装。

第一ユースケースは、Claude Codeの利用制限に到達した際にCodexへ安全に引き継ぎ、Codexが現在地点から再開できるようにすることだが、Core側は特定のCoding Agentの実装を一切知らない（後述）。

## 1. 既存Architectureとの関係（重複実装しないための整理）

実装前の調査で、以下の既存資産を確認・再利用した。新しい概念だけを追加している。

| 既存資産 | 役割 | 今回の扱い |
|---|---|---|
| `core/codeAgent/types.ts` の `CodingAgentAdapter` / `core/codeAgent/adapterRegistry.ts` | 1回のCoding Agent実行（`CodeTask`）を交換可能な実行エンジンとして抽象化する既存の境界。コメントに `"codex" → 将来` と既に明記されている | **変更しない**。Core側の `Agent` は、この既存Adapter境界の「向こう側で誰が動いているか」を表す識別子として扱う |
| `core/codeAgent/gitProvider.ts` の `GitProvider.status()` | `branch` / `headCommit` / `porcelain` / `dirtyFiles` を返す、既存のGit状態取得ロジック | **再利用のみ**。`core/tact-agent/gitState.ts` がこれをそのまま呼び出し、`HandoffGitState` へ変換するだけで、git操作を重複実装しない |
| `core/codeAgent/store.ts` | `tact_memory` テーブル（`type: "task"`）を新規migration無しで再利用する永続化パターン | **同じパターンを踏襲**。`core/tact-agent/supabaseStore.ts` も同じ `tact_memory`・同じ `type: "task"` を使い、`content.recordKind` で `CodeTask` と区別する。新しいテーブル・migrationは追加していない |
| `core/tact-core/types.ts` の `CoreCapability`（DI可能な永続化境界） | Research/Orchestratorが本番実装とMock実装を差し替えられる既存パターン | **同じ設計判断を踏襲**。`AgentHandoffStore` インターフェース＋`createSupabaseAgentHandoffStore()` / `createInMemoryAgentHandoffStore()` の2実装で同じ構造にした |
| `core/tact-core/capabilities/registry.ts`（Mapベースの名前登録Registry） | Capability名を閉じたUnion型にせず自由文字列で登録する既存パターン | **同じ設計判断を踏襲**。`core/tact-agent/agentRegistry.ts` も `AgentId` を自由文字列にし、同じRegistry構造にした |
| `core/tact-orchestrator/task.ts` の `Task` / `TaskStatus` | 1回のOrchestration実行内の短命なSub-task | **再利用しない**。`DevelopmentTask` はPhase単位で複数Agentセッションにまたがる長命な作業であり、責務が異なるため独立した型として定義した |

## 2. 責務の分離

TACT Coreには、似て非なる3つの「状態・履歴」概念が存在する。今回、これらを混同しないことを明示する。

- **Execution Log**（`core/tact-core/execution/types.ts` の `CoreExecution` 等）: 「何を実行し、何が起きたか」という実行履歴。過去形の記録。
- **Development State**（`core/tact-agent/developmentState.ts` の `getDevelopmentState()`）: 「今、誰が・どのTaskを・どこまで進めているか」という現在地点。`DevelopmentTask` と直近の `HandoffState` を合成した読み取り専用View。**それ自体を独立して永続化しない**（3つ目のストアを新設していない）。
- **Handoff**（`core/tact-agent/handoffManager.ts`）: Agentが交代した記録そのもの（履歴として複数件蓄積される）。「誰から誰へ、何を完了し、何が残り、何を検証済みで、次に何をすべきか」を1件ずつ記録する。

## 3. Domain Model（`core/tact-agent/types.ts`）

```
Agent Registry（agentRegistry.ts）
  Agent { agentId, name, provider, capabilities, status }
        ↓
DevelopmentTask（taskManager.ts）
  { taskId, title, description, phase, status, priority, currentAgent, ... }
        ↓
HandoffState（handoffManager.ts）
  { handoffId, taskId, fromAgent, toAgent, reason,
    completedWork, pendingWork, verificationStatus,
    gitStatus, nextAction, status, createdAt }
        ↓
Development State（developmentState.ts、集約View）
  currentTask / currentPhase / currentAgent /
  completedWork / pendingWork / verificationStatus /
  gitStatus / lastCommit / nextAction
```

`AgentId` / `provider` / `capabilities` はいずれも自由文字列（閉じたUnion型にしていない）。Claude Code・Codex固有の実装をCore側のDomain Logicへハードコードしないための設計判断（`core/codeAgent/` 側のAdapter実装が、実際の実行方法を担う）。

## 4. Handoffのライフサイクル

```
createHandoff()      … fromAgent → toAgent のHandoffをstatus:"pending"で作成
        ↓
resumeFromHandoff()  … 次のAgentが現在地点を読み取る(状態を変更しない)
        ↓
completeHandoff()    … status:"completed"にし、DevelopmentTask.currentAgentを
                        toAgentへ実際に切り替える(担当交代が確定する瞬間)
```

`getCurrentHandoff(taskId)` は、指定Taskの直近のHandoff（pending/completed問わず）を返す。

## 5. Git状態との連携

Handoffは「どのcommitを基準に、どの変更状態で引き継いだか」を `HandoffGitState`（`branch` / `lastCommit` / `workingTreeStatus` / `dirtyFileCount`）として保持する。取得は `core/tact-agent/gitState.ts` の `captureGitState(repositoryPath)` が `core/codeAgent/gitProvider.ts` の `GitProvider.status()` を呼ぶだけで、TACT Core自身がcommit/pushを行う機能は持たない。

## 6. Usage / Quota（拡張点のみ、今回は未実装）

`AgentUsage`（`agentId` / `provider` / `usage` / `limit` / `remaining` / `resetAt` / `cost`）はDomain Modelとしてのみ定義済み。実際の取得APIとの接続は今回のスコープ外。

## 7. Agent選択（拡張点のみ、今回は未実装）

将来、`selectAgent(task, availableAgents, usage)` のような自動選択ロジックがCore側に置かれることを想定した構造（Agent Registry → Development State → Handoff Manager → 次のAgentが状態を取得、という一方向の流れ）にしているが、今回は自動選択ロジック自体は実装していない。

## 8. DB

新規テーブル・新規migrationは追加していない。既存の `tact_memory`（`supabase/migrations/20260821000000_create_brain_memory_tables.sql`）を、`core/codeAgent/store.ts` の `CodeTask` と同じ `type: "task"` で再利用し、JSONB内の `content.recordKind`（`"development_task"` | `"agent_handoff"`）で区別する。RLSは既存のStage 0のまま変更していない。

## 9. テストの実行環境

`tact_memory` はRLS Stage 0（anonキーから書き込み可能）であるため、`npm test` から実Supabaseへ誤って書き込まないよう、Unit Testは常に `createInMemoryAgentHandoffStore()`（プロセス内Mapのみ）を明示的に注入して検証する（`tests/tact/agent/agentHandoff.test.ts`）。`captureGitState()` のみ、ローカルgitの読み取り専用コマンド（`git status` / `git rev-parse`）を実際に呼ぶが、書き込みは一切発生しない。
