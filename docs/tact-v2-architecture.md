# TACT v2 Architecture

このドキュメントは、TACTを**10〜30Agent規模・Tool Calling・Memory・Workflow・Optimizer・
Parallel Executionを前提としたAI Orchestrator**へ育てるための、長期（数年スパン）を見据えた
目標アーキテクチャ（North Star Design）です。

`docs/architecture.md`（現状の正確な記録）・`docs/agents.md`（現状のAgent仕様）・
`docs/data-schemas.md`（スキーマ統一の設計とv1移行計画）が「今どうなっているか／
どう直すか」を扱うのに対し、本ドキュメントは**「将来どうあるべきか」**を扱います。
現在の実装に縛られず設計しますが、8章末までに述べる通り、**現在の実装（TACT v1）から
段階的に到達可能であること**を設計上の必須制約としています。今回はコードを一切変更せず、
設計のみを行います。

---

## 設計思想（全体を貫く方針）

TACT v2の設計は、以下の4つの原則に貫かれています。各章の個別設計は、すべてこの原則から
導かれています。

**原則1: 「宣言」が唯一の情報源になること（Single Source of Truth）**

現状のTACT（v1）最大の構造的問題は、1つの概念（Agentの出力形・利用可能Agent一覧・
責務説明）が`systemPrompt`本文・`outputFormats.ts`・`responsibilities.ts`・`builder.ts`内の
ハードコードなど、**複数の場所に手動で重複記述**されていることです（`docs/agents.md`・
`docs/data-schemas.md`で実測込みで確認済み）。人間が同期を保ち続けることを前提にした設計は、
Agentが9体の現在でも既に破綻しています（`availableAgents`固定リストからAnalystが漏れていた
事例が象徴的）。v2では、**Agentごとに1つの「宣言（Agent Definition）」だけを書けば、
Prompt・型・実行順序・UIへの露出がすべてそこから導出される**ことを最優先します。

**原則2: 機構（Mechanism）と方針（Policy）を分離すること**

Workflowエンジン（誰をどの順で・どう並列に動かすか＝機構）と、Optimizer/Planner
（何を選ぶべきか＝方針）を明確に分離します。現状でも「Optimizerは評価専任」という原則は
`CLAUDE.md`に既に明記されていますが、v2ではこれを**アーキテクチャ上も強制**します。
Optimizerは常に「提案（Suggestion）」しか書き込めず、実行を直接書き換える権限を持ちません。

**原則3: 段階性（Incrementality）こそが長期保守性である**

30Agent・並列実行・多層Memoryをいきなり実装することはリスクが高すぎます。v2は
「一度に全部作り替える設計」ではなく、**各要素を独立にオン・オフできる設計**にします
（例：DAG実行エンジンは、依存関係が単純な鎖であれば現状の線形実行と完全に同じ挙動になる
"退化ケース"として実装する）。これにより、12章の移行計画は「並行して進められる複数の
小さな変更」として設計できます。

**原則4: Agentの数が増えても、人間が読むべき箇所は増えないこと**

Agentが9体から30体になったとき、既存の`visibleOutputs`のような「全Agent×全Agent」の
手書き表は破綻します。v2では、Agent一人ひとりが「自分は何に依存するか」だけを宣言し、
「誰が誰を見るか」はシステムが**依存グラフから自動導出**します。人間が把握すべき情報量は
Agent数に比例して増えるのではなく、**新しく追加したAgent1体分だけ**に抑えます。

---

## 1. 現状アーキテクチャ

詳細は`docs/architecture.md`を正としますが、v2設計の前提として要点のみ再掲します。

- **Workflow実行**：`core/workflow/index.ts: runWorkflow()`が、`WorkflowStep[]`という**単一の
  線形配列**（`dynamicPlan`）を`currentStep`カウンタで順番に消化するwhileループ。並列実行の概念は無い。
- **Agent定義**：`core/agents/*.ts`が、Agentごとに`{id, name, role, provider, tools, rules,
  systemPrompt}`という素朴なオブジェクトをエクスポートするだけ。依存関係・出力スキーマ・
  Tool能力などのメタデータは存在しない。
- **Prompt構築**：`core/prompt/builder.ts`の`buildPrompt()`1関数が、18種類のセクションを
  文字列結合で組み立てる巨大関数。Agentごとの可視範囲（`visibleOutputs`）・責務
  （`responsibilities.ts`）・出力形式（`outputFormats.ts`）は、それぞれ別々の
  `Record<AgentId, string>`として手動で同期されている。
- **Tool Calling**：OpenAIのFunction Calling APIは使わず、JSON本文内の`toolRequests`
  フィールドという自前プロトコル。Tool実行後、同じAgentへもう一度LLM呼び出しを行う
  「2パス方式」。
- **Memory**：`context.memory`（1回の実行限りのReviewer Memory）と、モジュールスコープの
  グローバル変数`brainMemory`（プロセス起動中のみ有効なBrain Memory）の2系統が併存し、
  値の型も統一されていない（`docs/architecture.md`「3. データフロー」参照）。永続化は無い。
- **Optimizer/Brain**：`core/brain/*`と`core/optimizer/*`という、名前が非常に紛らわしい
  2つの仕組みが存在し、実行後の評価とルール抽出は行うが、ワークフロー実行そのものへの
  介入権限は持たない（設計原則としては正しいが、実装は分かりにくい）。
- **Provider**：`Agent.provider`は`"openai"|"gemini"|"claude"`を許容するが、
  `core/llm/index.ts: runLLM()`は常にOpenAIを呼ぶ。マルチプロバイダ対応は名ばかり。
- **並列実行**：無し。全Agentは1ステップずつ、常に直列に実行される。

## 2. 問題点

現状アーキテクチャの構造的な問題を、これまでの調査（`docs/agents.md`, `docs/prompts.md`,
`docs/data-schemas.md`）で確認済みの事実に基づいて整理します。

### 2.1 スケールしない「手動同期」設計

Agentを1体追加するたびに、`core/agents/index.ts`（登録）・`responsibilities.ts`（責務）・
`outputFormats.ts`（出力形式）・`builder.ts`内の`visibleOutputs`/`agentRules`/
`handoffInstructions`（3つの`Record<AgentId, string>`）・`core/planner/getTeam.ts`（Planner用
固定構成）という**最低6箇所**を手動で編集する必要があります。9体の現在でも同期漏れ
（`availableAgents`からAnalystが漏れていた）が発生しており、30体規模では現実的に維持できません。

### 2.2 スキーマの強制力が無い

`docs/data-schemas.md`の実測調査で、Researcher・Reviewer・Writerは**同じsystemPromptのまま
実行のたびに異なる形のJSONを返す**ことが確認されています。TypeScriptの型は実行時のLLM出力を
検証しないため、現状は「ドキュメント上は決まっているが、実際には決まっていない」状態です。

### 2.3 並列実行できない

`researcher`が完了した後、`designer`・`engineer`・`stakeholder`はいずれもAnalystの出力
（あるいはEvidence）だけを見て動作でき、互いに依存していません（`visibleOutputs`の定義上も
確認できます）。にもかかわらず、現在のワークフローエンジンは単一配列を順番に消化するだけなので、
**本来並列化できるはずのAgentが直列に実行され、レイテンシが線形に積み上がります**。

### 2.4 Workflow Historyが際限なく肥大化する

`buildPrompt()`の「Workflow History」セクションは、実行済み全ステップの出力をJSON丸ごと
埋め込みます。Agent数・ステップ数が増えるほどプロンプトサイズは線形に増加し、10〜30体規模では
コンテキスト長・コスト・レイテンシの面で破綻します。現状、トークン予算という概念自体が
存在しません。

### 2.5 Optimizer/Brainの責務と命名が混乱している

`core/brain/optimizer.ts`（`optimizeWorkflow`、実行前の推奨）と`core/optimizer/optimizer.ts`
（`optimizeExecution`、実行後の評価）という、名前も概念も紛らわしい2つの仕組みが存在します。
さらに`optimizeWorkflow`が計算する`brainRecommendation`は`console.log`されるだけで、実際の
Agent選択には一切反映されません（`getExecutionHistory()`が常に空配列を返すため、実質的に
毎回`null`）。「評価はするが実行制御はしない」という設計思想自体は正しいのですが、
実装がその思想を体現できていません。

### 2.6 Memoryの層が無い

「今回の実行限りの情報」（Reviewerの指摘）と「実行をまたいで蓄積すべき知見」（Brain Memory）が
概念上は分かれているのに、後者は永続化されずプロセス再起動で消えます。加えて、Agent間の
「申し送り」（`handoff`）は`WorkflowContext.handoffs`に保存されるものの、`buildPrompt()`は
この値を一切読まない（未結線の引数）という実装漏れがあります。つまり**3層あるべきMemory
（短期・引き継ぎ・長期）が、実質1.5層程度しか機能していません**。

### 2.7 Tool Callingが自前プロトコルに閉じている

`toolRequests`というJSON本文ベースの自前プロトコルは、OpenAIのFunction Calling/Tool Use APIの
恩恵（スキーマに基づく厳密な引数検証、ネイティブな並列Tool呼び出し等）を受けられません。
また、Tool結果がEvidence化されるかどうかが`request.tool === "web-search"`という
ハードコードされた1行で決まっており、Tool追加のたびにこの判定コードに手を入れる必要があります。

### 2.8 Provider戦略が名目だけ

`Agent.provider`フィールドと`core/router/`（未使用）が「マルチプロバイダ対応の骨組み」として
存在しますが、実際には常にOpenAIしか呼ばれません。Agentごとに最適なモデル（コスト・速度・
品質のトレードオフ）を選ぶという発想自体は正しいのに、実装として機能していません。

### 2.9 観測性が低い

実行ログは`logs/<timestamp>-<agentId>.json`という単純なファイル出力で、実行全体を横断して
「どのAgentがなぜ再実行されたか」「並列に動いたAgent間の時系列」などを追跡する仕組みがありません。
30体規模でAgentの相互作用をデバッグするには不十分です。

---

## 3. 理想構成

以上を踏まえ、TACT v2は次のような形の**Orchestrator**として設計します。

```
                     ┌─────────────────────────┐
                     │      Agent Registry       │  ← 1体1体の宣言（原則1）
                     │  (id, schema, deps,       │
                     │   tools, prompt, model)   │
                     └────────────┬──────────────┘
                                  │ 導出
                                  ▼
┌───────────┐   計画    ┌─────────────────────┐   実行   ┌───────────────┐
│  Planner   │─────────▶│   Workflow Graph      │─────────▶│  Execution     │
│ (方針)     │           │  (DAGビルダー)         │          │  Engine (機構) │──▶ 並列実行
└───────────┘           └─────────────────────┘          └───────┬───────┘
      ▲                                                            │
      │ 提案（書き込みのみ、実行制御権限なし）                          │ 読み書き
┌───────────┐                                                     ▼
│ Optimizer  │◀───────────────────────────────────────  ┌───────────────┐
│ (評価専任) │            分析対象                        │  3層Memory     │
└───────────┘                                            │ 短期/引継/長期  │
                                                          └───────────────┘
```

- **Agent Registry**が唯一の情報源（原則1）。Prompt構成・可視範囲・Tool能力・型は
  すべてここから導出される。
- **Planner（方針）**と**Execution Engine（機構）**を分離（原則2）。Plannerは
  「どのAgentをどんな依存関係で動かすか」という**部分グラフ**を選ぶだけで、実際に
  トポロジカルソートして並列実行するのはExecution Engineの責務。
- **Optimizer**はExecution EngineにもPlannerにも直接介入せず、3層Memoryへ「提案」を
  書き込むだけ。Plannerがその提案を読むかどうかは、Plannerの裁量。
- 現状の9Agent・線形実行は、この図の**退化ケース**（依存グラフが1本の鎖、並列度1）として
  そのまま表現できる（原則3）。

## 4. モジュール構成

```
core/
  registry/                    Agent Registry の実体
    agentRegistry.ts             全Agent定義の登録・参照API
    types.ts                     AgentDefinition 型（5章）

  agents/
    <agentId>/
      definition.ts               AgentDefinition（メタデータ：依存・Tool・schema参照）
      prompt.ts                    systemPromptテンプレート本文のみ
    index.ts                      registryへの一括登録

  schemas/                      スキーマ（型 + 実行時バリデーション）の単一情報源
    primitives.ts                 EvidenceItem/SharedEvidence/Handoff/ImprovementNote等
                                   （docs/data-schemas.md 3.2の内容をそのまま正式化）
    <agentId>.schema.ts          Agentごとのペイロードschema（docs/data-schemas.md 3.3を正式化）
    generate-format.ts            schemaからPrompt用サンプルJSONを生成するユーティリティ

  workflow/
    graph.ts                     依存グラフ構築（AgentDefinition.dependsOnから導出）
    engine.ts                    DAG実行エンジン（トポロジカル実行・並列度制御・部分再実行）
    planner.ts                   Planner Agentの呼び出しとグラフへの変換
    retryPolicy.ts                Reviewer差し戻し時の「影響範囲だけ再実行」ロジック

  memory/
    shortTerm.ts                  1回の実行に閉じたExecutionContext
    workingMemory.ts               Handoffの読み書き（実際にbuildPromptへ結線する）
    longTerm/
      store.ts                     永続化インターフェース（Supabase実装を想定）
      patterns.ts                  Brain由来のパターン分析

  tools/
    registry.ts                    Tool定義＋Capabilityタグ
    adapters/
      nativeFunctionCalling.ts     プロバイダのTool Use APIを使うアダプタ
      jsonProtocol.ts               現行のtoolRequests方式（フォールバック・後方互換用）
    evidenceProducers.ts            「どのToolがEvidenceを生むか」の宣言的な設定

  prompt/
    compose.ts                     Agent Definition + Schema からPromptを合成する本体
    sections/                      現行core/prompt/*の"orphanedな良い設計"を正式に活用
      responsibilities.ts, evidence.ts, memory.ts, tools.ts, outputFormat.ts, workflow.ts …
    budget.ts                      トークン予算に基づくセクション選別・要約

  optimizer/
    analyzer.ts                    実行後評価（現core/brain/analyzer.tsを承継）
    suggestions.ts                 提案の書き込みのみ。Workflow/Plannerへの直接介入なし

  llm/
    router.ts                      Agentごとのモデル/プロバイダ選択を実際に機能させる
    providers/                     openai.ts に加え claude.ts, gemini.ts 等を追加

  observability/
    tracer.ts                      実行トレース（DAGの各ノードの開始/終了/依存関係を記録）
    logStore.ts                     logs/ をファイルダンプから構造化ストアへ
```

現行の`core/agents/*.ts`（systemPromptオブジェクト）は`agents/<agentId>/prompt.ts`へ、
`core/prompt/builder.ts`は`prompt/compose.ts` + `prompt/sections/*`へ、それぞれ役割を保ったまま
分割・整理される形になります。**まったく新しい概念を持ち込むのではなく、現行モジュールの
責務を明確化し、手動同期をやめて宣言から導出する**という変更が中心です。

## 5. Agent構成

Agentは「システムプロンプトを持つオブジェクト」ではなく、**Registryに登録される宣言
（AgentDefinition）**として再定義します。

```ts
interface AgentDefinition<TPayload = unknown> {
  id: string;                      // 一意識別子。AgentId型は「Registryに登録されたidの集合」から自動導出される
  name: string;
  team?: string;                    // 11章：役割グループ（例 "research", "delivery"）
  role: string;

  // このAgentが実行される前に、どのAgentの出力が確定していなければならないか
  dependsOn: string[];

  // このAgentの出力がどのAgentから参照されるかは、ここから逆算する
  // （現行の visibleOutputs を手書きしない。参照したいAgentが dependsOn に自分を書く）

  schema: {
    input?: ZodType<unknown>;       // 受け取るペイロードの形（省略時は依存Agent全出力）
    output: ZodType<TPayload>;      // 出力の形。docs/data-schemas.md 3.3のインターフェース群を正式化
  };

  tools: {
    capability: string;             // "web-search" のような具体Tool名ではなく能力タグ
    required: boolean;
  }[];

  prompt: {
    template: PromptTemplate;       // systemPrompt本文
    version: number;                 // プロンプト変更履歴を追える
  };

  execution: {
    concurrencySafe: boolean;        // 他Agentと並列実行してよいか（副作用があるAgent向けの逃げ道）
    maxRetries: number;               // Reviewer差し戻し時の再試行上限（現行のグローバルMAX_REVIEWを個別化）
    preferredModel?: { provider: string; model: string }; // 10章と連動
  };
}
```

- 9Agent（Planner, QueryBuilder, Researcher, Analyst, Designer, Engineer, Stakeholder,
  Reviewer, Writer）は、この`AgentDefinition`へそのまま1対1で移行できます。
  `dependsOn`は現行の`visibleOutputs`の値をほぼそのまま転記するだけで済みます
  （例：`writer.dependsOn = ["planner","researcher","analyst","designer","engineer",
  "stakeholder","reviewer"]`）。
- 新しいAgentを追加する場合、開発者が書くのは**この1オブジェクトだけ**です。
  Prompt生成・可視範囲・型・Tool許可・実行順序は、すべてここから導出されます
  （原則4）。

## 6. Workflow構成

線形配列（`WorkflowStep[]`）を、**AgentDefinition.dependsOnから構築される有向非巡回グラフ
（DAG）**に置き換えます。

```ts
interface WorkflowGraph {
  nodes: Map<string, WorkflowNode>;    // key = AgentId
  edges: Map<string, string[]>;         // agentId -> それに依存しているagentIdたち
}

interface WorkflowNode {
  agentId: string;
  status: "pending" | "ready" | "running" | "completed" | "failed" | "retrying";
  attempt: number;
}
```

**実行アルゴリズム（Execution Engine）**：

1. Plannerが「今回のタスクに必要なAgentの集合」を選ぶ（現行の`plan`と同じ役割）。
2. その集合と各Agentの`dependsOn`から`WorkflowGraph`を構築する。
3. 依存が全て`completed`になったノードから`ready`にし、**同時に複数`ready`なノードがあれば
   並列実行**する（並列数の上限は設定可能な同時実行数キャップで制御）。
4. Reviewerが`retry`を指定した場合、**そのAgentと、それに依存する下流ノードだけ**を
   `pending`へ戻す（現行のように「Researcherへ丸ごと戻る」フォールバックではなく、
   影響範囲だけを再実行する）。
5. `execution.maxRetries`を超えたノードは、そのノードを`failed`のまま最終出力へ進む
   （現行の`MAX_REVIEW`グローバルカウンタを、ノード単位の予算に個別化）。

**現行v1との互換性**：9Agentの依存関係は事実上「鎖」に近い形（Planner→QueryBuilder→
Researcher→Analyst→{Designer,Engineer,Stakeholder}→Reviewer→Writer）なので、
DAG実行エンジンに置き換えても、**Designer/Engineer/Stakeholderの3つが並列化される以外は
現行と全く同じ実行順序・同じ結果**になります。これは「実装を変えても振る舞いは壊さない」
移行の好例です（12章 Phase C/D）。

## 7. Memory構成

Memoryを3層に明確化し、それぞれ読み書きできる主体を固定します。

| 層 | 内容 | 現行での相当物 | 永続化 | 読み書きの主体 |
|---|---|---|---|---|
| **短期（Execution Context）** | 今回の実行1回限りのAgent出力・Evidence | `WorkflowContext` | 無し（実行終了で破棄） | 全Agent（自分の出力を書く、依存先の出力を読む） |
| **引き継ぎ（Working Memory）** | Agent間の申し送り（`Handoff`） | `context.handoffs`（現状未結線） | 短期と同じ | 出力するAgentが書き、`dependsOn`で指定した下流Agentだけが読む |
| **長期（Long-term Memory）** | 実行をまたいで蓄積する改善ルール・実行パターン | `brainMemory`/`executionHistory`（プロセス内グローバル、揮発） | **あり（Supabase）** | Optimizerだけが書く。全Agentが読む（Prompt注入経由） |

- **短期→引き継ぎの結線を修復**：`docs/prompts.md`で確認した「`buildPrompt()`が`handoffs`
  引数を受け取りながら一度も参照していない」問題を解消し、`workingMemory.ts`が
  `dependsOn`に基づいて「このAgentが読むべきHandoffだけ」を選んでPromptへ注入します。
- **長期Memoryの永続化**：`brainMemory`/`executionHistory`は現状プロセス再起動で消える
  モジュールスコープ変数です。TACTは既に`@supabase/supabase-js`に依存しているため
  （現状`app/page.tsx`で疎通確認にしか使われていない）、これをMemoryの永続先として採用します。
  これにより、Optimizerの学習がサーバー再起動やデプロイをまたいで蓄積されるようになります。
- **改善要求の型統一**：`docs/data-schemas.md`で提案した`ImprovementNote`をそのまま
  長期Memoryのレコード形式として採用し、Reviewer由来（1回の実行）とBrain由来
  （横断的パターン）を`source`フィールドで区別しつつ、同じ形で扱います。

## 8. Tool構成

```ts
interface ToolDefinition {
  id: string;
  capabilities: string[];           // Agentのdependsではなく「能力」で紐付ける
  producesEvidence: boolean;         // ハードコードされた"web-search"判定をやめ、宣言的にする
  parameters: ZodType<unknown>;
  execute(input: unknown): Promise<ToolResult>;
}

interface ToolCallAdapter {
  // プロバイダのネイティブTool Calling / Function Calling を使う経路と、
  // 現行のJSON本文プロトコルを使う経路を、同じインターフェースの裏に隠す
  supportsNativeCalling(provider: string): boolean;
  buildRequest(agent: AgentDefinition, tools: ToolDefinition[]): unknown;
  parseResponse(raw: unknown): { toolCalls: ToolRequest[]; content: string };
}
```

- **能力ベースのTool割当**：Agentは`tools: [{capability: "web-search"}]`のように「能力」を
  宣言し、実際にどのTool実装がその能力を満たすかはRegistry側の対応表で決まります。
  Tool実装を差し替えても（例：Tavily→別の検索API）、Agent定義側の変更は不要です。
- **プロトコルの二重化を吸収**：`ToolCallAdapter`により、プロバイダがネイティブなTool Use APIを
  持つ場合はそちらを優先し、持たない場合は現行の`toolRequests`JSON方式にフォールバックします。
  これにより、8章で挙げた「自前プロトコルに閉じている」問題を、**現行プロトコルを廃止せずに**
  解消できます（後方互換）。
- **Evidence化判定の宣言化**：`request.tool === "web-search"`というハードコードを、
  `ToolDefinition.producesEvidence`という宣言に置き換えます。将来Tool数が増えても、
  この1行を書き換える必要はありません。

## 9. Prompt構成

`core/prompt/builder.ts`の巨大な単一関数を、既に存在する（が未使用の）
`core/prompt/{compiler,evidence,format,memory,priority,sections,templates,tools,workflow,
outputs}.ts`という**セクション別モジュールの設計思想を正式に採用**し、以下のパイプラインへ
再構成します。

```ts
function composePrompt(agent: AgentDefinition, ctx: ShortTermMemory): string {
  const sections = [
    buildResponsibilitiesSection(agent),
    buildDependencyOutputsSection(agent, ctx),   // 現visibleOutputsをdependsOnから自動導出
    buildWorkingMemorySection(agent, ctx),        // Handoffの実結線（7章）
    buildEvidenceSection(agent, ctx),
    buildToolsSection(agent),
    buildLongTermMemorySection(agent, ctx),       // Brain Memoryの後継
    buildOutputFormatSection(agent),               // schemaから自動生成（下記）
  ];
  return applyBudget(sections, agent.execution.tokenBudget);  // 10〜30体規模でのコンテキスト管理
}
```

- **出力フォーマットの自動生成**：`docs/data-schemas.md`で確認した「`systemPrompt`本文の
  出力例と`outputFormats.ts`のエントリが一致しない」問題は、そもそも**人間が2箇所に
  手で例文を書いていること自体が原因**です。v2では`schemas/<agentId>.schema.ts`
  （5章のzod/型定義）から出力フォーマットの説明文を自動生成し、**例文を書く場所を1箇所に
  減らします**。
- **トークン予算管理**：`applyBudget()`が、Agent数・出力サイズの増大に応じて、
  優先度の低いセクション（古いWorkflow Historyの詳細など）を要約・省略します。
  現行の「常に全件をそのまま埋め込む」設計から、8〜9章の課題（2.4）に対応します。
- **プロンプトのバージョン管理**：`AgentDefinition.prompt.version`により、プロンプト変更の
  履歴を追跡可能にします（将来的なA/Bテスト・ロールバックの土台）。

## 10. Optimizer構成

Optimizerの責務は現行から変えません（評価専任という原則は維持）。変えるのは**構造の明確さ**です。

```ts
interface OptimizerSuggestion {
  scope: "next-execution" | "long-term-pattern";
  targetAgent?: string;
  suggestion: ImprovementNote;
  confidence: number;
}

// Optimizerが書けるのはここだけ。WorkflowGraph・Execution Engineへの参照は一切持たない
function analyzeAndSuggest(executionRecord: ExecutionRecord): OptimizerSuggestion[];

// Plannerだけが読み、採用するかどうかを判断する（Optimizerは「採用させる」権限を持たない）
function readSuggestionsForPlanning(): OptimizerSuggestion[];
```

- **命名の統合**：現行の`core/brain/optimizer.ts`（`optimizeWorkflow`）と
  `core/optimizer/optimizer.ts`（`optimizeExecution`）という紛らわしい2ファイルを、
  「実行前の提案」「実行後の分析」という**同一モジュール内の2フェーズ**として統合します。
- **実際に機能させる**：現行の`brainRecommendation`は計算されても`console.log`されるだけで、
  Plannerの意思決定に反映されません（7章の永続化により`getExecutionHistory()`が空を
  返す問題も解消されるため、提案の質自体も向上します）。ただし、**Plannerが提案を採用するか
  どうかは常にPlanner側の裁量**とし、Optimizerが直接Agent選択やWorkflowGraphを書き換える
  経路は設けません（原則2の維持）。
- **スコアの一本化**：現行、Reviewerの自己申告スコアとBrainの独自採点式という2系統が
  並存しています。v2では「品質スコアはOptimizerが実行後に算出する1つの値」に統一し、
  Reviewerの`score`は「Reviewer個人の所感」として`ImprovementNote`側に残しつつ、
  ワークフロー全体の品質指標としては使わないという役割分担を明確にします。

## 11. 拡張戦略

10体から30体へ育てる際に、複雑さを線形以下に抑えるための戦略です。

- **チーム（役割グループ）による分割統治**：Agentを個別に管理するのではなく、
  `AgentDefinition.team`で緩くグループ化します（例：`research`チーム＝QueryBuilder+
  Researcher+将来のFactChecker、`delivery`チーム＝Writer+Reviewer+将来のFormatter）。
  Plannerは個々のAgentではなく、まず必要な**チーム**を選び、チーム内の具体的なAgent構成は
  チームごとのデフォルトDAGとして事前定義しておく、という2段階の意思決定にすることで、
  Plannerが一度に比較検討するAgent数を実質的に減らします。
- **契約のバージョニング**：`schema.output`にバージョンを持たせ（例：`ResearchResultV1`→
  `ResearchResultV2`）、下流Agentが古いバージョンのschemaにしか対応していない場合でも、
  変換アダプタを挟むことで壊さずに新しいAgentへ移行できるようにします。
- **能力ベースのAgent選択**：Plannerが「researcherというAgent名」ではなく「情報収集という
  能力」を要求し、Registry側で能力→Agentの対応を解決する設計にしておくと、同じ役割を持つ
  Agentを複数（例：`researcher-jp`, `researcher-en`）用意しても、Plannerのロジックを
  変えずに拡張できます。
- **モデル/プロバイダのAgent別最適化**：`AgentDefinition.execution.preferredModel`により、
  「Plannerは高精度・低頻度なのでOpus級」「QueryBuilderは軽量・高頻度なのでHaiku級」
  といった配分を、Agent追加時に個別最適化できるようにします（9章で骨組みだけ存在する
  Provider戦略を実際に機能させる）。
- **並列実行数のガバナンス**：Agent数が増えるほど、同時にreadyになるノード数も増え得るため、
  Execution Engineの同時実行数キャップ（グローバル上限＋Tool APIのレート制限を考慮した
  Tool別上限）をv2の必須機能として組み込みます。

## 12. 段階的移行計画

`docs/data-schemas.md`のPhase 1〜7（スキーマ統一）を**前提として引き継ぎ**、その先に
アーキテクチャ移行のフェーズを積み重ねます。各フェーズは独立してリリース可能な粒度に
分割し、**既存の9Agent・線形ワークフローが常に動き続けること**を維持しながら進めます。

| Phase | 内容 | 前提 | 破壊的変更 |
|---|---|---|---|
| **A** | `docs/data-schemas.md`のPhase 1〜5（スキーマ統一・実害バグ修正） | なし | 小 |
| **B** | `AgentDefinition`の導入。既存9Agentの`systemPrompt`オブジェクトを`AgentDefinition`でラップするだけ（`dependsOn`は現行`visibleOutputs`の値をそのまま転記）。Workflowエンジンの挙動は変えない | Phase A | 無し（追加的変更） |
| **C** | `WorkflowGraph`/Execution Engineの導入。ただし全依存関係が「鎖」になるよう構成し、**現行と完全に同じ実行順序・同じ結果**になることをテストで担保する（並列化はまだしない） | Phase B | 無し（挙動保存のリファクタ） |
| **D** | 並列実行の有効化。Designer/Engineer/Stakeholderなど、依存関係上並列化可能なノードから並列実行を有効にする | Phase C | 小（レイテンシ改善が主目的、出力内容は不変） |
| **E** | 3層Memoryの導入。`workingMemory`をbuildPrompt/composePromptへ実結線し、長期MemoryをSupabaseへ永続化する | Phase A | 中（Prompt内容が変わるため、Agentの応答品質への影響を検証しながら進める） |
| **F** | Tool構成の刷新。`ToolCallAdapter`導入、能力ベースのTool割当、Evidence化判定の宣言化。当面は`jsonProtocol`アダプタのみ実装し、ネイティブTool Callingは次段階に回してもよい | Phase B | 小 |
| **G** | Prompt構成のモジュール化。`core/prompt/sections/*`を正式に活用し、出力フォーマットをschemaから自動生成する | Phase A, B | 中（Prompt文言が全面的に変わるため、品質回帰テストが必要） |
| **H** | Optimizer統合。`core/brain/`と`core/optimizer/`を1モジュールへ統合し、`brainRecommendation`をPlannerへ実際に渡す（Plannerが採用可否を判断する形を維持） | Phase E | 小〜中 |
| **I** | スケールアウト検証。10〜15Agent程度まで実際に追加し、Registry・DAG・Memory・チーム分割戦略（11章）が想定通り機能するかを検証する | Phase B〜H | ―（検証フェーズ） |
| **J** | 観測性の強化。`observability/tracer.ts`によるDAG実行トレース、`logStore`の構造化。並列実行・多Agentのデバッグ性を確保する | Phase C, D | 無し（追加的） |
| **K** | ネイティブTool Callingへの本格移行、マルチプロバイダ本格運用、契約バージョニングの実運用（11章） | Phase F〜J | 大（長期・任意） |

**進め方の指針**：

- Phase A〜Cは**振る舞いを変えない**リファクタリングであり、リスクが最も低く、
  最初に着手すべき区間です。
- Phase D（並列実行）とPhase E（Memory刷新）は互いに独立しており、並行して進められます。
- Phase G（Prompt刷新）は影響範囲が広いため、Agentごとに1体ずつ移行し、都度
  出力品質を確認しながら進めることを強く推奨します（一括切り替えはしない）。
- Phase I（10〜15Agentへのスケールアウト検証）を経てから、初めて「30Agent対応」を
  謳える状態になります。Phase B〜Hだけでは「30体でも動く設計」であって、
  「30体で動作確認済み」ではないことに留意してください。

---

## まとめ

TACT v2は、現在の9Agent・線形実行という実装を破棄するのではなく、**Agent定義を宣言化し
（原則1）、方針と機構を分離し（原則2）、各要素を独立に移行可能にし（原則3）、
Agent数の増加が人間の作業量に比例しないようにする（原則4）**ことで、同じ実行結果を
保ったまま段階的に成長させる設計です。並列実行・多層Memory・宣言的Tool構成・
Optimizerの実効化は、いずれも「今すぐ全部作り替える」のではなく、12章の独立したフェーズとして
積み上げることで、TACTを数年かけて安全に育てられる状態を目指します。
