# Agents

`core/agents/` 配下に定義され、`core/workflow/defaultWorkflow.ts` の順序で実行される9Agentについて、
現在の実装（`systemPrompt` / `rules` / `tools` / `core/prompt/builder.ts` の `visibleOutputs`）から
読み取れる内容を記述します。

「他Agentとの関係」は `buildPrompt()` の `visibleOutputs` マップ（そのAgentが直接参照できる
他Agent出力）に基づいています。実際のワークフロー順序自体は `defaultWorkflow.ts` / `handlePlanner.ts`
（Plannerが動的に再構成した場合）で決まります。「今後改善できそうな点」は本コードベースには
記述がないため、すべて `[提案]` です。

各Agentの「出力」欄は、そのAgent自身の `systemPrompt`（`core/agents/*.ts`）に記載された
出力フォーマット例を基準に記載しています。ただし `core/prompt/outputFormats.ts` にも
`buildPrompt()` がuserPrompt末尾へ追加する、同じAgent向けの別の出力フォーマット定義が存在し、
多くのAgentでこの2つはフィールド名や構造が一致していません（`docs/prompts.md`「4. 出力フォーマット
定義の重複について」参照）。実行時は両方がそのままLLMへ渡るため、実際にどちらの形式で
Agentが応答するかは保証されていません。特に差異が大きい例はWriterとResearcherの節に記載しています。

---

## Planner (`core/agents/planner.ts`)

- **責務**: ユーザー要求を分析し、目的を整理し、実行モード（quick/think/deep）に応じて
  必要最小限のAgent構成と実行順序（`plan`）を決定する。自分自身はplanに含めない。
- **入力**: `userInput`、`step.task`、Execution Mode。Evidence・Workflow Historyは
  （初回実行のため）実質空。Brain Memory（過去の改善ルール）は毎回渡される。
- **出力**: `{ goal, category, difficulty, requiredCapabilities, estimatedTime, thinking, reason, plan: [{agent, task}] }`
  （JSONのみ、Markdown禁止）
- **他Agentとの関係**:
  - `visibleOutputs.planner` は空配列 → Planner自身は他Agent出力を参照しない（常に最初に実行される）。
  - `parsed.category` を `core/planner/getTeam.ts: getTeam()` に渡すことで、`handlePlanner.ts` が
    固定Agent構成テーブルと `parsed.plan` のタスク文言を組み合わせ、実際に実行される `dynamicPlan` を再構築する。
  - Researcherが含まれる構成には自動的に `queryBuilder` がResearcherの直前に挿入される
    （Plannerの出力に `queryBuilder` が含まれていなくても強制的に追加される）。
  - `parsed.toolRequests` を返した場合は `runAgent.ts` が明示的に無視・削除する（Plannerはツール実行禁止）。
- **今後改善できそうな点 [提案]**:
  - `getTeam()` のカテゴリ別固定構成と、Planner自身が生成する `plan` の内容が二重管理になっており、
    最終的な `dynamicPlan` のtaskは `plan` から、Agent構成（誰を実行するか）は `getTeam()` の
    固定テーブルから来るため、両者が矛盾した場合の優先順位が実装から読み取りにくい。
  - `AgentId` に `analyst` が含まれているが、Plannerのsystem prompt本文・`getTeam()` のどちらにも
    `analyst` への言及がなく、Plannerの判断でAnalystが選ばれることは想定されていないように見える。
    加えて `buildPrompt()` の「Available Agents」固定リスト（全Agent共通で表示される、
    利用可能Agent一覧）にも `analyst` は含まれておらず、Plannerに限らず全Agentへ
    「利用可能なAgent」として `analyst` が提示されることはない（実行はされるが、
    Prompt上は他の8Agentと違って一段"見えない"扱いになっている）。

---

## QueryBuilder (`core/agents/queryBuilder.ts`)

- **責務**: 自身では検索・回答をせず、Researcherが効率よく高品質なEvidenceを集められるよう、
  検索対象（`searchTargets`）と検索クエリ（`queries`）を設計する「検索戦略専任」Agent。
- **入力**: `userInput`、`step.task`。`visibleOutputs.queryBuilder = ["planner"]` によりPlanner出力のみ参照。
- **出力**: `{ researchType, researchGoal, intent, searchTargets, queries, priority, expectedEvidence, reason }`
- **他Agentとの関係**:
  - Planner出力のみを参照する（`visibleOutputs`上）。
  - 自身の出力は `context.outputs.queryBuilder` に保存され、`buildPrompt()` の
    「QueryBuilder Search Strategy」セクションとしてResearcher実行時にのみ渡される。
  - `runAgent.ts` の `evidenceQueryByAgent.researcher` は QueryBuilder出力（JSON文字列化）を
    検索クエリの一部として連結する。
- **今後改善できそうな点 [提案]**:
  - `core/agent/queryBuilder.ts`（`agent/` 単数形、レガシー）にも同名だが内容の異なる
    QueryBuilder定義が残っており、混同しやすい。

---

## Researcher (`core/agents/researcher.ts`)

- **責務**: 事実（Evidence）のみを収集する。考察・提案・結論・文章作成は禁止。
  出典・信頼度(`confidence`)・関連度を必ず付与し、後続Agentが比較・分析しやすい構造化された
  Evidenceデータベースを構築する。
- **入力**: `userInput`、`step.task`、QueryBuilderの検索戦略、`web-search` Toolの実行結果。
  `visibleOutputs.researcher = ["planner", "queryBuilder"]`。
- **出力**: `{ toolRequests, evidence: { market, competitors, users, businessModel, features, technology, financial, news, other }, missingInformation, nextSearchSuggestions, handoff }`
- **他Agentとの関係**:
  - 使用できるToolは `tools: ["web-search"]` のみ。`toolRequests` を返すと `runAgent.ts` が
    `executeToolCalls` → `executeToolPipeline` → Tavily検索 → Evidence化のパイプラインを実行し、
    結果を踏まえて2回目のLLM呼び出しを行う。
  - `parsed.evidence` の各カテゴリの各項目は `runAgent.ts` によって `context.evidence` へ
    重複排除（hashベース）しつつ正規化・追加される。
  - `handoff` は後続（Analyst）への申し送り。`visibleOutputs.analyst` にResearcherが含まれるため、
    Analystが直接この出力を参照する。
- **今後改善できそうな点 [提案]**:
  - `agent.tools` に基づくTool実行判定 (`agent.tools.length > 0`) はあるが、実際にToolRegistryへ
    登録されているのは `web-search` のみで、`github` は未登録。Researcherのsystem promptには
    GitHub検索への言及はないため実害はないが、Tool拡張時は登録漏れに注意が必要。
  - `core/prompt/outputFormats.ts` の `researcher` エントリは、Evidence各項目を
    `{ claim, evidence, source, confidence, reason }` という形で定義しているが、
    Researcher自身の `systemPrompt`（本ファイル）が指示するEvidence構造は
    `{ topic/name, facts, sources, confidence }`（カテゴリごとに項目名も異なる）であり、
    両者は一致していない。さらに `outputFormats.ts` 側の例文は `"market":[...]` の閉じ括弧
    `]` の直後に `"competitors":[...]` が続き、間にカンマが無い＝そのままではJSONとして
    パースできない例文になっている。
  - **実際の実行ログ（`logs/*-researcher.json`）で確認したところ、Researcherは実際には
    `outputFormats.ts` 側の形式（`{claim, evidence, source, confidence, reason}`）でEvidenceを
    返している**（Researcher自身のsystemPromptが指示する `topic/facts/sources` 形式ではない）。
    一方 `runAgent.ts` の「Researcher Evidence 保存」処理（`context.evidence` への変換部分）は
    `item.name ?? item.topic ?? item.feature ?? item.metric ?? item.segment ?? item.model ?? item.headline`
    と `item.sources`（配列）を読もうとするコードになっており、これはsystemPrompt側の形式
    （`topic/name/... , sources`）を前提にしている。実際の出力（`claim/evidence/source`）には
    これらのキーが存在しないため、この経路で `context.evidence` に追加されるEvidenceは
    `claim: "Unknown"` / `source: undefined` になっていると考えられる（コードとログの突き合わせによる
    推定であり、全実行で常に発生するかは未検証。`selectEvidence()` のスコアリングでは
    このようなEvidenceは関連度が低く算出されるため上位には出てきにくく、症状として
    気づきにくい可能性がある）。

---

## Analyst (`core/agents/analyst.ts`)

- **責務**: Researcherが集めたEvidenceを比較・分析し、新しい事実を追加せずに
  戦略的なInsight（市場・競合・事業・リスク・機会の分析）を導く。
- **入力**: `userInput`、`step.task`。`visibleOutputs.analyst = ["planner", "researcher"]`。
- **出力**: `{ summary, keyInsights, analysis: { marketAnalysis, competitiveAnalysis, businessAnalysis, riskAnalysis, opportunityAnalysis }, comparisons, causeAndEffect, decisionPoints, confidence }`
- **他Agentとの関係**:
  - Planner・Researcherの出力のみを直接参照できる（`visibleOutputs`上）。DesignerやEngineerからは
    見えないため、Analystの分析はEvidenceとResearcher出力のみに基づく。
  - `visibleOutputs.designer = ["planner", "analyst"]` / `visibleOutputs.stakeholder = ["planner", "analyst"]`
    となっており、Designer・Stakeholderは（Researcherの生Evidenceではなく）Analystの分析結果を
    介して間接的に情報を得る設計になっている。
  - Writerの `systemPrompt` はAnalystの分析結果（`analysis`）を要約しすぎず積極的に成果物へ
    反映するよう明記している。
- **今後改善できそうな点 [提案]**:
  - `outputFormats.ts` の `analyst` フォーマットと、`analyst.ts` の `systemPrompt` 内で提示している
    出力例（`insights` の粒度・キー名など）に細かな差異がある。どちらが正とするか整理の余地がある
    （Researcher・Writerほど大きな差ではないが、同じ種類の問題。`docs/prompts.md`「4.」参照）。

---

## Designer (`core/agents/designer.ts`)

- **責務**: Evidence（および現状は主にAnalyst出力）を根拠に、情報設計・UX設計・画面構成・
  ユーザーフローを、画像生成AIやEngineerがそのまま使えるレベルまで具体化する。
  技術設計（API/DB/実装方式）は担当しない。
- **入力**: `userInput`、`step.task`、Evidence、Reviewer Memory。`visibleOutputs.designer = ["planner", "analyst"]`。
- **出力**: `{ informationArchitecture, userFlow, screens: [{name, purpose, layout, components, userAction}], designPrinciples, assumptions }`
- **他Agentとの関係**:
  - `visibleOutputs.engineer = ["planner", "designer"]` により、EngineerはDesignerの出力を
    直接参照して技術仕様へ変換する（`engineer.ts` のsystem promptも「Designer Outputが存在する場合は
    必ず利用する」と明記）。
  - `tools: ["figma"]` を宣言しているが、`figma` ToolはToolRegistryに未登録のため実行されない。
- **今後改善できそうな点 [提案]**:
  - `visibleOutputs.designer` にResearcherの生Evidence一覧は含まれず、Analystの分析のみが渡る
    （Evidence自体は別セクション「Shared Evidence」として渡るため実質参照可能）。
    Designer system prompt内の「Research Evidence が渡されます」という記述と一致しているか要確認。

---

## Engineer (`core/agents/engineer.ts`)

- **責務**: EvidenceとDesigner出力をもとに、実装可能な技術仕様（技術選定・API設計・DB設計・
  認証・システム構成）を作成する。コードそのものは書かない。
- **入力**: `userInput`、`step.task`、Evidence、Designer出力、Reviewer Memory。
  `visibleOutputs.engineer = ["planner", "designer"]`。
- **出力**: `{ implementation: string[], assumptions: string[] }`
- **他Agentとの関係**:
  - Designerが実行されていないワークフローでは、system prompt上「Evidenceのみを利用する」ことを
    許容しているが、`visibleOutputs` はDesigner出力の有無に関わらず固定であり、Researcher生出力は
    直接には見えない。
  - `tools: ["github", "npm"]` を宣言しているが、両ToolともToolRegistry未登録のため実行されない。
- **今後改善できそうな点 [提案]**:
  - `visibleOutputs.engineer` にResearcher/Analystが含まれておらず、system prompt側の
    「Researcher Outputも参考にしてください」という指示と、実際に渡されるコンテキスト
    （Workflow History経由でしか見えない）の整合性を確認する余地がある。

---

## Stakeholder (`core/agents/stakeholder.ts`)

- **責務**: Evidenceと他Agent成果物をもとに、ユーザー価値・企業価値・リスクを評価し、
  既存成果物への改善フィードバックを返す（新しい仕様を独自に決めない）。
- **入力**: `userInput`、`step.task`、Evidence、Reviewer Memory。`visibleOutputs.stakeholder = ["planner", "analyst"]`。
- **出力**: `{ feedback: string[], assumptions: string[] }`
- **他Agentとの関係**:
  - `visibleOutputs`上はAnalystの分析のみ直接参照。Designer/Engineer出力はWorkflow History
    （`stepOutputs`、実行済み全ステップ）経由でのみ間接的に見える。
- **今後改善できそうな点 [提案]**: なし（現状の実装から特筆すべき矛盾は見当たらない）。

---

## Reviewer (`core/agents/reviewer.ts`)

- **責務**: 各Agent成果物を統合的に評価し、「このままユーザーへ渡して満足できるか」を判定する
  TACT全体の品質ゲート。新しい情報は追加せず、不足・問題点・改善案のみを出す。
- **入力**: `userInput`、`step.task`、Evidence、Reviewer Memory（前回の自分自身の指摘）。
  `visibleOutputs.reviewer = ["planner", "researcher", "analyst", "designer", "engineer", "stakeholder"]`
  （唯一、Writerを除く全Agent出力を直接参照できる）。
- **出力**: `{ issues: string[], improvements: string[], retry: string[], approved: boolean, summary: string }`
- **他Agentとの関係**:
  - `core/workflow/handleReviewer.ts` が `approved` を見て、`true` ならWorkflowを次（Writer）へ進め、
    `false` なら `retry` に挙がったAgentへ `currentStep` を巻き戻す（最大3回、`MAX_REVIEW`）。
    上限到達時はWriterへ強制的に進む。
  - `retry` に指定できるのは `researcher / designer / engineer / stakeholder` のみで、
    `planner / reviewer / writer` は指定禁止（system prompt上のルール）。
  - `parsed.improvements` は `runAgent.ts` によって、文言に含まれるキーワード
    （"research" / "design" / "engineer" / "stakeholder" / "planner" / "writer"）から
    対象Agentを推測し `context.memory[target]` へ追加される（Reviewer自身の `retry` 判定とは別の、
    もう一つの簡易ルーティングロジック）。
  - `parsed.approved / issues / improvements` は `core/brain/index.ts: analyzeExecution()` の
    入力にもなり、Brain Memory（Optimizer経由）へ蓄積される。
- **今後改善できそうな点 [提案]**:
  - `improvements` からAgentを推測する2種類のロジック（`retry` 明示指定 と `runAgent.ts` の
    キーワードマッチング）が並存しており、`retry` に含まれないAgentにも
    キーワードマッチ経由でMemoryが追加されうる。挙動の一貫性は要検証。
  - この2種類のロジックは `context.memory[agentId]` へ書き込む値の型も異なる。
    `handleReviewer.ts`（`retry` 経由）は改善要求を**文字列**のままpushするのに対し、
    `runAgent.ts`（キーワードマッチ経由）は `{rule, reason, priority, createdAt}` という
    **オブジェクト**をpushする。`buildPrompt()` はこの配列を `` `- ${m}` `` として文字列化して
    Reviewer Memoryセクションに埋め込むため、オブジェクトが混ざっている場合はそのエントリが
    `"- [object Object]"` として出力され、Agentへ改善要求の内容が実質的に伝わらない
    （詳細は `docs/architecture.md`「3. データフロー」参照）。

---

## Writer (`core/agents/writer.ts`)

- **責務**: 全Agent成果物とEvidenceを統合し、ユーザーがそのまま利用できる完成した成果物
  （レポート）に仕上げる最終編集者。新しい事実・分析は追加しない。
- **入力**: `userInput`、`step.task`、Evidence、Reviewer Memory。
  `visibleOutputs.writer = ["planner", "researcher", "analyst", "designer", "engineer", "stakeholder", "reviewer"]`
  （Reviewerを含む全Agent出力を参照できる、唯一のAgent）。
- **出力**（system prompt記載のフォーマット）: `{ title, summary, status, answer: {overview, analysis, comparison, keyFindings, recommendations}, confidence, confidenceReason, limitations, suggestedTasks }`
- **他Agentとの関係**:
  - Writerの出力は `context.finalOutput` としてワークフローの最終成果物になり、
    `app/api/tact/stream/route.ts` からSSEの `result` イベントとしてUIへ送られる。
  - `context.outputs.reviewer` は `core/brain/index.ts: analyzeExecution()` の入力にもなる
    （Writer自身ではなくReviewer出力が品質スコアの根拠）。
- **今後改善できそうな点 [提案]**:
  - `components/output/FinalOutput.tsx` は `{ title, executiveSummary, keyFindings, sections, recommendations, nextActions }`
    という構造を期待して描画するが、`writer.ts` のsystem prompt本文に記載された出力フォーマットは
    `{ title, summary, status, answer: {...}, confidence, ... }` であり、`core/prompt/outputFormats.ts`
    の `writer` フォーマット（`{ title, executiveSummary, sections, keyFindings, recommendations, nextActions }`）
    ともキー名が食い違っている。3箇所（system prompt本文／outputFormats.ts／FinalOutput.tsx）で
    期待するJSON構造が一致していない状態であり、実際にUIへ表示される際にフィールドが
    欠落する可能性がある。加えて `writer.ts` のsystem prompt本文に書かれた出力フォーマット例自体、
    `"answer":{...}` を閉じる `}` の直後に別の `}` が続き、その後 `"confidence"` 以降のフィールドが
    どの階層にも属さない形で並ぶ、という構文上壊れた例文になっている（全Agent共通の
    出力フォーマット不整合パターンについては `docs/prompts.md`「4. 出力フォーマット定義の重複について」
    を参照）。
  - **実際の実行ログ（`logs/*-writer.json`）を確認したところ、Writerは実際には
    `outputFormats.ts` 側の形式（`title, executiveSummary, sections:[{heading,content,evidenceIds}],
    keyFindings:[{title,importance,summary}], recommendations, nextActions`）で出力していた**
    （system prompt本文の壊れた例文どおりには出力していない）。ただしこの実際の形式でも
    `FinalOutput.tsx` とは一致しない。`FinalOutput.tsx` は `section.title` / `section.points` /
    `keyFinding.description` を参照するが、実際の出力は `section.heading`（`points` は無く
    代わりに `evidenceIds`）・`keyFinding.summary` であるため、実行結果としてUI上で
    各セクションの見出しと主要findingsの説明文が表示されない状態になっていると考えられる
    （1件の実行ログで確認した結果であり、全実行で常にこの形式になるとは限らない）。
