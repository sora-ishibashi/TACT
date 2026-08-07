# Architecture

このドキュメントは、TACTの**現在の実装**を正確に記述したものです。
将来構想や理想形は含みません（`docs/vision.md` / `docs/principles.md` / `docs/constitution.md` を参照）。
推測・提案を含む箇所には `[提案]` と明記しています。

---

## 1. システム全体の流れ

TACTは Next.js App Router 上に構築された、複数AgentがOpenAI APIを順番に呼び出すワークフローエンジンです。

```
User (ブラウザ)
  ↓
components/TactInterface.tsx → components/layout/Workspace.tsx
  ↓ (InputBar.tsx が fetch)
app/api/tact/route.ts            … POST・一括レスポンス
app/api/tact/stream/route.ts     … GET・SSEストリーミング（実際にUIが使うのはこちら）
  ↓
core/workflow/index.ts: runWorkflow(defaultWorkflow, input, mode, onEvent)
  ↓
core/context/index.ts: createContext()  … WorkflowContext を初期化
  ↓
core/brain/*  … 過去実行履歴からの推奨（brainRecommendation）を計算 ※現状はconsole.logのみで実行には反映されない
  ↓
while (currentStep < dynamicPlan.length) {
  1. core/agents/index.ts の agents 配列から該当Agentを取得
  2. core/workflow/runAgent.ts: runAgent(agent, step, context)
       - core/evidence/selectEvidence.ts で関連Evidenceを抽出
       - core/prompt/builder.ts: buildPrompt() でプロンプトを構築
       - core/llm/index.ts: runLLM() → core/llm/providers/openai.ts で OpenAI 呼び出し
       - 応答JSONをパース
       - parsed.toolRequests があれば core/tools/executeToolCalls.ts を実行し、
         Tool結果を使って同じAgentにもう一度 runLLM() させる（最大2回呼び出し）
       - 結果を context.outputs / context.stepOutputs / context.evidence /
         context.handoffs / context.memory へ反映
       - logs/ 以下にAgentごとの実行ログ(JSON)を保存
  3. agent.id === "planner" の場合 → core/workflow/handlePlanner.ts が
     Plannerの出力から動的な dynamicPlan（実行するAgent列）を再構築する
  4. core/evidence/checkEvidence.ts でEvidenceの欠陥（source欠落など）を検出しログ出力のみ行う
  5. agent.id === "reviewer" の場合 → core/workflow/handleReviewer.ts が
     approved / retry に応じて再実行先のステップへ currentStep を戻す
     （最大 MAX_REVIEW = 3 回まで）
  6. currentStep++
}
  ↓
context.finalOutput = context.outputs.writer（存在しなければ最終ステップの出力）
  ↓
core/brain/index.ts: analyzeExecution() … 今回実行の簡易スコアリング
  ↓
core/optimizer/optimizer.ts: optimizeExecution() … 改善ルールを appliedRules として抽出
  ↓
core/brain/memory.ts: saveBrainMemory(appliedRules) … 次回以降のPromptに埋め込むメモリへ保存
  ↓
context を呼び出し元（APIルート）へ返す → SSEで各イベントをフロントへ配信
```

- ストリーミングAPI (`app/api/tact/stream/route.ts`) は `onEvent` コールバックで
  `start` / `complete` / `failed` / `result` / `finished` / `error` をSSEとして逐次送信する。
- 非ストリーミングAPI (`app/api/tact/route.ts`) は `runWorkflow` の戻り値（`WorkflowContext`）を
  そのままJSONで返す。UIからは現状呼ばれていない（`app/test/page.tsx` の検証用ページのみが使用）。

---

## 2. ディレクトリ構成

実際に実行パスで使われているファイルと、未使用・レガシーのファイルが混在しています。
未使用ファイルは import 元が存在しないことをコード内 grep で確認済みです。

```
app/
  api/tact/route.ts            使用中 … POST版API
  api/tact/stream/route.ts     使用中 … SSE版API（UIが実際に叩く）
  layout.tsx                   使用中 … ルートレイアウト
  page.tsx                     使用中 … トップページ（Header + TactInterface）
  test/page.tsx                使用中 … /api/tact の動作確認用デバッグページ

components/
  TactInterface.tsx            使用中 … 状態(messages/workflow/result/...)を保持しWorkspaceへ渡す
  Header.tsx                   使用中
  Conversation.tsx             使用中 … 会話ログ＋進捗バー表示
  InputBar.tsx                 使用中 … 送信＋SSE受信のロジックを保持（mode選択もここ）
  layout/
    Workspace.tsx               使用中 … Sidebar/LeftPanel/RightPanelを組み立てる
    LeftPanel.tsx                使用中 … Conversation + InputBar
    RightPanel.tsx               使用中 … TeamStatus + ThinkingPanel + OutputViewer
    Sidebar.tsx                  使用中 … アイコンのみのサイドバー
    TeamStatus.tsx               使用中 … AgentStatusListの進捗ラッパー
    OutputViewer.tsx             使用中 … FinalOutputのラッパー（未生成時プレースホルダー表示）
    ActivityLog.tsx              未使用（どこからもimportされていない）
    TeamCanvas.tsx                未使用
  output/FinalOutput.tsx        使用中 … 最終成果物のレンダリング
  thinking/ThinkingPanel.tsx    使用中 … 現状 thinking state は常にnullのため実質非表示
  workspace/AgentStatusList.tsx 使用中 … Agent一覧を固定配列でハードコード
                                     （planner/researcher/designer/engineer/stakeholder/reviewer/writerのみ。
                                       queryBuilder・analystは含まれていない）
  AgentCard.tsx                 未使用
  AgentStatus.tsx               未使用
  Sidebar.tsx (ルート直下)       未使用（layout/Sidebar.tsx が実際に使われる方）
  agent/AgentOutputs.tsx        未使用
  team/TeamHeader.tsx           未使用
  workflow/ProgressBar.tsx      未使用
  workflow/WorkflowTimeline.tsx 未使用

core/
  workflow/                     使用中 … ワークフロー実行エンジン本体
    index.ts                      runWorkflow / createWorkflow
    defaultWorkflow.ts            実運用で使うワークフロー定義（9ステップ）
    runAgent.ts                   1Agent分の実行（Prompt構築〜LLM呼び出し〜Tool実行〜保存）
    handlePlanner.ts              Planner出力から動的Agent列を組み立てる
    handleReviewer.ts             Reviewerの承認/差し戻し判定
    types.ts                      使用中 … Workflow / WorkflowStep 型（workflow/index.tsが使用）
    plannerTyoes.ts(typo) / reviewerTypes.ts
                                   未使用 … PlannerStep/PlannerResult/ReviewerResultという型を
                                           定義しているが、どこからもimportされていない
                                           （実装側は該当データを any で扱っている）

  agents/                       使用中 … 実際に実行される9Agentの定義
    index.ts, types.ts,
    planner.ts, queryBuilder.ts, researcher.ts, analyst.ts,
    designer.ts, engineer.ts, stakeholder.ts, reviewer.ts, writer.ts
    ※ Agent型のimport元がファイルごとに割れている。analyst.ts・queryBuilder.tsは
       同ディレクトリの "./types"（AgentIdに"analyst"を含む）から、それ以外の7ファイル
       （planner/researcher/designer/engineer/stakeholder/reviewer/writer）は
       レガシーな "../agent/types"（AgentIdに"analyst"を含まない）からimportしている。
       構造的に互換なフィールドのため実害はないが、型定義が二重管理になっている一例。

  agent/ (単数形、agents/ とは別ディレクトリ)   レガシー・未使用
    index.ts, types.ts, runtime.ts, queryBuilder.ts
    ※ core/agents/*.ts の一部（上記参照）や core/llm/types.ts などは Provider/Agent 型を
       今も "../agent/types" からimportしている箇所があるため、型定義としては生き残っている。
       実行ロジック（runtime.ts の runAgent など）は使われていない。

  context/                      使用中 … WorkflowContextの型と初期化
    index.ts, types.ts

  prompt/
    builder.ts                  使用中 … 唯一実際に呼ばれるPromptBuilder（buildPrompt）
    responsibilities.ts         使用中 … Agentごとの責務テキスト（buildPromptが参照）
    outputFormats.ts            使用中 … Agentごとの出力JSON雛形（buildPromptが参照）
    handoffs.ts                 未使用（空オブジェクトのみ。buildPrompt内にハンドオフ文言が直書きされている）
    compiler.ts, evidence.ts, format.ts, memory.ts, priority.ts,
    sections.ts, templates.ts, tools.ts, workflow.ts, outputs.ts
                                  未使用 … buildPromptと機能が重複するセクション別モジュール群。
                                          どこからもimportされていない。[提案] 将来builder.tsを
                                          分割する際の下敷きになり得るが、現状は死んでいるコード。

  evidence/
    selectEvidence.ts           使用中 … runAgentが各Agentへ渡すEvidenceを絞り込む
    retrieveEvidence.ts         使用中 … キーワード一致・出典種別・鮮度でスコアリングする実体
    checkEvidence.ts            使用中 … source欠落チェック（runWorkflowから呼ばれるがログ出力のみ）
    scoreEvidence.ts            使用中 … core/tools/pipeline/evidence.ts から呼ばれる
    rankEvidence.ts             未使用
    deduplicate.ts, indexEvidence.ts   未使用・中身が空ファイル

  tools/
    index.ts / registry.ts / runTool.ts / executeToolCalls.ts   使用中 … Tool実行の基盤
    webSearch.ts                使用中 … Tavily APIを叩くweb-search Tool
    calendar.ts                 使用中（registryに登録済みだが、どのAgentのtools配列にも含まれていない＝実質呼ばれない）
    github.ts                   未使用（registry.tsのtools配列に含まれていない）
    selector.ts                 未使用（selectToolsはどこからも呼ばれていない）
    pipeline/
      executeToolPipeline.ts      使用中 … Tool結果→Evidence化のオーケストレーション
      evidence.ts                 使用中 … 検索結果をEvidence配列へ変換（autoTag/score/重複除去）
      normalize.ts, autoTag.ts, removeDuplicates.ts   使用中（pipeline/evidence.tsから呼ばれる）
      deduplicate.ts, ranking.ts  未使用・空ファイル

  brain/                       使用中 … 実行履歴の分析と「学習」機構
    index.ts, types.ts, analyzer.ts, history.ts, memory.ts, pattern.ts, optimizer.ts
    詳細は「7. Optimizerの位置づけ」を参照

  optimizer/                   使用中 … Brainの分析結果を適用ルールへ変換する
    optimizer.ts, types.ts
    詳細は「7. Optimizerの位置づけ」を参照

  llm/
    index.ts                    使用中 … runLLM（providerに関わらず常にOpenAIを呼ぶ）
    types.ts                    使用中
    providers/openai.ts         使用中 … gpt-4o-mini / response_format: json_object

  router/                      未使用 … chooseModel/MODELSはどこからも呼ばれていない
    index.ts, models.ts, types.ts

  search/                      未使用 … core/tools/webSearch.ts とは別系統のTavilyラッパー。呼び出し元なし
    index.ts, types.ts, providers/tavily.ts, parser/evidenceParser.ts

  database/                    部分使用
    supabase.ts                  app/page.tsx から直接importされ、疎通確認用のクエリを実行している
    executions.ts                未使用（createExecutionはどこからも呼ばれていない）

  planner/getTeam.ts           使用中 … category文字列から固定Agent構成を返す（handlePlannerが使用）

  index.ts, orchestrator.ts, executor.ts, decision.ts, planner.ts, synthesizer.ts, agents.old.ts
                                未使用 … 初期プロトタイプの名残。
                                        core/index.ts の runTACT() が core/workflow ではなく
                                        core/orchestrator.ts 相当の古いパスを試作していたと見られるが、
                                        どこからもimportされていない。synthesizer.ts は空ファイル。

types/
  agent.ts, result.ts, task.ts, workflow.ts
                                未使用 … core/agent/types.ts・core/agents/types.ts など core 配下に
                                        同名の型が別途定義されており、実行パスはそちらを使う。
```

---

## 3. データフロー

ワークフロー全体で共有される状態は `WorkflowContext`（`core/context/types.ts`）一つです。
Agentはこのオブジェクトを直接読み書きします（イミュータブルではありません）。

| フィールド | 役割 | 更新するのは |
|---|---|---|
| `userInput` / `mode` | ユーザー入力と実行モード（quick/think/deep） | createContext（以降不変） |
| `outputs[agentId]` | 各Agentの最終パース済みJSON | runAgent |
| `stepOutputs[stepId]` | ステップID単位の出力（Writerへの"Workflow History"として渡る） | runAgent |
| `evidence[]` | 全Agent共有のEvidence配列 | runAgent（Researcher出力・Tool結果の両方から追加） |
| `memory[agentId]` | Reviewerが出した改善要求（Agent別） | runAgent（Reviewer実行時）/ handleReviewer |
| `handoffs[agentId]` | 各Agentが出力した `handoff` フィールド | runAgent |
| `agentStatus[agentId]` | running/completed/failed | runWorkflow |
| `logs[]` / `events[]` | 実行ログ・SSE配信用イベント | runWorkflow / runAgent |
| `finalOutput` | 最終成果物（= outputs.writer） | runWorkflow |
| `executionRecord` | Brain/Optimizer用の実行サマリ | runWorkflow |

Evidenceは2経路で `context.evidence` に追加されます（`core/evidence/rankEvidence.ts` は
既存Evidenceの並び替え・採点のみを行う関数で、どこからも呼ばれておらず、Evidenceを追加する経路には
なっていません。詳細はディレクトリ構成の「未使用」表記を参照）。

1. Researcherの `parsed.evidence.{category}[]` をrunAgentがフラット化して追加
   （このコードはEvidence項目のキー名として `name/topic/feature/metric/segment/model/headline` と
   `sources` を期待するが、実際の実行ログではResearcherが `claim/evidence/source/reason` という
   別のキー名でEvidenceを返している形跡があり、両者が一致していない可能性がある。
   詳細は `docs/agents.md` の Researcher の節を参照）
2. `web-search` Tool結果を `executeToolPipeline` → `executeEvidencePipeline` がEvidence化し、
   `toolResult.data.evidence` としてrunAgentが追加

Prompt構築時には `selectEvidence()` が `context.evidence` 全体からクエリ（ユーザー入力＋タスク＋Agent別キーワード）に
関連する上位15件だけを抽出して渡します（全件は渡さない）。

`context.memory[agentId]`（Reviewer Memory）には、書き込み元によって値の形が異なる2種類のデータが
混在します。`handleReviewer.ts` は `parsed.retry` に挙がったAgentへ改善要求を**文字列**のまま
push しますが、`runAgent.ts` はReviewerの `parsed.improvements` の文言から対象Agentを推測して、
`{rule, reason, priority, createdAt}` という**オブジェクト**（`BrainRule`型）をpushします
（`context/types.ts` の `memory` 型が `(string | BrainRule)[]` という共用体になっているのはこのためです）。
`buildPrompt()` はこの配列を `memory[agentId].map((m) => `- ${m}`)` として文字列化するため、
オブジェクトが混ざっている場合、そのエントリはテンプレートリテラルの既定の挙動により
`"- [object Object]"` として出力され、改善要求の内容がAgentへ実質的に伝わりません。

---

## 4. Provider構成

- `core/agent/types.ts` の `Provider` 型は `"openai" | "gemini" | "claude"` を許容し、
  各Agent定義（`core/agents/*.ts`）は `provider: "openai"` を指定しています。
- しかし `core/llm/index.ts: runLLM()` は **`request.provider` の値を見ずに常に `runOpenAI()` を呼びます**。
  Gemini/Claude用のprovider実装（`core/llm/providers/` 配下）は存在しません。
- `core/router/` (chooseModel, MODELS) はマルチモデル選択のための土台と見られますが、
  `runLLM` からも他のどこからも呼ばれていません。
- 実行時に使われるモデルは `core/llm/providers/openai.ts` にハードコードされた `gpt-4o-mini` のみです。
- `response_format: { type: "json_object" }` を指定し、Agentの出力は常にJSONとして扱われます
  （Function Calling / Tool Calling APIは使っておらず、Toolの呼び出し要求はJSON本文内の
  `toolRequests` フィールドとして表現される独自方式です。詳細は「6. Tool Callingの流れ」）。

**[提案]** Provider文字列とモデル実装が乖離しているため、`Agent.provider` フィールドは
現状は宣言のみで実効性がありません。マルチプロバイダ対応を進める場合は
`core/llm/index.ts` 側の分岐実装が必要です。

---

## 5. Prompt構成

実行時に使われるPromptBuilderは `core/prompt/builder.ts` の `buildPrompt()` 一つだけです。
（同名の責務を持つ分割ファイル群 `core/prompt/{compiler,evidence,format,memory,priority,sections,templates,tools,workflow,outputs}.ts`
は存在しますが未使用です。詳細は `docs/prompts.md` を参照）

`buildPrompt()` は以下のセクションを文字列テンプレートとして結合し、1つのuserPromptを組み立てます。

1. TACT Workflow（現在のAgent名）
2. Execution Mode（quick/think/deep）
3. Current Task（Plannerが割り当てたタスク文）
4. Original User Request
5. Agent Responsibilities（`responsibilities.ts` から）
6. Current Handoff（次に動くAgentへの引き継ぎ文言、builder.ts内にハードコード。引数として
   渡される `context.handoffs`（各Agentの `handoff` フィールドの集約）は実際には参照されていない）
7. Available Agents（`planner, queryBuilder, researcher, designer, engineer, stakeholder, reviewer, writer`
   の固定リスト。実際に実行される9番目のAgentである `analyst` がこのリストに含まれていない）
8. Available Tools（`core/tools/index.ts` の `tools` から自動生成）
9. Brain Memory（`core/brain/memory.ts: formatBrainMemory()` … 過去実行から蓄積された改善ルール）
10. Reviewer Memory（`context.memory[agentId]`）
11. Workflow History（`context.stepOutputs` 全件）
12. Outputs from Other Agents（`visibleOutputs[agentId]` で定義された、閲覧許可されたAgentの出力のみ）
13. QueryBuilder Search Strategy（Researcher実行時のみ）
14. Shared Evidence（`selectEvidence()` で絞り込んだ上位Evidence）
15. Tool Results（有無のみを "[Tool Results Available]" として通知。中身はプロンプトに埋め込まれない）
16. Agent Rules（builder.ts内にハードコードされた簡易ルール。`responsibilities.ts`と内容が一部重複）
17. Handoff（handoffフィールドを出力するよう指示）
18. Output Format（`outputFormats.ts` から、Agentごとの出力JSON雛形）

各Agent自身の `systemPrompt`（`core/agents/*.ts` で定義）は `runLLM` 呼び出し時に
`systemPrompt` として別枠で渡され、`buildPrompt()` の出力（上記1〜18）は `userPrompt` として渡されます。

なお「18. Output Format」（`outputFormats.ts`）の内容は、多くのAgentで `systemPrompt` 本文が
独自に提示している出力フォーマット例と一致していません（フィールド名や構造が異なる、または
`outputFormats.ts` 側の例文にJSON構文の誤りがある）。詳細は `docs/prompts.md`「4. 出力フォーマット
定義の重複について」と `docs/agents.md` の各Agentの節を参照してください。

---

## 6. Tool Callingの流れ

TACTはOpenAIのFunction Calling機能を使っていません。Tool呼び出しは、
Agentが返すJSON内の `toolRequests` フィールドを介した自前プロトコルです。

```
1. Agent（主にResearcher）が1回目のLLM応答で
   { "toolRequests": [{ "tool": "web-search", "arguments": { "query": "..." } }, ...] }
   を返す

2. runAgent.ts が
   agent.tools.length > 0 かつ parsed.toolRequests が非空配列の場合のみ
   executeToolCalls(toolRequests, userInput) を実行

3. executeToolCalls → executeToolPipeline（リクエストごとに直列実行）
     → runTool(toolId, arguments) → core/tools/registry.ts の Map から該当Toolを検索して execute()
     → tool.id === "web-search" の場合のみ、結果を executeEvidencePipeline() でEvidence化
        （normalize → autoTag → scoreEvidence → removeDuplicates）

4. Tool結果はcontext.evidenceへ追加され、かつ toolResults として保持される

5. runAgent.ts は同じAgentに対して buildPrompt()を作り直し、
   「Tool実行は完了している。toolRequestsは空配列にしてJSONを完成させよ」という
   追加指示文を付けて runLLM() を再実行する（1Agentにつき最大2回のLLM呼び出し）

6. 2回目の応答をパースし、それを最終的な parsed として採用する
```

- Tool定義は `core/tools/index.ts` の `tools` 配列（現状 `web-search` と `calendar` のみ）に
  登録されたものだけが `runTool` から呼び出せます。`github.ts` は実装済みだが未登録のため呼ばれません。
- どのAgentがどのToolを使えるかは `Agent.tools: string[]`（`core/agents/*.ts`）で宣言されますが、
  実際に `tools.length > 0` なのは Researcher（`web-search`）・Designer（`figma`、未実装）・
  Engineer（`github`, `npm`、未実装）・Writer（`markdown`、未実装）のみで、
  実際にToolRegistryへ登録・実行可能なのは Researcher の `web-search` だけです。
- Plannerが `toolRequests` を返した場合は `runAgent.ts` 内で明示的に無視・削除されます
  （Plannerはツールを実行しない設計）。

---

## 7. Optimizerの位置づけ

TACTには名前が紛らわしい「2つのoptimizer的な仕組み」が存在します。ワークフロー実行を
制御するものではなく、**実行後に評価し、次回以降のPromptへ反映するための後処理**という位置づけです。

```
runWorkflow() の実行ループ終了後
  ↓
core/brain/history.ts: getExecutionHistory()
  … ただし保存関数 saveExecutionRecord() はどこからも呼ばれておらず、
    このhistoryは常に空配列です（下記「既知の課題」参照）
  ↓
core/brain/pattern.ts: analyzePatterns(history) → 空配列を返す（historyが空のため）
  ↓
core/brain/optimizer.ts: optimizeWorkflow(userInput, patterns)
  … patterns.length === 0 なら null を返す。
    ワークフロー開始"前"に呼ばれ、Agent構成やmodeを推奨する想定だが、
    結果（brainRecommendation）は console.log されるだけで dynamicPlan には反映されない。

（ワークフロー実行）

  ↓
core/brain/index.ts: analyzeExecution(context)
  … Reviewerのissues/improvements、Evidence不足、失敗Agentの有無から
    簡易スコア（100点満点、issue1件につき-10点）と改善ルール(improvements/nextRules)を算出
  ↓
core/optimizer/optimizer.ts: optimizeExecution(context)
  … analyzeExecutionの結果（quality.improvements）を appliedRules としてそのまま採用し、
    targetAgentがあれば agentAdjustments に振り分け、promptUpdatesとしてルール文字列を並べる
    （現状 analyzeExecution が targetAgent を設定しないため agentAdjustments は常に空）
  ↓
core/brain/memory.ts: saveBrainMemory(optimizerResult.appliedRules)
  … ルールをメモリ配列（最大50件、rule文字列で重複排除）に追加保存
  ↓
次回以降の buildPrompt() 実行時、formatBrainMemory() が
  このメモリを「Brain Memory」セクションとして全Agentのプロンプトに埋め込む
```

つまり現状のOptimizerは：

- ワークフローの**実行順序やAgent選択そのものを変更する権限は持たない**
  （Plannerの動的計画・Reviewerの差し戻しとは独立した経路）
- 役割は「直近の実行を評価し、改善ルールをテキストとしてBrain Memoryに蓄積し、
  次回のPromptに文脈として注入する」ことに限定される
- 評価はReviewerの出力とEvidence有無・失敗Agentの有無という限られたシグナルのみに基づく

### 既知の課題（現状の事実であり、修正の指示ではありません）

- `core/brain/history.ts` の `saveExecutionRecord()` を呼ぶ箇所が存在しないため、
  `getExecutionHistory()` は常に空配列を返し、`optimizeWorkflow()` は毎回 `null` になります。
  実行履歴に基づく事前最適化は事実上機能していません。
- `core/brain/optimizer.ts`（`optimizeWorkflow`）と `core/optimizer/optimizer.ts`（`optimizeExecution`）は
  ファイル名・概念名が非常に似ていますが、別の入出力を持つ別の関数です。
- `brainMemory` / `executionHistory` はいずれもプロセス内グローバル変数（モジュールスコープの配列）であり、
  永続化されません。サーバー再起動やサーバーレス関数の再起動でリセットされます。
