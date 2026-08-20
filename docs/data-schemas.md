# Data Schemas

TACTのAgent間でやり取りされるJSON構造は、現在

- 各Agentの `systemPrompt`（`core/agents/*.ts`）内に書かれた出力例
- `core/prompt/outputFormats.ts` の `outputFormats[agentId]`
- `core/workflow/runAgent.ts` が実際にコードとして読み取っているフィールド
- `components/output/FinalOutput.tsx` がUI表示のために期待しているフィールド
- Evidenceの保存・検索まわり（`context/types.ts`, `core/tools/pipeline/evidence.ts`, `core/evidence/*`）

の5箇所でバラバラに定義されており、一致していません（`docs/agents.md`・`docs/prompts.md` 参照）。

このドキュメントは、

1. 実際のログ（`logs/*.json`）まで含めて現状を定量的に調査し、
2. どこでどう食い違っているかを整理し、
3. TACT全体（将来10体以上のAgent）で共通利用できる標準JSONスキーマを提案し、
4. 既存コードを壊さずに移行する計画を示す

ためのものです。**このドキュメントの型定義はすべて設計案（TypeScript疑似コード）であり、
実装（`.ts`/`.tsx`の変更）はまだ行っていません。**

---

## 0. 調査方法

- ソースコード: `core/agents/*.ts`（9Agent分のsystemPrompt）、`core/prompt/builder.ts`・
  `core/prompt/outputFormats.ts`・`core/prompt/responsibilities.ts`、`core/workflow/runAgent.ts`・
  `core/workflow/handlePlanner.ts`・`core/workflow/handleReviewer.ts`、`core/context/types.ts`、
  `core/evidence/*.ts`、`core/tools/pipeline/*.ts`、`components/output/FinalOutput.tsx`、
  `app/api/tact/route.ts` を読み込んで比較。
- 実行ログ: リポジトリ内 `logs/*.json`（`{prompt, response, parsed, evidence, toolResults}` を
  1回のAgent実行ごとに記録したもの）を、Agentごとにグループ化し、`parsed`（実際にJSONとして
  パースされた出力）のキー構成をすべて突き合わせた。件数は以下の通り（2026-08-07時点）。

  | Agent | ログ件数 | 観測された `parsed` の形の種類数 |
  |---|---|---|
  | planner | 13 | 1（常に同じ） |
  | queryBuilder | 13 | 1（常に同じ） |
  | researcher | 11 | 3 |
  | designer | 1 | ― |
  | stakeholder | 1 | ― |
  | reviewer | 11 | 3 |
  | writer | 10 | 4 |
  | analyst | 0 | ― |
  | engineer | 0 | ― |

  Analyst・Engineerは一度も実行ログが残っていません（このワークフロー実行群ではPlannerが
  一度も選択しなかったことを意味します）。Designer・Stakeholderは最初期の1回分のログしかなく、
  最近の実行での挙動は確認できません。**このドキュメントの「実際のログ」列は、あくまで
  観測できた範囲の事実であり、将来のLLM応答が同じ形になることを保証するものではありません。**
  （これ自体が後述の「標準スキーマ＋実行時バリデーション」を提案する動機の一つです。）

---

## 1. Agentごとの現状比較

各Agentについて、①入力（そのAgentへ渡るJSON/データ）②出力として**宣言**されている形
（systemPrompt本文とoutputFormats.tsの2つ）③**実際のログ**で観測された形④`runAgent.ts`が
コード上読み取っているフィールド⑤UI（`FinalOutput.tsx`等）が期待している形、を並べます。

### Planner

| 項目 | 内容 |
|---|---|
| 入力 | `userInput`, `step.task`, Execution Mode, Brain Memory。Evidence/Workflow Historyは初回のため実質空 |
| 出力（systemPrompt） | `{goal, category, difficulty, requiredCapabilities, estimatedTime, thinking, reason, plan:[{agent,task}]}` |
| 出力（outputFormats.ts） | `{goal, category, difficulty, estimatedTime, thinking, reason, plan}`（`requiredCapabilities`なし） |
| 実際のログ（13/13件） | `{category, difficulty, estimatedTime, goal, plan, reason, thinking}` — **`requiredCapabilities`は13件全てで出力されていない** |
| runAgent.tsが読むフィールド | `handlePlanner.ts`が`parsed.category`（`getTeam()`へ）と`parsed.plan[].{agent,task}`（taskMap構築）を読む。他は未使用 |
| UIが期待する形 | 直接は使われない（`workflow.status`経由でAgent名のみ表示） |

### QueryBuilder

| 項目 | 内容 |
|---|---|
| 入力 | `userInput`, `step.task`, Planner出力のみ（`visibleOutputs.queryBuilder=["planner"]`） |
| 出力（systemPrompt） | `{researchType, researchGoal, intent, searchTargets, queries, priority, expectedEvidence, reason}` |
| 出力（outputFormats.ts） | `{intent, searchTargets, queries:[{query,priority}], reason}` |
| 実際のログ（13/13件） | `{intent, queries, reason, searchTargets}` — **`researchType`/`researchGoal`/`priority`/`expectedEvidence`は13件全てで出力されていない**。`queries[i]`は`{query, priority}`で安定 |
| runAgent.tsが読むフィールド | `buildPrompt()`が`context.outputs.queryBuilder`をJSON文字列化してResearcherの検索クエリ文字列へ連結するのみ（個別フィールドを読む処理はない） |
| UIが期待する形 | 使われない |

### Researcher

| 項目 | 内容 |
|---|---|
| 入力 | `userInput`, `step.task`, QueryBuilder出力, `web-search` Tool結果 |
| 出力（systemPrompt） | `{toolRequests, evidence:{market:[{topic,facts,sources,confidence}], competitors:[{name,target,businessModel,strengths,weaknesses,facts,sources,confidence}], ...カテゴリごとに項目名が異なる...}, missingInformation, nextSearchSuggestions, handoff:{summary,importantPoints,missingInformation,recommendedFocus}}` |
| 出力（outputFormats.ts） | `{toolRequests, evidence:{market:[{claim,evidence,source,confidence,reason}], ...全カテゴリ共通の形...}, missingInformation, nextSearchSuggestions}`（`handoff`の記載なし。かつ`market`配列の直後にカンマが無くJSON構文として壊れている例文） |
| 実際のログ（11件） | 3種類。①最古の1件のみ `{findings, missingInformation, nextSearchSuggestions, toolRequests}`（`evidence`ですらなく`findings`という独自キー）。②直近9件は `{evidence, missingInformation, nextSearchSuggestions, toolRequests}`（`handoff`なし）で、`evidence`内の各項目は**全カテゴリ共通で`{claim, evidence, source, confidence(0-1の数値), reason}`**（systemPromptのカテゴリ別カスタム形ではなく、outputFormats.ts側の形に一致）。③最新1件のみ `{evidence, handoff, ...}` で`handoff`が付与されている（`handoff`はresearcher.tsへの直近の追記で、gitの変更履歴とも一致） |
| runAgent.tsが読むフィールド | Evidence保存処理は `item.name ?? item.topic ?? item.feature ?? item.metric ?? item.segment ?? item.model ?? item.headline ?? ""` と `item.sources`（配列）を読む。**実際の出力（`claim`/`evidence`/`source`が単数）とはキー名が一致せず、`claim`は常に`"Unknown"`、`source`は常に`undefined`になっていると考えられる**（confidence判定は`item.confidence`を直接見るため、これは数値である限り機能する） |
| UIが期待する形 | 直接は使われない（`context.evidence`経由で間接的にWriter等へ渡る） |

### Analyst

| 項目 | 内容 |
|---|---|
| 入力 | `userInput`, `step.task`, Planner・Researcher出力（`visibleOutputs.analyst=["planner","researcher"]`） |
| 出力（systemPrompt） | `{summary, keyInsights:[string], analysis:{marketAnalysis,competitiveAnalysis,businessAnalysis,riskAnalysis,opportunityAnalysis}, comparisons:[], causeAndEffect:[], decisionPoints:[], confidence:"high"}` |
| 出力（outputFormats.ts） | `{summary, insights:[{title,importance,reason,evidenceIds}], competitorComparison:[{company,strengths,weaknesses,reason,evidenceIds}], opportunities:[{title,reason,impact,evidenceIds}], risks:[{title,reason,severity,evidenceIds}], recommendations:[{priority,action,reason,evidenceIds}]}` |
| 実際のログ | **0件（一度も実行された記録が残っていない）**。どちらが実際に出力されるかは不明 |
| runAgent.tsが読むフィールド | 個別フィールドを読む専用処理は無し（`context.outputs.analyst`としてそのまま保存されるだけ） |
| UIが期待する形 | 使われない |

### Designer

| 項目 | 内容 |
|---|---|
| 入力 | `userInput`, `step.task`, Evidence, Reviewer Memory（`visibleOutputs.designer=["planner","analyst"]`） |
| 出力（systemPrompt） | `{informationArchitecture:[], userFlow:[], screens:[{name,purpose,layout,components,userAction}], designPrinciples:[], assumptions:[]}` |
| 出力（outputFormats.ts） | `{design:[], assumptions:[]}`（大幅に簡略化されており、systemPromptの情報量を表現できない） |
| 実際のログ（1件のみ、最古） | systemPrompt側と一致：`{informationArchitecture, userFlow, screens, designPrinciples, assumptions}` |
| runAgent.tsが読むフィールド | 専用処理は無し（そのまま保存） |
| UIが期待する形 | 使われない |

### Engineer

| 項目 | 内容 |
|---|---|
| 入力 | `userInput`, `step.task`, Evidence, Designer出力, Reviewer Memory（`visibleOutputs.engineer=["planner","designer"]`） |
| 出力（systemPrompt） | `{implementation:[], assumptions:[]}` |
| 出力（outputFormats.ts） | `{architecture:[], implementation:[]}`（`assumptions`が無く、代わりに`architecture`という別項目） |
| 実際のログ | **0件**。どちらが実際に出力されるかは不明 |
| runAgent.tsが読むフィールド | 専用処理は無し |
| UIが期待する形 | 使われない |

### Stakeholder

| 項目 | 内容 |
|---|---|
| 入力 | `userInput`, `step.task`, Evidence, Reviewer Memory（`visibleOutputs.stakeholder=["planner","analyst"]`） |
| 出力（systemPrompt） | `{feedback:[], assumptions:[]}` |
| 出力（outputFormats.ts） | `{value:[], risks:[], recommendations:[]}`（`feedback`/`assumptions`という項目名が無い、全く別の構造） |
| 実際のログ（1件のみ、最古） | systemPrompt側と一致：`{feedback, assumptions}` |
| runAgent.tsが読むフィールド | 専用処理は無し |
| UIが期待する形 | 使われない |

### Reviewer

| 項目 | 内容 |
|---|---|
| 入力 | `userInput`, `step.task`, Evidence, Reviewer Memory（前回の自分の指摘）。`visibleOutputs.reviewer`はWriterを除く全Agent出力 |
| 出力（systemPrompt） | `{issues:[], improvements:[], retry:[], approved:boolean, summary:string}` |
| 出力（outputFormats.ts） | `{approved:boolean, score:number, issues:[], strengths:[], improvements:[], missingEvidence:[]}`（`retry`が無い） |
| 実際のログ（11件） | 3種類。①最古1件：systemPrompt側と一致（`retry`あり）。②1件のみ `{approved, feedback, score}` という、どちらとも異なる独自の最小形（`improvements`すら無い）。③中間の8件：outputFormats.ts側とほぼ一致する `{approved, improvements, issues, missingEvidence, score, strengths}`（**`retry`が無い**）。④最新1件：再びsystemPrompt側（`retry`あり）に戻る |
| runAgent.tsが読むフィールド | `handleReviewer.ts`は`parsed.approved`・`parsed.retry`（`??[]`でフォールバック）・`parsed.improvements`（`??[]`）を読み、`retry`に挙がったAgentへ`currentStep`を戻す。`runAgent.ts`本体は`parsed.improvements`の文言をキーワードマッチングして`context.memory`へ振り分ける（`Array.isArray`チェックのみ） |
| UIが期待する形 | 使われない |
| **実害** | 実際のログの大半（8/11件）で`retry`が欠落しているため、**`approved=false`でも`retryAgents`が常に空配列になり、Reviewerが指摘した特定Agentへの差し戻しが機能せず、`handleReviewer.ts`のfallback（Researcherへ戻る）または`shouldBreak`のいずれかに落ちていた可能性が高い**。1件のみの独自形（`feedback`のみ）では`improvements`も存在せず、`context.memory`への改善要求の反映自体が完全にスキップされる |

### Writer

| 項目 | 内容 |
|---|---|
| 入力 | `userInput`, `step.task`, Evidence, Reviewer Memory。`visibleOutputs.writer`はReviewerを含む全Agent出力 |
| 出力（systemPrompt） | `{title, summary, status, answer:{overview,analysis,comparison,keyFindings,recommendations}, confidence, confidenceReason, limitations, suggestedTasks:[{title,prompt,mode}]}`（**この例文自体、`answer`を閉じる`}`の直後にもう1つ`}`が続き、以降のフィールドがどの階層にも属さない構文エラーになっている**） |
| 出力（outputFormats.ts） | `{title, executiveSummary, sections:[{heading,content,evidenceIds}], keyFindings:[{title,importance,summary}], recommendations:[], nextActions:[]}` |
| 実際のログ（10件） | 4種類、かつ時系列で明確に変化している。①最古1件：systemPrompt側フル形（`answer,confidence,confidenceReason,limitations,status,suggestedTasks,summary,title`）。②中間5件：`answer,nextActions,summary,title`（`answer`は残るが`nextActions`が混入し、他は消える）のハイブリッド。③その中の1件はさらに簡略化され`answer,summary,title`のみ。④**最新4件は一貫して**`executiveSummary,keyFindings,nextActions,recommendations,sections,title`（outputFormats.ts側とほぼ完全一致） |
| runAgent.tsが読むフィールド | 専用処理は無し。`context.outputs.writer`がそのまま`context.finalOutput`になる |
| UIが期待する形 | `FinalOutput.tsx`は`{title, executiveSummary, keyFindings:[{title,description}], sections:[{title,content,points}], recommendations:[], nextActions:[]}`を期待。**実際の直近ログ（④）の形と比べても、`sections[].heading`が`FinalOutput.tsx`の`section.title`と、`keyFindings[].summary`が`keyFinding.description`と一致しない**ため、UIでは各セクション見出しとkeyFindingの説明文が空欄になっていた可能性が高い |

---

## 2. 分析

### 2.1 どこでスキーマが食い違っているか

- **9Agent中7Agent**で、`systemPrompt`本文の出力例と`outputFormats.ts`のエントリが、
  フィールド名・構造いずれかのレベルで一致しない（Reviewer・Writer・Researcher・QueryBuilder・
  Planner・Designer・Engineer・Stakeholderの8つで確認。Analystも小さな差異あり。事実上9/9）。
- **Researcher・Reviewer・Writerの3Agent**は、実際のログでも**Agent内で複数の異なる形**が
  混在している（同じsystemPrompt・同じoutputFormats.tsのまま、実行のたびに違う形で応答している）。
  つまり問題は「2つの定義のどちらに従うか」だけでなく、**「そもそも毎回同じ形に従うとは限らない」**
  という、より根深いものである。
- `runAgent.ts`のコードが期待するフィールド名（Researcherの`name/topic/.../sources`、
  Reviewerの`retry`前提のロジック）が、実際にAgentが返す値と食い違っており、**単なる見た目の
  不一致ではなく、実行時の機能不全（Evidence保存の実質破損、Reviewerの差し戻し制御の破損）に
  直結している**（詳細は上表「実害」欄）。
- `FinalOutput.tsx`（UI）が期待するフィールド名も、Writerの実際の出力（最も収束している直近の形）
  と一致しておらず、UIでの表示欠落につながっている。
- `WorkflowContext.Evidence`（`context/types.ts`）自体も、`confidence`が`"low"|"medium"|"high"`の
  enumである一方、Researcherの実際の出力は`confidence`が`0〜1`の数値であり、変換が必要
  （この変換自体は`runAgent.ts`のロジックとしては存在するが、その変換に使う`claim`/`source`の
  取り出しが別の理由で壊れている、という二重の問題になっている）。
- `context.memory[agentId]`（Reviewer Memory）に、書き込み元によって**文字列**
  （`handleReviewer.ts`）と**オブジェクト**（`runAgent.ts`のキーワードマッチ経由、`BrainRule`型）が
  混在し、`buildPrompt()`側のレンダリングが`` `- ${m}` ``という前提のため、オブジェクトが混ざると
  `"- [object Object]"`として出力される（`docs/architecture.md`参照）。

### 2.2 どのスキーマを正とするのが最も自然か

Agentごとに状況が異なるため、一律に「`systemPrompt`が正」「`outputFormats.ts`が正」とは
決められません。判断基準として、①実際のログで多数派の形はどれか、②`runAgent.ts`・
`handleReviewer.ts`など既存コードが機能するために必要なフィールドはどれか、③UIやEvidence保存など
下流の消費者が必要とする情報を欠いていないか、の3点で判断しました。

| Agent | 採用すべき基準形 | 理由 |
|---|---|---|
| Planner | outputFormats.ts（`requiredCapabilities`は削除） | 13/13件でこの形。`requiredCapabilities`は誰にも消費されておらず死んだフィールド |
| QueryBuilder | outputFormats.ts（`researchType`等は削除） | 13/13件でこの形。未使用の4フィールドは死んでいる |
| Researcher | outputFormats.ts寄り（ただし`evidence`をカテゴリ別Recordではなくフラット配列＋`category`フィールドに再設計、`handoff`は正式採用） | 10/11件がこの系統。カテゴリ別Recordは実際には大半のカテゴリが空配列で埋まらず、`runAgent.ts`側の消費コードもキー名不一致で機能していないため、シンプルな配列構造へ変更する方が実態に合う |
| Analyst | 新規に統合設計（下記4.3参照） | ログが無く実績で決められないため、`outputFormats.ts`の`evidenceIds`引用パターン（Evidence追跡性のため下流のWriterにも一貫させたい）と、systemPromptの`analysis`構造化（読みやすさ）の両方を採用する統合案とする |
| Designer | systemPrompt | 唯一の実測ログがこの形と一致。outputFormats.tsの`{design:[],assumptions:[]}`は情報量が乏しく、後続のEngineerが必要とする詳細（画面構成等）を表現できない |
| Engineer | systemPrompt | ログは無いが、outputFormats.tsの`architecture`フィールドは他Agentとの一貫性（`implementation`+`assumptions`という共通パターン）から外れており、Designer/Stakeholderと同型に揃える方が自然 |
| Stakeholder | systemPrompt | 唯一の実測ログがこの形と一致。outputFormats.tsの`{value,risks,recommendations}`は実測と無関係かつ他Agentとの一貫性も無い |
| Reviewer | どちらでもなく新規統合設計（下記4.3参照） | 多数派（8/11）はoutputFormats.ts寄りだが、ワークフロー制御に必須の`retry`はsystemPrompt側にしか無い。両方の必要な部分を合成する必要がある |
| Writer | outputFormats.ts寄り（`confidence`/`confidenceReason`/`limitations`/`suggestedTasks`/`status`はsystemPromptから残す） | 直近4/4件で完全収束している構造をベースにしつつ、systemPromptにしかない付加情報（信頼度・限界・追加提案）は価値があるため統合。`FinalOutput.tsx`側もこの形に合わせて更新する前提 |

### 2.3 互換性を保ったまま修正できるか

**部分的に可能**ですが、完全な後方互換は取れません。理由：

- Planner・QueryBuilderは「実際に出ていないフィールドを削るだけ」なので、既存の`handlePlanner.ts`等の
  消費コードには影響せず、システムプロンプト側の記述を削るだけで完了します（**互換性リスク低**）。
- Researcherは`evidence`の構造そのもの（Record→配列）を変えるため、`runAgent.ts`のEvidence保存処理・
  `buildPrompt()`の`evidenceQueryByAgent`周りは書き直しが必要です。ただし`context.evidence`
  （`WorkflowContext`側のEvidence配列）の形は変えずに済むよう設計できます（**下流への影響は
  吸収可能、Researcher⇄runAgent.tsの接続部分のみ変更**）。
- Reviewerの`retry`は現状ワークフロー制御の生命線であり、これが欠落する現状のバグはコード変更
  （プロンプト修正 or バリデーション導入）なしに直せません。**ドキュメントだけでは解決しない
  既知の実装課題**として引き続き記録します。
- Writer/FinalOutput.tsxはUIコードとプロンプトの両方の変更が必要で、単純な後方互換はありません。
  ただし「UIが読めるキーが増える分には壊れない」性質を利用し、新旧両方のキー名を一定期間
  両方出力させる、という移行手順は可能です（後述4.6・6章）。
- どのAgentについても、**実行時バリデーション（後述）を導入しない限り、プロンプトの文言を
  統一しただけでは「LLMが指示に従わない」問題は再発しうる**、という点は互換性以前の前提として
  留意が必要です。

### 2.4 変更による影響範囲

| 変更対象 | 影響するファイル |
|---|---|
| Agentの出力スキーマ変更全般 | `core/agents/*.ts`（該当Agentのsystem prompt）、`core/prompt/outputFormats.ts` |
| Researcherのevidence構造変更 | 上記に加え `core/workflow/runAgent.ts`（Evidence保存処理）、`core/prompt/builder.ts`（`evidenceQueryByAgent`, Evidenceセクション表示） |
| Reviewerの`retry`/`improvements`構造変更 | 上記に加え `core/workflow/handleReviewer.ts`、`core/workflow/runAgent.ts`（キーワードマッチ処理の削除）、`core/brain/*.ts`（`BrainRule`との統合） |
| `context.memory`の型統一 | `core/context/types.ts`、`core/prompt/builder.ts`（`agentMemory`レンダリング） |
| Writerの出力スキーマ変更 | 上記に加え `components/output/FinalOutput.tsx`、`app/api/tact/route.ts`（`result`フィールド） |
| `WorkflowContext.outputs`の型付け | `core/context/types.ts`、`core/workflow/runAgent.ts`、`core/prompt/builder.ts`（`visibleOutputs`関連） |
| ExecutionResult（APIレスポンス）整理 | `app/api/tact/route.ts`、`app/api/tact/stream/route.ts`、`components/InputBar.tsx`（SSEイベント処理） |
| Evidence型の統一（`EvidenceItem`/`SharedEvidence`） | `core/context/types.ts`、`core/tools/pipeline/evidence.ts`、`core/evidence/*.ts` |

### 2.5 優先順位

1. **最優先（機能不全の修正）**: Reviewerの`retry`欠落問題、Researcherの`claim`="Unknown"/`source`=undefined問題。
   いずれも「見た目の不統一」ではなく「ワークフローが意図通り動いていない」レベルの実害があるため。
2. **優先（一貫性の土台作り）**: `context.memory`の型統一（string/BrainRule混在の解消）、
   Evidence型の統一（`EvidenceItem`/`SharedEvidence`の分離）。他の変更の前提になるため。
3. **中**: Planner・QueryBuilderの死んだフィールド削除（実害は無いが、プロンプトの無駄・
   ドキュメントと実装の乖離を減らす）。
4. **中**: Writerの出力スキーマ統一＋`FinalOutput.tsx`更新（UI表示品質に直結するが、
   ワークフロー制御自体は壊れていない）。
5. **低（ログが無く実態不明なため、まず実行して実態を確認してから着手すべき）**:
   Analyst・Engineerのスキーマ確定。Designer・Stakeholderも直近ログが無いため、
   まず現行のsystemPrompt形が今も維持されているか再確認してから確定させる。

---

## 3. 標準スキーマ提案

### 3.1 設計方針

- **1つのAgent = 1つのペイロード型**。`AgentPayloadMap`という中央マップに
  `AgentId → ペイロード型`を1行足すだけで新しいAgentを追加できるようにする
  （目的の「10体以上のAgentでも同じ枠組みで通信できる」を満たす）。
- **Agentが返す生JSON（LLM向け）**と**システムが内部で保持する拡張データ
  （`WorkflowContext`向け）**を明確に分離する。特にEvidenceは、Agentが書く
  シンプルな`EvidenceItem`と、システムが`score`/`hash`/`sourceType`などを付与した
  `SharedEvidence`を別の型として定義する。これにより「Agentに複雑な内部管理用フィールドまで
  書かせようとして失敗する」問題（Researcherの現状の混乱の一因）を避ける。
- **Reviewerの`improvements`を構造化オブジェクト化**し、`targetAgent`を明示させることで、
  `runAgent.ts`のキーワードマッチングという不安定なロジックを不要にする。
- 型はTypeScriptのインターフェースとして定義するが、**`[提案]`として、実行時バリデーション
  （後述4.7）の導入もあわせて検討する**。TypeScriptの型はコンパイル時にしか効かず、
  LLMの応答という「実行時に初めて分かるデータ」の正しさは保証できないため。

### 3.2 共通プリミティブ

```ts
// ==========================================================
// Agent識別子（将来的に10体以上に拡張される前提）
// ==========================================================
type AgentId = keyof AgentPayloadMap; // 4.4で定義。1箇所に集約されたAgent一覧の唯一の情報源。

type ExecutionMode = "quick" | "think" | "deep";

type AgentRunStatus = "idle" | "running" | "completed" | "failed";

// ==========================================================
// Evidence（証拠）
// ==========================================================

// Agentが「書く」ときの形（LLM向け・シンプル）
interface EvidenceItem {
  category: EvidenceCategory;     // 現状Researcherのカテゴリ別Recordのキーだったもの。フラット配列にしてフィールド化する
  claim: string;                  // 一言でわかる主張・見出し
  detail: string;                 // 主張の裏付けとなる具体的な内容（旧: "evidence"。入れ物と中身の名前衝突を避けるため改名）
  source: string;                 // 出典（URLや媒体名）。単数。複数出典が要る場合は "source" をカンマ区切り文字列にするのではなく、EvidenceItem自体を分ける
  confidence: number;             // 0.0〜1.0。出典の信頼度（Researcher systemPromptの基準表をそのまま使う）
  relevance?: number;             // 0.0〜1.0。ユーザー要求との関連度（Researcher systemPromptに既にある概念を型に反映）
  tags?: string[];
}

type EvidenceCategory =
  | "market" | "competitors" | "users" | "businessModel"
  | "features" | "technology" | "financial" | "news" | "other";

// システムが「保持する」ときの形（WorkflowContext向け・拡張フィールド付き）
interface SharedEvidence extends Omit<EvidenceItem, "confidence"> {
  id: string;                                  // サーバー側で採番
  confidence: "low" | "medium" | "high";       // EvidenceItem.confidence(数値)から変換した後の正規化値
  confidenceScore: number;                     // 変換前の数値も保持する（0.0〜1.0）。現状 "score" と紛らわしい2つの概念があるため名前を分離
  score: number;                                // ランキング用の合成スコア（sourceType重み＋confidence＋鮮度など）
  sourceType?: "official" | "government" | "paper" | "news" | "media" | "community" | "unknown";
  isPrimarySource?: boolean;
  freshnessScore?: number;
  publishedAt?: string;
  updatedAt?: string;
  retrievedAt?: string;
  hash: string;                                 // 重複排除キー（claim+sourceなどから生成）
  createdBy: AgentId | "tool:web-search";
  createdAt: number;
  references?: string[];
}

// EvidenceItem → SharedEvidence への変換は「フィールド名を推測する」のではなく、
// 常にこの1関数だけを経由させる（設計案・シグネチャのみ）
declare function toSharedEvidence(item: EvidenceItem, createdBy: AgentId | "tool:web-search"): SharedEvidence;

// ==========================================================
// Handoff（Agent間の申し送り）
// ==========================================================
interface Handoff {
  summary: string;
  importantPoints: string[];
  missingInformation: string[];
  recommendedFocus: string[];
}

// ==========================================================
// Tool（既存 core/tools/types.ts の形をほぼ踏襲。目立った不整合は無かったため大枠は流用）
// ==========================================================
interface ToolRequest {
  tool: string;
  arguments?: Record<string, unknown>;
}

interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// ==========================================================
// 改善要求ノート（Reviewer Memory と Brain Memory を統合）
// 現状の BrainRule（core/brain/types.ts）と、Reviewerのimprovements(string[])を統合する
// ==========================================================
interface ImprovementNote {
  targetAgent: AgentId;         // 現状のキーワードマッチングを廃止し、Reviewer自身に明示させる
  description: string;          // 何を改善すべきか（現状の string そのもの）
  reason?: string;
  priority?: "low" | "medium" | "high";
  source: "reviewer" | "brain";  // Reviewer1回分の指摘か、Brain(Optimizer)が横断的に導いたルールかを区別
  createdAt: number;
}
```

**利用Agent / 利用箇所**

| 型 | 利用Agent | 利用箇所（設計上の想定） |
|---|---|---|
| `EvidenceItem` | Researcher（出力）、Analyst/Designer/Engineer/Stakeholder/Reviewer/Writer（Evidence引用時の参照先） | Researcherの`evidence`フィールドの要素型 |
| `SharedEvidence` | 全Agent（`Shared Evidence`セクション経由で読む） | `WorkflowContext.evidence`, `core/evidence/selectEvidence.ts`, `core/tools/pipeline/evidence.ts` |
| `Handoff` | 全Agent（出力）、次に実行されるAgent（入力） | `WorkflowContext.handoffs`, `core/prompt/builder.ts`（現状は未使用の引数だが、4.6で結線を提案） |
| `ToolRequest` / `ToolResult` | Researcher（現状唯一の実利用Agent）、将来Tool対応する全Agent | `core/tools/executeToolCalls.ts`, `core/tools/runTool.ts` |
| `ImprovementNote` | Reviewer（出力）、Brain/Optimizer（生成）、対象Agent（Reviewer Memory/Brain Memoryとして読む） | `WorkflowContext.memory`, `core/brain/memory.ts`, `core/prompt/builder.ts`（`agentMemory`/`brainMemory`レンダリング） |

### 3.3 Agentごとのペイロード型

```ts
// ---------- Planner ----------
interface PlanResult {
  goal: string;
  category: TaskCategory;
  difficulty: "easy" | "medium" | "hard";
  estimatedTime: string;
  thinking: string;
  reason: string;
  plan: PlanStep[];
  // requiredCapabilities は実測で一度も出力されず、消費者も存在しないため削除（2.2参照）
}
type TaskCategory = "coding" | "writing" | "research" | "planning" | "design" | "business" | "general";
interface PlanStep { agent: AgentId; task: string; }

// ---------- QueryBuilder ----------
interface QueryStrategy {
  intent: string;
  searchTargets: string[];
  queries: SearchQuery[];
  reason: string[];
  // researchType / researchGoal / priority / expectedEvidence は実測で一度も出力されず削除（2.2参照）
}
interface SearchQuery { query: string; priority: number; }

// ---------- Researcher ----------
interface ResearchResult {
  toolRequests: ToolRequest[];
  evidence: EvidenceItem[];         // Record<category, Item[]> → フラット配列 + category フィールドへ変更（2.2参照）
  missingInformation: string[];
  nextSearchSuggestions: string[];
  handoff: Handoff;                  // 直近の実装追加を正式に必須フィールドへ昇格
}

// ---------- Analyst ----------
// ログが無いため、systemPrompt（構造化されたanalysis）と outputFormats.ts（evidenceIds引用）を統合
interface AnalysisResult {
  summary: string;
  analysis: {
    marketAnalysis: string;
    competitiveAnalysis: string;
    businessAnalysis: string;
    riskAnalysis: string;
    opportunityAnalysis: string;
  };
  insights: AnalysisInsight[];
  risks: AnalysisRisk[];
  opportunities: AnalysisOpportunity[];
  recommendations: AnalysisRecommendation[];
  confidence: "high" | "medium" | "low";
}
interface AnalysisInsight { title: string; importance: number; reason: string; evidenceIds: string[]; }
interface AnalysisRisk { title: string; reason: string; severity: "high" | "medium" | "low"; evidenceIds: string[]; }
interface AnalysisOpportunity { title: string; reason: string; impact: "high" | "medium" | "low"; evidenceIds: string[]; }
interface AnalysisRecommendation { priority: "high" | "medium" | "low"; action: string; reason: string; evidenceIds: string[]; }

// ---------- Designer ----------
interface DesignResult {
  informationArchitecture: string[];
  userFlow: string[];
  screens: DesignScreen[];
  designPrinciples: string[];
  assumptions: string[];
}
interface DesignScreen {
  name: string;
  purpose: string;
  layout: string;
  components: string[];
  userAction: string;
}

// ---------- Engineer ----------
interface EngineeringResult {
  implementation: string[];
  assumptions: string[];
}

// ---------- Stakeholder ----------
interface StakeholderFeedback {
  feedback: string[];
  assumptions: string[];
}

// ---------- Reviewer ----------
// systemPrompt由来の retry（ワークフロー制御に必須）と、
// outputFormats.ts由来の score/strengths/missingEvidence（有益な付加情報）を統合
interface ReviewResult {
  approved: boolean;
  retry: AgentId[];                  // 制御に必須。空にする場合も明示的に [] を返させる
  issues: string[];
  improvements: ImprovementNote[];   // string[] → 構造化オブジェクトへ変更（targetAgentを明示）
  strengths?: string[];
  missingEvidence?: string[];
  score?: number;                    // 0-100。Brain(analyzeExecution)の独自採点と混同しないよう、あくまで参考値として扱う
  summary: string;
}

// ---------- Writer ----------
interface WriterOutput {
  title: string;
  executiveSummary: string;
  sections: WriterSection[];
  keyFindings: WriterKeyFinding[];
  recommendations: string[];
  nextActions: string[];
  confidence: "high" | "medium" | "low";
  confidenceReason: string;
  limitations: string[];
  suggestedTasks: SuggestedTask[];
  status: "complete" | "partial" | "insufficient";
}
interface WriterSection { heading: string; content: string; evidenceIds?: string[]; }
interface WriterKeyFinding { title: string; importance: number; summary: string; evidenceIds?: string[]; }
interface SuggestedTask { title: string; prompt: string; mode: ExecutionMode; }
```

**利用Agent / 利用箇所**

| 型 | 利用Agent | 利用箇所 |
|---|---|---|
| `PlanResult` | Planner（出力） | `core/agents/planner.ts`, `core/workflow/handlePlanner.ts`, `core/planner/getTeam.ts` |
| `QueryStrategy` | QueryBuilder（出力）、Researcher（入力として参照） | `core/agents/queryBuilder.ts`, `core/prompt/builder.ts`（QueryBuilder Search Strategyセクション） |
| `ResearchResult` | Researcher（出力）、Analyst以降全Agent（Evidence経由で間接的に入力） | `core/agents/researcher.ts`, `core/workflow/runAgent.ts`（Evidence保存処理） |
| `AnalysisResult` | Analyst（出力）、Designer/Stakeholder/Writer（入力として参照） | `core/agents/analyst.ts` |
| `DesignResult` | Designer（出力）、Engineer（入力として参照） | `core/agents/designer.ts` |
| `EngineeringResult` | Engineer（出力） | `core/agents/engineer.ts` |
| `StakeholderFeedback` | Stakeholder（出力） | `core/agents/stakeholder.ts` |
| `ReviewResult` | Reviewer（出力）、Writer（入力として参照） | `core/agents/reviewer.ts`, `core/workflow/handleReviewer.ts` |
| `WriterOutput` | Writer（出力） | `core/agents/writer.ts`, `components/output/FinalOutput.tsx`, `app/api/tact/route.ts`（`result`） |

### 3.4 共通エンベロープと拡張性（10体以上のAgent対応）

Agentが増えるたびに個別処理を書き足さずに済むよう、**「Agent識別子→ペイロード型」の
対応表を1箇所に集約**します。新しいAgentを追加する際は、この`AgentPayloadMap`へ1行足すだけで、
ワークフローエンジン側（`runWorkflow`のループ、`buildPrompt`、`FinalOutput.tsx`等）のコードを
変更せずに済む設計を目指します。

```ts
// Agent識別子とペイロード型の対応表。ここが「10体以上のAgent」に対応するための唯一の情報源。
interface AgentPayloadMap {
  planner: PlanResult;
  queryBuilder: QueryStrategy;
  researcher: ResearchResult;
  analyst: AnalysisResult;
  designer: DesignResult;
  engineer: EngineeringResult;
  stakeholder: StakeholderFeedback;
  reviewer: ReviewResult;
  writer: WriterOutput;

  // 例: 10体目以降を追加する場合はここへ1行足すだけでよい
  // seoSpecialist: SeoAuditResult;
}

// 全Agent共通のプロトコル部分（toolRequests / handoff）と、Agent固有のペイロードを合成する。
// 現状のコードは toolRequests・handoff・ペイロードのフィールドがすべて同じ階層にフラットに
// 混ざっているため、移行期はこの「交差型（intersection）」でその実態をそのまま型付けし、
// 将来的に { data: T, toolRequests, handoff } という入れ子構造へ移行することも選択肢とする（6章）。
type AgentResponse<K extends AgentId> = AgentPayloadMap[K] & {
  toolRequests?: ToolRequest[];
  handoff?: Handoff;
};

// 新しいAgentを追加する際のチェックリスト（型レベルで強制できる部分）
// 1. AgentPayloadMap に1行追加
// 2. core/agents/<newAgent>.ts の systemPrompt をそのペイロード型と一致させる
// 3. core/prompt/outputFormats.ts の該当エントリを「型から自動生成する」(4.7参照) か、
//    最低限レビュー時に型と突き合わせる
// 4. core/prompt/responsibilities.ts に責務テキストを追加
// 5. core/prompt/builder.ts の visibleOutputs に、どのAgent出力を見せるかを追加
```

### 3.5 WorkflowContextへの反映案

```ts
interface WorkflowContext {
  userInput: string;
  mode: ExecutionMode;

  // Record<string, unknown> → 型安全な形へ
  outputs: Partial<{ [K in AgentId]: AgentPayloadMap[K] }>;
  stepOutputs: Record<string, { agent: AgentId; output: AgentPayloadMap[AgentId] }>;

  // (string | BrainRule)[] → ImprovementNote[] へ統一
  memory: Partial<Record<AgentId, ImprovementNote[]>>;

  // Evidence → SharedEvidence へ改称・拡張
  evidence: SharedEvidence[];

  // 現状書き込まれるだけで読まれていない。4.6で実際に利用する設計を提案
  handoffs: Partial<Record<AgentId, Handoff>>;

  agentStatus: Partial<Record<AgentId, AgentRunStatus>>;
  reviewHistory: ReviewResult[];
  logs: WorkflowLog[];
  events: WorkflowEvent[];

  finalOutput: WriterOutput | null;
  executionRecord?: ExecutionRecord;   // 既存のBrain/Optimizer向け型を流用（大きな不整合は見つからなかったため）
}
```

### 3.6 ExecutionResult（APIレスポンス）の整理

現状 `app/api/tact/route.ts` は `result` / `agentOutputs` / `outputs` の3つのキーで
**同じ`context.outputs`を重複して返し**、`logs` / `events` もトップレベルと`workflow`配下の
両方に重複しています。標準スキーマ導入にあわせて、1つの正規化されたレスポンス型に統合します。

```ts
interface ExecutionResult {
  success: boolean;
  mode: ExecutionMode;
  workflow: {
    status: Partial<Record<AgentId, AgentRunStatus>>;
    logs: WorkflowLog[];
    events: WorkflowEvent[];
  };
  outputs: Partial<{ [K in AgentId]: AgentPayloadMap[K] }>;
  finalOutput: WriterOutput | null;   // 現状の "result" に相当。キー名をfinalOutputへ統一
  memory: Partial<Record<AgentId, ImprovementNote[]>>;
  error?: string;
}
```

**利用箇所**: `app/api/tact/route.ts`（構築）、`app/api/tact/stream/route.ts`（SSEの`result`/`finished`
イベントとして分割送信）、`components/InputBar.tsx`（SSE受信・パース）、
`components/output/FinalOutput.tsx`（`finalOutput`を描画）。

### 3.7 [提案] 実行時バリデーションの導入

TypeScriptの型は**コンパイル時のみ**有効で、LLM応答という実行時データの正しさは検証しません。
今回の調査で判明した「同じsystemPromptなのに実行のたびに違う形で返ってくる」（Researcher/Reviewer/
Writerで確認）という問題は、プロンプト文言をどれだけ統一しても、**LLMが指示に従わない限り
再発しうる**構造的な問題です。

`[提案]`として、`zod`のような軽量スキーマライブラリの導入を推奨します。

- 上記インターフェース群をzodスキーマとして定義し、`z.infer<>`でTypeScript型を導出する
  （型定義を二重管理しない）。
- `runAgent.ts`が`JSON.parse()`した直後に`schema.safeParse(parsed)`を通し、
  失敗した場合はログに実際の差分を記録した上で、①エラーとして扱いWorkflowを止める、
  ②足りないフィールドをデフォルト値で補って続行する、③1回だけ「正しい形式で出力し直せ」と
  指示してリトライする、のいずれかの戦略を選べるようにする。
- zodスキーマから`outputFormats.ts`の例文JSONを自動生成できれば、
  「systemPromptの例文」「outputFormats.tsの例文」「実際にコードが読むフィールド」の
  3者が構造的に乖離しなくなる（現状の最大の問題の根本解決）。

この提案はコード変更を伴うため、本ドキュメントでは方向性の提示に留め、実装は別途合意の上で
段階的に進めることを想定しています（6章）。

---

## 4. 移行計画（Migration Plan）

既存のワークフローを止めずに、段階的にスキーマを統一するための計画です。
各フェーズは独立してリリース可能なサイズに分割しています。

### Phase 0（このドキュメント自体）

- 現状調査・標準スキーマの合意形成。コード変更なし。

### Phase 1: 実害のある不整合を個別に修正（優先度: 最優先）

対象は2.5「優先順位」の1に挙げたもの。

1. **Reviewerの`retry`欠落問題**: `core/agents/reviewer.ts`のsystemPromptを、
   `outputFormats.ts`と統合した`ReviewResult`（3.3）に合わせて書き直す。`retry`を
   必須項目として強調する文言に修正。あわせて`core/prompt/outputFormats.ts`の`reviewer`
   エントリを同じ形に統一する（2つの定義を実質1つにする）。
2. **Researcherの`claim`="Unknown"問題**: `core/workflow/runAgent.ts`のResearcher Evidence保存部分を、
   実際にResearcherが返している`{claim, evidence→detail, source, confidence, reason}`
   という形（＝`EvidenceItem`, 3.2）を前提としたコードへ書き換える。あわせて
   `core/agents/researcher.ts`のsystemPromptを、カテゴリ別に異なるフィールド名を
   要求する現行の記述から、`EvidenceItem`ベースのフラット配列＋`category`フィールドへ
   統一する（`outputFormats.ts`と統合）。
   - **影響範囲**: `core/workflow/runAgent.ts`, `core/agents/researcher.ts`,
     `core/prompt/outputFormats.ts`, `core/prompt/builder.ts`（Evidence表示・クエリ生成部分）。
   - **互換性**: `context.evidence`（`SharedEvidence[]`）の外部形状は変えずに済むため、
     Evidenceを読む側（`selectEvidence`, `buildPrompt`のEvidenceセクション等）は無変更で良い。

### Phase 2: `context.memory`の型統一とReviewer構造化改善の連動

1. `ImprovementNote`（3.2）を導入し、`WorkflowContext.memory`の型を
   `(string | BrainRule)[]` → `ImprovementNote[]`に統一。
2. `core/workflow/handleReviewer.ts`・`core/workflow/runAgent.ts`双方の
   「Reviewer Memoryへの書き込み」ロジックを、`ReviewResult.improvements`
   （すでに`targetAgent`を含む）から直接`ImprovementNote`を組み立てる形に統一し、
   `runAgent.ts`側のキーワードマッチングによる対象Agent推測ロジックを削除する。
3. `core/brain/types.ts`の`BrainRule`を`ImprovementNote`へ統合し、`core/brain/memory.ts`
   （Brain Memory）と`context.memory`（Reviewer Memory）が同じ型を扱うようにする。
4. `core/prompt/builder.ts`の`agentMemory`レンダリングを、オブジェクト前提の描画
   （`` `- ${m.description}（対象: ${m.targetAgent}）` ``等）に更新する。
   - **影響範囲**: `core/context/types.ts`, `core/workflow/handleReviewer.ts`,
     `core/workflow/runAgent.ts`, `core/brain/types.ts`, `core/brain/memory.ts`,
     `core/prompt/builder.ts`。
   - **互換性**: Phase 1でReviewerのスキーマがすでに`ImprovementNote`と互換な
     構造（`targetAgent`付き）になっているため、Phase 1が先に完了していることが前提。

### Phase 3: 死んだフィールドの削除とPlanner/QueryBuilderの整理

1. `core/agents/planner.ts`から`requiredCapabilities`の指示を削除（もしくは実際に
   `handlePlanner.ts`で使う設計に昇格させるかを別途判断）。
2. `core/agents/queryBuilder.ts`から`researchType`/`researchGoal`/`priority`/
   `expectedEvidence`の指示を削除、または実際に`buildPrompt()`が利用する設計に
   昇格させる。
3. `core/prompt/outputFormats.ts`のPlanner/QueryBuilderエントリを実測形に合わせて統一。
   - **影響範囲**: `core/agents/planner.ts`, `core/agents/queryBuilder.ts`,
     `core/prompt/outputFormats.ts`。実際に読まれていないフィールドの削除なので
     **既存コードへの影響は無い**（最も安全なフェーズ）。

### Phase 4: Writer / FinalOutput.tsx の統一

1. `core/agents/writer.ts`のsystemPromptを`WriterOutput`（3.3）に合わせて修正
   （壊れたJSON例文の修正も兼ねる）。`core/prompt/outputFormats.ts`のwriterエントリと統合。
2. `components/output/FinalOutput.tsx`を`WriterOutput`の実際のフィールド名
   （`sections[].heading`, `keyFindings[].summary`等）に合わせて更新する。
   - **移行時の互換策**: 一時的に`FinalOutput.tsx`側で
     `section.heading ?? section.title`のように両対応させ、旧ログ・旧レスポンスでも
     表示が壊れないようにしてから、prompt側の統一を進める順序を推奨。
   - **影響範囲**: `core/agents/writer.ts`, `core/prompt/outputFormats.ts`,
     `components/output/FinalOutput.tsx`, `app/api/tact/route.ts`（`ExecutionResult`統合、3.6）。

### Phase 5: Analyst / Designer / Engineer / Stakeholder の実態確認と確定

これらは実行ログが乏しい（Analyst/Engineerは0件）ため、まず**Phase 1〜4を適用した状態で
実際に一度以上ワークフローを実行し、ログを取得してから**、3.3の統合案が実態と合っているか
再確認した上でsystemPrompt / outputFormats.tsを確定させる。**推測だけで先に確定させない。**

### Phase 6（任意・長期）: 実行時バリデーション（zod等）の導入

3.7の提案を実装するフェーズ。Phase 1〜5でスキーマの「あるべき形」が固まった後に、
その形を実行時にも強制する仕組みを導入する。このフェーズは他のフェーズと独立して
後回しにしても、Phase 1〜5の効果（実害の除去・一貫性の向上）は先に得られる。

### Phase 7（任意・長期）: `AgentResponse<K>`の入れ子構造化とAgent追加の型強制

3.4で触れた「`{data, toolRequests, handoff}`という入れ子構造への移行」と、
`AgentPayloadMap`に基づく`runWorkflow`ループの汎用化（Agent追加時にワークフロー
エンジン本体を一切変更しなくてよい状態）を行う、最も攻めた変更。10体以上への
拡張を見据える場合の最終形として位置づけるが、影響範囲が広いため他フェーズが
安定してから着手する。

---

## 5. まとめ表: フェーズと優先順位の対応

| Phase | 内容 | 優先順位（2.5対応） | 破壊的変更 | 前提 |
|---|---|---|---|---|
| 1 | Reviewer `retry` / Researcher `claim` 修正 | 最優先 | 小（内部実装のみ） | なし |
| 2 | `context.memory`型統一 | 優先 | 小〜中 | Phase 1 |
| 3 | Planner/QueryBuilderの死んだフィールド削除 | 中 | なし | なし |
| 4 | Writer / FinalOutput.tsx 統一 | 中 | 中（UI表示に影響） | なし（Phase1-3と並行可） |
| 5 | Analyst/Designer/Engineer/Stakeholder確定 | 低（要実測） | 未定 | Phase 1-4後に実測 |
| 6 | 実行時バリデーション導入 `[提案・任意]` | 長期 | 大 | Phase 1-5 |
| 7 | Envelope入れ子化・Agent追加の完全汎用化 `[提案・任意]` | 長期 | 大 | Phase 1-6 |

---

## 6. 未解決事項・今後の確認が必要な点

- Analyst・Engineerは実行ログが1件も無く、実際にLLMがどちらの形式（またはどちらでもない形式）で
  応答するかは未検証。Phase 5で必ず実測してから確定させる必要がある。
- Designer・Stakeholderの直近の挙動も未確認（最も古いログ1件のみ）。最近のsystemPrompt調整
  （git上`core/agents/*.ts`が複数更新されている）が影響している可能性があるため、
  現行コードのまま一度実行し直して再確認することを推奨する。
- Reviewerの`retry`欠落によって実際にワークフローの差し戻しがどう振る舞っていたか
  （Researcherへのfallbackが多発していたのか、単に`approved`扱いに近い動きをしていたのか）は、
  `logs/`だけでは`handleReviewer.ts`の分岐結果までは追えないため、追加のログ出力
  （どの分岐を通ったか）がないと正確には分からない。
- `zod`（または類似ライブラリ）の導入是非、および導入する場合の失敗時ハンドリング方針
  （エラーで止める／デフォルト値で補う／リトライする）はユーザーとの合意が必要。
- `AgentResponse<K>`を入れ子構造（`{data, toolRequests, handoff}`）にするかどうか
  （Phase 7）は、既存の全Agentのsystem prompt文言を書き換える大きな変更になるため、
  Phase 1〜6が安定してから改めて費用対効果を判断すべき。
