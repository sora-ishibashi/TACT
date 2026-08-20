# Dynamic Workflow Architecture（調査・設計）

STEP69の成果物です。**コード変更は一切行っていません。** `core/workflow/`・`core/planner/`・
`core/brain/`・`core/agent/`・`core/agents/`・`core/evidence/`・`core/prompt/`・
`core/context/`・`core/conversation/`・`core/optimizer/`・`core/advisor/`・
`components/design/`・`app/design/`を実際に読み、TACTが「単純な質問」から「論文レベルの
高品質リサーチ」まで多様なタスクを1つのシステムで扱うための、**Dynamic Workflow
Architecture**（タスクの種類・品質要求に応じてWorkflowを動的に構成する設計）を提示します。

既存の `docs/architecture.md`（現状の正確な記録）・`docs/tact-v2-architecture.md`
（10〜30 Agent・DAG実行・Agent Registryを見据えた長期設計）・
`docs/data-schemas.md`（スキーマ統一）・`docs/writing-quality-architecture.md`
（STEP65、文章品質のEvidence→Claim→Reasoning構造）とは軸が異なります。本ドキュメントは
「**どのタスクに、どれだけの思考工程を、どう動的に割り当てるか**」だけを対象とします。
ただし、これらのドキュメントで判明している構造・提案（AgentDefinition、3層Memory、
DAG実行エンジン等）は前提として引き継ぎ、矛盾しないように設計します。

推測ではなく、実際のコード上の事実だけを根拠にしています。事実（【既存】）と提案
（【提案】）は明確に分離しています。

---

## 1. Executive Summary

**現在のTACTは「1つの固定的な9段パイプライン」であり、「タスクに応じて思考工程を選ぶ
システム」ではありません。** `core/planner/getTeam.ts`は、Plannerが判定した`category`
（7種類の固定値）を見て、あらかじめハードコードされたAgent配列を返すだけです。

しかし調査の結果、**「タスクに応じて動的に振る舞いを変える」という発想自体は、TACTの
複数箇所に既にバラバラな形で実装されていた**ことが判明しました。

- `core/conversation/reconstructTask.ts`（Task Reconstruction）は、`requestType`
  （task/question）・`artifactType`（report/comparison/proposal/presentation）・
  `conversationMode`（evidence/idea）という**3つの独立した分類軸**を、Turnごとに
  LLM 1回で算出しています。
- `requestType === "question"`かつ既存成果物がある場合、TACTは**Workflow全体を
  スキップし**、`core/advisor/runAdvisor.ts`という「LLM1回呼び出しだけの軽量パス」で
  応答します。これは事実上、**TACTに既に存在する唯一の「高速経路」**です。
- `core/conversation/outputSpec.ts`は、`artifactType × detailLevel(brief/standard/
  detailed/deep) × mode(quick/think/deep)`から、Writerへの出力量ガイダンスを機械的に
  導出します。ただし**これはWriterのプロンプト文言を変えるだけで、実行するAgentの
  数や種類には一切影響しません**。
- `core/evidence/researchRequirement.ts`は、「検索が必要な依頼か」をキーワードで判定
  していますが、**Researcherを実行するかどうかの判断には使われておらず**、Researcher
  実行後の安全網としてのみ機能しています。
- Planner自身（`core/agents/planner.ts`）のsystemPromptは、`difficulty`・
  `requiredCapabilities`・Agentごとの`plan[]`という豊かな判断を出力するよう指示されて
  いますが、`core/workflow/handlePlanner.ts`は**`category`以外のフィールドを実質的に
  すべて捨てて**、`getTeam(category)`という固定テーブルへ差し替えています。

つまり、**TACTには「タスクの性質を理解する」機構が既に複数存在するのに、それらが
Workflow構成（＝どのAgentを動かすか）という一点で合流していない**、というのが
最大の構造的ボトルネックです。新しい分類機構をゼロから作る必要はなく、**既存の
分類軸を統合し、Planner/getTeamの決定ロジックへ接続する**ことが、Dynamic Workflow
Architectureの核心です。

同時に、TACT（回答生成）とTACT Design（`/design`、資料編集UI）は、**現時点では
コード上まったく接続されていません**。TACT Designは`app/design/page.tsx`にハード
コードされたサンプル`currentOutput`のみを扱い、その中のAI提案機能
（`components/design/mockDesignAgent.ts`、1047行）は**LLM呼び出しを一切含まない
ルールベースのモック**です。Evidence追跡性（STEP66で実装した`sections[].evidenceIds`）も
TACT Designの`DocumentModel`型には存在せず、変換関数でも参照されていません。
Citation UX（出典のコンパクト表示→クリックで一次情報）は、データモデルの土台
（`evidenceIds` → `Evidence.source`）は存在するものの、**現状どの画面にも一切表示
されていません**（`formatOutputText.ts`は意図的に`evidenceIds`を除外している）。

以上を踏まえ、本ドキュメントは「理想のAI Orchestrator像」ではなく、**現在のTACT →
最小限の変更 → Dynamic Workflow → 最終的なTACT Architecture**という段階的な進化を
提示します。

---

## 2. 現在のTACT Workflow構造【既存】

### 2.1 実行エンジン

`core/workflow/index.ts: runWorkflow()`が、`dynamicPlan`（`{id, agent, task}[]`）を
`currentStep`カウンタで順に消化する`while`ループです。並列実行・条件分岐・グラフ構造は
存在しません。

```
createContext()
  ↓
dynamicPlan = [...defaultWorkflow.steps]   ← 初期値。実質「plannerを1回動かすため」だけ
  ↓
while (currentStep < dynamicPlan.length) {
  runAgent(agent, step, context)
  if (agent.id === "planner") → handlePlanner() が dynamicPlan を丸ごと再構築
  if (agent.id === "reviewer") → handleReviewer() が承認/差し戻しでcurrentStepを操作
  currentStep++
}
  ↓
[STEP67] context.outputs.writerが存在すれば reviewWriterOutput() を1回だけ追加実行
  ↓
[STEP68] writerCritique.approved===falseなら reviseWriterOutput() → reviewWriterOutput() を
         各1回だけ追加実行（Revisionは最大1回、既存ループとは独立した直線コード）
  ↓
context.finalOutput = context.outputs.writer ?? 最終ステップの出力
  ↓
analyzeExecution() → optimizeExecution() → saveBrainMemory()
```

`core/workflow/defaultWorkflow.ts`の9ステップ（planner→queryBuilder→researcher→
analyst→designer→engineer→stakeholder→reviewer→writer）は、**実際にはPlannerが
実行された時点で`handlePlanner()`により完全に置き換えられ**、以降参照されません
（`handlePlanner.ts`が`plannerExecuted`を見て、Planner再実行時はスキップする形に
なっているため、実質「Plannerを1回動かすためだけの器」です）。

### 2.2 動的計画の実体（`handlePlanner.ts`）

Plannerの出力から、以下の手順で`dynamicPlan`を再構築します。

1. `parsed.category`（Plannerが選んだ7値の1つ）を見て`getTeam(category)`を呼ぶ
2. `team`に`researcher`が含まれ`queryBuilder`が含まれない場合、`researcher`の直前へ
   `queryBuilder`を自動挿入
3. `parsed.plan[]`（Planner自身が考えた「Agent別task文」）から`taskMap`を作り、
   各stepの`task`テキストとして利用（**Agentの選択自体には使われない**）
4. `dynamicPlan = team.map((agent, i) => ({id: String(i+1), agent, task: taskMap[agent] ?? ...}))`

### 2.3 `getTeam()`の実体（`core/planner/getTeam.ts`）

`category`文字列から固定Agent配列を返すだけの`switch`文です。

| category | Agent構成 |
|---|---|
| coding | queryBuilder, researcher, engineer, reviewer, writer |
| planning | queryBuilder, researcher, designer, stakeholder, reviewer, writer |
| design | queryBuilder, researcher, designer, reviewer, writer |
| business | queryBuilder, researcher, **analyst**, stakeholder, reviewer, writer |
| writing | queryBuilder, researcher, reviewer, writer |
| research | queryBuilder, researcher, **analyst**, reviewer, writer |
| default | queryBuilder, researcher, reviewer, writer |

重要な事実（STEP65で確認済み・再確認済み）：**`writing`とdefaultには`analyst`が
含まれません**。TACTで唯一Claim/Reasoning/Counterargument構造を持つAnalystが、
一般的な文章生成依頼では丸ごとスキップされます。

`category`以外の軸（`difficulty`・`mode`・`requiredCapabilities`・出力形式）は
`getTeam()`の判断に一切使われません。`mode`（quick/think/deep）はPlannerの
systemPromptに「Agent数の目安」として書かれてはいますが、**実際に何人選ぶかは
LLM自身の自由裁量であり、コード側に強制ロジックはありません**（`getTeam()`は
`mode`を引数として受け取ってすらいません）。

### 2.4 Reviewer/Revisionのループ機構

| 機構 | 実装 | 上限 | 対象 |
|---|---|---|---|
| Workflow内Reviewer retry | `handleReviewer.ts` | `MAX_REVIEW = 3` | researcher/analyst/designer/engineer/stakeholderへ差し戻し |
| Writer Critique（STEP67） | `reviewWriterOutput()` | 1回・無条件実行 | Writerの最終文章を読んで批評（結果は`context.writerCritique`） |
| Writer Revision（STEP68） | `reviseWriterOutput()` | 1回・`writerCritique.approved===false`時のみ | Writer自身が1回だけ書き直す（結果は`context.writerRevision`＋`context.outputs.writer`を上書き） |
| 再Critique（STEP68） | `reviewWriterOutput()`（同一関数を再利用） | 1回・Revision発生時のみ | 結果は`context.writerFinalCritique`。承認可否に関わらずそのままFinal Output採用（再帰なし） |

この4つは**互いに独立した仕組み**であり、共通の「Revisionカウンタ」やAgent単位の
リトライ予算は存在しません（`docs/tact-v2-architecture.md`が指摘する
「現行のグローバル`MAX_REVIEW`カウンタ」という課題は、Workflow内Reviewer retryにのみ
該当し、STEP67/68のCritique/Revisionは意図的に別経路として設計されています）。

---

## 3. 現在のAgent責務【既存】

`core/agents/*.ts`（9 Agent、`core/agents/index.ts`で配列化）:

| Agent | 責務（systemPromptの記述に基づく） | Evidence利用 | Tool |
|---|---|---|---|
| Planner | ユーザー依頼の分析、`category`/`difficulty`/`plan[]`の決定 | 参照しない | なし |
| QueryBuilder | Researcher用の検索クエリ設計のみ（検索は実行しない） | 参照しない | なし |
| Researcher | Evidence収集のみ。分析・推測禁止 | 生成する | web-search |
| Analyst | Evidence比較・因果分析・Insight抽出。新しい事実の追加禁止 | 分析する | なし |
| Designer | Evidenceに基づくUX/UI/画面設計（`informationArchitecture`/`screens`等） | 参照する | figma（未実装） |
| Engineer | Evidence＋Designerの設計に基づく技術実装方針 | 参照する | github/npm（未実装） |
| Stakeholder | Evidence＋Workflow Historyに基づくユーザー・事業価値評価 | 参照する | なし |
| Reviewer | 各Agent成果物の品質チェック、承認/差し戻し判断。STEP67以降はWriter最終文章のCriticとしても再利用 | 参照する | なし |
| Writer | 全Agent成果物の統合、最終文章生成。新しい事実・分析の追加禁止 | 最優先で参照 | markdown（未実装） |

**注意すべき既存の重複・矛盾（`docs/agents.md`・`docs/data-schemas.md`で確認済み、
本ドキュメントでも再確認）**:

- `core/agent/types.ts`（単数形ディレクトリ、legacy）と`core/agents/types.ts`
  （複数形、現行）という**2つの`Agent`/`AgentId`型定義が並存**しています。
  `core/agent/types.ts`の`AgentId`には`"analyst"`が含まれません。
  `planner.ts`/`researcher.ts`/`designer.ts`/`engineer.ts`/`stakeholder.ts`/
  `reviewer.ts`/`writer.ts`は前者から、`analyst.ts`/`queryBuilder.ts`は後者から
  `Agent`型をimportしており、ファイルごとにimport元が割れています（構造的に
  互換なため実害はありませんが、型定義が二重管理です）。
- Plannerのsystemプロンプト内「使用可能Agent」一覧（`researcher/designer/engineer/
  stakeholder/reviewer/writer`）にも**`analyst`が含まれていません**。Plannerは
  `category`だけを出力すればよいため実害は無いものの、Plannerが`plan[]`へ
  `analyst`を書くことは想定されていません。
- 「Designer」（Workflow Agent。UX/UI/画面設計を行う）と「TACT Design」
  （`/design`、資料編集UIアプリ）は**名前が似ているだけの完全に別概念**です。
  本ドキュメントでは以降「Designer Agent」「TACT Design」と明示的に呼び分けます。

---

## 4. 現在のEvidence Architecture【既存】

`core/context/types.ts`の`Evidence`型（`id, claim, evidence, source?, confidence,
score, sourceType?, hash?, createdBy, createdAt, tags, references?`）が単一の
Evidence表現です。

主な構成要素（実装済み・使用中）:

- `core/evidence/selectEvidence.ts`：`context.evidence`全体から、Agentごとの
  クエリ（ユーザー入力＋タスク＋Agent別キーワード）に関連する上位15件を抽出
- `core/evidence/retrieveEvidence.ts`：キーワード一致・出典種別・鮮度によるスコアリング
- `core/evidence/validateEvidenceIds.ts`（STEP66で汎用化）：`evidenceIds`配列の
  UUID形式・実在性を機械検証。Analystの5フィールド（デフォルト）とWriterの
  `sections`（明示指定）の両方に適用可能
- `core/evidence/researchRequirement.ts`：「検索が必要な依頼か」をキーワードで
  判定する`detectResearchRequirement()`。**ただしこれはResearcherが検索を
  skipした場合の事後安全網としてのみ使われ、事前に「Researcherを呼ぶかどうか」
  を決める用途には使われていません**
- `core/evidence/evidenceGuard.ts`：未検証の数値主張を検出する
  `containsUnverifiedQuantitativeClaim()`、Tool成功有無を見る
  `hasSuccessfulToolResult()`
- `core/evidence/normalizeResearcherEvidence.ts`：Researcherが返す複数の
  キー名（`claim`/`name`/`topic`等）を`toClaim()`で吸収する正規化

Evidenceは`sourceType`（official/government/paper/news/media/community/
user_file/unknown）で「一次情報かどうか」の分類軸を既に持っています。ただし
**この分類は表示・優先付けのために使われるだけで、「一次情報必須」のような
Workflow選択条件としては使われていません**。

未使用・空ファイル（`docs/architecture.md`で確認済み、再検証も一致）：
`core/evidence/rankEvidence.ts`（未使用）、`deduplicate.ts`/`indexEvidence.ts`
（未使用・空）。

---

## 5. 現在のWriter / Reviewer / Revision構造【既存】

STEP65〜68で構築した構造（本ドキュメント作成時点の最新状態）：

```
Evidence（Researcher収集・selectEvidence()で絞り込み）
  ↓
Analyst（category=business/researchの場合のみ実行される）
  insights[].background / causeAndEffect / reason / evidenceIds / counterArguments?
  ↓ evidenceIds は validateEvidenceIds() で機械検証済み
Writer
  sections[].evidenceIds（Shared Evidence内の実在ID。STEP66でschema定義＋
  outputFormats.tsの指示を追加。evidenceIds は validateEvidenceIds() で機械検証済み）
  ↓
[Writer Critique] reviewWriterOutput()（既存reviewerAgentを再利用、専用addendum
  プロンプトで①Evidence整合性②論理飛躍③Counterargument扱い④重複⑤構造⑥表現の
  過剰さを評価）→ context.writerCritique
  ↓ approved===false の場合のみ
[Writer Revision] reviseWriterOutput()（既存writerAgentを再利用、Critiqueを
  踏まえた最小修正を1回だけ依頼、evidenceIds再検証込み）→ context.outputs.writer を上書き
  ↓
[再Critique] reviewWriterOutput() をもう一度だけ実行 → context.writerFinalCritique
  （承認可否に関わらずこの時点のWriter出力がFinal Outputとして採用される）
```

この構造の重要な特性（実装上の事実）：

- **すべて既存の`reviewer`/`writer` Agent定義（systemPrompt）を流用**しており、
  新しいAgentは追加されていません。Critique/Revision専用の指示は、
  `buildPrompt()`の出力に追記する「addendumブロック」として実現されています
  （`runAgent.ts`の`writerSafetyNetBlock`等、STEP34以来の既存パターンを踏襲）。
- Critique/Revisionは`dynamicPlan`（＝Planner/getTeamが決める実行列）に含まれない
  **完全に別経路**であり、`category`に関わらず「Writerが実行された場合は必ず
  Critiqueが走る」という設計です（現状は無条件。STEP69で扱う「タスクによっては
  不要」という要求にはまだ応えられていません）。
- `context.outputs.reviewer`（Workflow内Reviewer retryの判定結果。
  `core/brain/analyzer.ts`・`core/advisor/buildAdvisorContext.ts`が参照）と
  `context.writerCritique`/`context.writerFinalCritique`は明確に分離されており、
  相互に上書きしません。

---

## 6. 現在のTACT Designとの接続【既存】

**結論：現時点でTACT（Workflow）とTACT Design（`/design`）の間に、コード上の接続は
一切存在しません。**

- `app/design/page.tsx`は、`SAMPLE_CURRENT_OUTPUT`という**ハードコードされたローカル
  定数**（`core/prompt/outputFormats.ts`のWriter出力schemaと同じ形）を初期状態として
  使います。ページ内コメントに「将来的にはTACT側の実際の会話結果に差し替わる想定の
  差し込み口」と明記されており、**未実装であることが既に自己申告されています**。
- `components/design/currentOutputToDocumentModel.ts`が`currentOutput`
  （Writer出力形）を`DocumentModel`（`Document > Page > Element`という抽象構造、
  `components/design/types.ts`）へ変換します。この変換関数は`evidenceIds`/
  `evidence`という語を一切参照しません（grep 0件）。`DocumentElement`型自体にも
  Evidence/Citationに相当するフィールドが存在しません。
- `components/design/types.ts`冒頭のコメントに「TACT本体（`core/*`）の型
  （Evidence・WorkflowContext等）には一切依存しない」と明記されています。これは
  意図的な設計判断（PowerPoint/Google Slides等への将来的なAdapter化を見据えた
  独立性）ですが、結果として**Evidence追跡性がTACT DesignのDocumentModelへ
  一切伝播しません**。
- `components/design/mockDesignAgent.ts`（1047行）は、ファイル名の通り
  「モック」であり、`runLLM`/`OpenAI`/`fetch`への参照が一切ありません（grep 0件）。
  ユーザー発言から`DesignIntent`→`DocumentOperation`（提案のみ、`status: "proposed"`
  止まり）を生成するロジックは、**すべてルールベースのTypeScriptコード**であり、
  実際のLLM呼び出しは行われていません。

つまり、STEP69が前提とする「TACT → TACT Design」という連携（Research/Analysis/
Evidence/Writer/Reviewerを経て、その成果をDesignへ渡す）は、**データの受け渡し経路も
AIロジックも、両方とも今回新規に設計・実装する必要があるもの**です。

---

## 7. 現在の構造の問題点（既存事実からの総合分析）

### 7.1 タスク分類が複数箇所に分散し、Workflow選択に合流していない【既存の事実の組み合わせ】

TACTには実は**3つの独立した分類ロジック**が既に存在します。

| 分類システム | 出力 | LLM呼び出し | Workflow選択への影響 |
|---|---|---|---|
| Task Reconstruction (`reconstructTask.ts`) | requestType（task/question）、artifactType（4種）、conversationMode（evidence/idea） | あり（Turnごと1回） | requestType=questionならAdvisorへ分岐（Workflow丸ごとskip）。artifactTypeはOutputSpec経由でWriterのプロンプト文言のみに影響 |
| Planner (`planner.ts`) | category（7種）、difficulty、requiredCapabilities、plan[] | あり（Workflow内1回） | categoryのみgetTeam()へ渡る。他は破棄 |
| researchRequirement.ts | boolean（検索必要か） | なし（正規表現） | Researcher実行後の安全網のみ。事前のAgent選択には未使用 |

この3つは**互いを参照しません**。例えば`conversationMode: "idea"`（壁打ち・
アイデア検討）と判定されても、Plannerはそれを知らずに`category`を独自に判定し、
`getTeam()`はいつも通りResearcher〜Writerのフルセットを組みます。逆に
`requestType: "question"`かつ`currentOutput`が無い場合（新規の単純質問）は
Advisorへ分岐する条件を満たさないため、**「今日の夕飯何にしよう」のような依頼も
フルWorkflowへ入ります**（STEP69の問題提起そのものが、実コード上でも再現される
条件だと確認できます）。

### 7.2 Evidence要求とAgent選択が結合していない

`getTeam()`の全カテゴリが`researcher`（＋`queryBuilder`）を含みます（例外なし）。
「壁打ち」「リライト」のようなEvidence不要なタスクでも、`category`が
`coding`/`writing`/`research`等いずれかに分類される限り、必ずResearcherが
実行されます。Evidence要否を独立した軸として持つ仕組みが存在しません。

### 7.3 品質レベルとAgent数が緩やかにしか連動していない

`mode`（quick/think/deep）はPlannerのsystemPromptに「目安人数」として書かれて
いますが、**強制力のあるコードロジックではありません**。同じ`category`であれば、
`mode`に関わらず`getTeam()`は同じAgent配列を返します（`getTeam(category)`は
`mode`を引数に取らない）。したがって「キャプション生成は高速に、論文リサーチは
最高品質に」という要求は、現状は完全にPlanner（LLM）の自由裁量に委ねられており、
**コード上の保証がありません**。

### 7.4 高速経路がAdvisorの1条件にしか存在しない

Advisorへ分岐する条件は`requestType === "question" && conversation.currentOutput`
のみです。「この文章を100文字にして」「誤字を直して」のような**新規生成を伴わない
軽微な編集タスク**は、`requestType`的には`task`寄りになりやすく（`修正して`が
TASK_SIGNAL_PATTERNSに含まれる）、Advisorの対象になりません。高速経路の対象範囲が
「既存成果物への質問」に限定されています。

### 7.5 STEP65〜68のCritique/Revisionが全タスクに無条件適用される

`context.outputs.writer`が存在すれば、`category`に関わらず必ずCritiqueが走ります
（`if (context.outputs.writer) { ... }`に`category`条件が無い）。「今日の夕飯」の
ような軽量タスクでも、Writer実行後に追加のLLM呼び出しが発生し得ます（現状は
`writing`/defaultも含め全カテゴリでWriterが最終ステップのため）。

### 7.6 TACT DesignとのEvidence連携が構造的に存在しない

6章の通り、DocumentModelにEvidence/Citation相当のフィールドが無いため、
「Research → Analysis → Evidence → Writer → Reviewer → Design」という流れを
今つなごうとしても、**Design側で受け取る型がそもそも対応していません**。

### 7.7 Citation UXの土台はあるが、出力経路で意図的に切り捨てられている

`Evidence.source`（出典URL）・`Writer.sections[].evidenceIds`（STEP66）という
データはあるのに、`components/output/formatOutputText.ts`は
「evidenceIds等の内部管理情報はユーザー向けコピー結果に含めない」という設計判断で
明示的に除外しています。`FinalOutput.tsx`系のレンダリング一式にも
`.source`/`sources[]`への参照は0件でした。**データはあるが、出力直前で捨てている**
状態です。

---

## 8. タスク分類案【提案】

### 【既存】との関係

0から分類軸を発明するのではなく、7.1で確認した3つの既存分類（requestType /
artifactType / conversationMode / category）を**統合・階層化**します。

### 【提案】2階層＋タグの分類モデル

分類を単一のenumにせず、**目的が異なる3つの独立した軸**として維持することを
提案します（ユーザー要求の「複数分類を組み合わせるべきか」への回答＝Yes）。

```
Axis 1: Intent（意図） … 既存 requestType を拡張
  "answer"     … その場で答えを返す（既存 question 相当）
  "edit"       … 既存成果物の軽微な変更（新規。要約/リライト/文字数調整/誤字修正等）
  "create"     … 新しい成果物をゼロから作る（既存 task の主要ケース）
  "explore"    … 壁打ち・アイデア整理・お悩み相談（既存 conversationMode: idea を格上げ）

Axis 2: Output Type（出力形） … 既存 artifactType をそのまま再利用・拡張
  "chat"          … チャット上の自然文回答のみ（新規。成果物を生成しない）
  "report"        … 既存
  "comparison"    … 既存
  "proposal"      … 既存
  "presentation"  … 既存（TACT Designと接続する主要ケース）
  "structured-data" … 新規。TACT Designへ渡す構造化情報のみを作るケース（後述15章）

Axis 3: Depth Requirement（深度要求） … category と mode を統合した新概念（10章で詳述）
```

なぜこの3軸か（判断根拠）：

- Intentは「AIが何をすべきか」を決める最上位の分岐であり、**Advisorへ行くか
  Workflowへ行くかを決める既存のrequestType分岐をそのまま一般化**したものです。
  新設ではなく既存分岐の名前を明確化するだけです。
- Output Typeは`artifactType`をそのまま使えます。追加するのは「chat」
  （成果物を作らない）と「structured-data」（TACT Design専用の中間形式、15章）の
  2値のみです。
- Depth Requirementは`category`（何をするか）と`mode`（どれだけ丁寧にやるか）が
  現状も別々の概念として存在するのに、実行制御には`category`しか使われていない
  という7.3の問題に対応します。10章で独立して設計します。

**階層型にすべきかタグ型にすべきか**：調査の結果、**Intentは階層のトップ
（最初に決まる）、Output TypeとDepth Requirementはタグとして併存**させるのが
実態に合うと判断しました。理由：`category`（現行の「何をするか」分類）は
Output Typeとほぼ1:1で対応しており（例：`coding`→実質reportのサブセット）、
無理に別軸として残すより、Output Typeへ吸収した方がPlannerが判断すべき変数が
減ります（`business`/`research`という2カテゴリだけがAnalystの有無を分けている
実態は、Depth Requirementの「Analysis工程が必要か」という軸で表現し直せます）。

### 【移行】

- **Phase 0**：分類そのものは変えず、既存の`requestType`/`artifactType`/
  `conversationMode`/`category`をそのまま維持する。ドキュメントとしてこの
  マッピング表を作るだけ（コード変更なし）。
- **Phase 1**：`reconstructCurrentTask()`の出力に、後述のDepth Requirement
  相当のヒント（例：`needsEvidence: boolean`、`needsAnalysis: boolean`）を
  **追加フィールドとして**加える（既存フィールドは削除しない、破壊的変更なし）。
- **Phase 2**：Planner側の`category`判定を段階的にOutput Type/Depth Requirementの
  組へ置き換える（`getTeam()`のシグネチャを`getTeam(category)`から
  `getTeam(outputType, depth)`のような形へ拡張。既存の`category`引数は当面
  残し、内部で新旧マッピングする）。

---

## 9. Evidence Mode案【提案】

### 【既存】

現状、Evidence要求は「Researcherが`getTeam()`の配列に含まれるかどうか」という
**バイナリ**でしか表現されていません（全カテゴリ含む＝実質常にYes）。
`researchRequirement.ts`はEvidence必要性を判定する機構を既に持っていますが、
Agent選択には使われていません（4章参照）。

### 【問題】

「壁打ち」「今日の夕飯どうしよう」のような相談にResearcher〜Writerのフルセットが
必ず投入され、不要なLLM呼び出し・レイテンシ・コストが発生します（10章と直結）。
逆に「大学のレポートとして提出できるレベルで、一次情報を中心に調査して」という
依頼では、`sourceType: official/government/paper`のような一次情報限定の要求が
現状のEvidence Mode（存在しない）では表現できません。

### 【提案】段階的Evidence Mode

```ts
type EvidenceMode =
  | "none"                  // Researcherを呼ばない。既存知識・会話文脈のみで回答
  | "optional"              // Researcherは呼ぶが、Evidence不足でも進行を止めない
  | "recommended"           // Researcherを呼び、Evidence不足ならWriterのlimitationsで明示
  | "required"              // Evidence不足時はWriterの安全網(STEP34 writerSafetyNet)を強化適用
  | "primary-source-required"; // sourceType: official/government/paper のみを許容重視
```

根拠：この5段階は、**既存の`researchRequirement.ts`（boolean）と
`writerSafetyNetBlock`（STEP34、Evidence不足時の安全網）を拡張するだけ**で
実現できます。特に`none`は、「Researcherを呼ばず即時回答する高速経路」
（STEP69で要求されている項目そのもの）を`EvidenceMode`の一種として位置づける
ことで、高速経路を特別扱いせず既存の分類体系の中に自然に収められます。
`primary-source-required`は、既存の`Evidence.sourceType`（`official`/
`government`/`paper`等、STEP32で既に実装済み）をフィルタ条件として使うだけで、
新しいEvidence分類は不要です。

### 【移行】

- **Phase 1**：`EvidenceMode`型を定義し、`researchRequirement.ts`の
  `detectResearchRequirement()`の戻り値をboolean→`EvidenceMode`相当へ拡張する
  （既存呼び出し元は`=== true`相当の判定を`!== "none"`に置き換えるだけで
  済むよう、後方互換な設計にする）。
- **Phase 2**：`getTeam()`（またはその後継）が`EvidenceMode === "none"`の場合、
  `researcher`/`queryBuilder`をteamから除外する分岐を追加する。
- **Phase 3**：`primary-source-required`を`selectEvidence()`のフィルタ条件として
  接続する（Evidence型・スコアリングロジックの変更は不要、`sourceType`で
  絞り込むだけ）。

---

## 10. Quality Level案【提案】

### 【既存】

`mode: "quick"|"think"|"deep"`は`WorkflowContext`に存在し、Plannerのプロンプトへ
「目安人数」として渡りますが、強制力はありません（7.3）。`outputSpec.ts`の
`detailLevel`（brief/standard/detailed/deep）はWriterの文章量にのみ影響し、
Agent構成には影響しません。

### 【問題】

「品質レベルを固定enumにすべきか、Plannerが動的に判断すべきか」という設計判断を
迫られますが、**現状はその中間の最悪な状態**（固定enumのように見えるmodeが
存在するのに、コードはそれを強制していない＝Plannerの気分次第）になっています。

### 【提案】Quality LevelをAgent構成に対する制約として明文化する

固定enumそのものは維持しつつ（ユーザーが直感的に選べる必要があるため）、
**「その品質レベルで許可されるAgent集合の上限」をコード側で保証する**設計を
提案します。

```ts
interface QualityProfile {
  level: "instant" | "quick" | "standard" | "high" | "maximum";
  maxAgents: number;                 // Plannerが選べるAgent数の上限
  allowedEvidenceModes: EvidenceMode[];
  allowsCritique: boolean;           // STEP67 Writer Critiqueを実行するか
  allowsRevision: boolean;           // STEP68 Writer Revisionを実行するか
  maxReviewerRetries: number;        // 既存 MAX_REVIEW の個別化
}
```

例（あくまで初期案。実測しながら調整する前提）：

| level | 用途例 | maxAgents | Evidence | Critique/Revision |
|---|---|---|---|---|
| instant | キャプション3案、誤字修正、100文字要約 | 0（Writer直接） | none | 両方false |
| quick | 壁打ち、簡単な質問 | 1〜2 | optional | Critiqueのみtrue |
| standard | 通常調査、レポート | 現行thinkの構成 | recommended | 両方true |
| high | 深掘り調査、経営会議資料 | 現行deepの構成 | required | 両方true |
| maximum | 論文・学術リサーチ | 制限なし（Analystの
  Evidence→Claim→Reasoning→Counterargument構造を必須化） | primary-source-required | 両方true、Revision上限を2回程度に緩和検討 |

**「Plannerが動的に判断すべきか」への回答**：QualityProfileの**選択**
（どのlevelにするか）はPlanner（LLM）に任せます。ユーザーの語調・明示的な
要求水準から判断する作業はLLMが得意な領域だからです。しかし**選ばれたlevelが
何を許可するか（上限）はコード側で固定**します。これにより「Plannerが暴走して
全Agentを毎回動かす」「逆に重要な依頼を手抜きする」という両方向のリスクを、
コードの制約で吸収します（Plannerの自由度とコードの安全網を分離する、という
`docs/tact-v2-architecture.md`の原則2「機構と方針の分離」と整合します）。

### 【移行】

- **Phase 1**：`QualityProfile`をドキュメント／型として定義するだけ
  （コード未接続）。既存の`mode`はそのまま残す。
- **Phase 2**：`getTeam()`の戻り値を`QualityProfile.maxAgents`でクリップする
  安全網を追加する（Plannerの`plan[]`がこの上限を超えていたら切り詰める。
  Planner自体は変更しない）。
- **Phase 3**：Critique/Revision（STEP67/68）の実行条件に
  `qualityProfile.allowsCritique`/`allowsRevision`を追加する（7.5の問題を解消）。

---

## 11. Dynamic Workflow案【提案】

### 【既存】

`dynamicPlan`は`{id, agent, task}[]`という**フラットな配列**です。並列実行や
「このAgentは今回スキップする」という表現力はありません（`docs/tact-v2-
architecture.md`が指摘するDAG化提案と同じ制約）。

### 【提案】「固定パイプラインの部分集合選択」から始める

`docs/tact-v2-architecture.md`が提案するDAG実行エンジンは、Agent数が10〜30に
スケールする将来（並列実行が必須になる規模）を見据えた設計です。STEP69が扱う
「タスクごとに必要な工程だけを選ぶ」という要求は、**DAG化を待たずに、現行の
線形配列のまま「どのAgentを含めるか」を動的に決める**ことで大部分が実現できます。

```
必要な思考工程の判定（Task Understanding + Requirement Analysis の出力）
  ↓
{
  needsQuery: boolean,       // QueryBuilderが要るか（needsEvidenceと連動）
  needsEvidence: EvidenceMode,
  needsAnalysis: boolean,    // Analystが要るか（現行はcategoryのみに依存）
  needsDesign: boolean,      // Designer Agentが要るか
  needsEngineering: boolean,
  needsStakeholderView: boolean,
  needsCritique: boolean,    // STEP67
  needsRevision: boolean,    // STEP68
}
  ↓
既存 getTeam() 相当のロジックが、この構造体から Agent配列を組み立てる
（「categoryごとの固定配列」から「フラグごとのAgent追加」へ変わるだけ）
```

これは`docs/tact-v2-architecture.md`のDAG案と**対立しません**。むしろ、
同ドキュメントが12章で述べる「Phase B：既存9Agentの`systemPrompt`オブジェクトを
`AgentDefinition`でラップするだけ」という段階と並走できます。DAG化（Phase C以降）が
実現すれば、この「フラグの集合」はそのまま「どのノードをグラフに含めるか」の
入力へ転用できます。**今回のDynamic Workflow設計は、DAG化の前段として矛盾なく
接続できるよう意図的に設計しています。**

### 【問題として残ること】

Reviewer/Writerの位置（最後から2番目/最後）のような**順序制約**は、フラグ集合
だけでは表現できません。この順序ルールは、現行`planner.ts`のプロンプト内
ハードコード（「ReviewerはWriterの直前」）としてのみ存在し、コード側の強制は
ありません。Dynamic Workflow化してもこの制約は明文化されたコードロジックとして
残す必要があります（LLMの指示遵守だけに頼らない）。

### 【移行】

- **Phase 1**：現行`getTeam(category)`はそのまま残し、**新しい
  `getDynamicTeam(flags)`関数を並行して追加**する（既存呼び出しへの影響ゼロ）。
- **Phase 2**：`handlePlanner.ts`が、Plannerの出力から`flags`を組み立てられる
  ようになった時点で、`getTeam(category)`から`getDynamicTeam(flags)`へ
  呼び出しを差し替える（`category`自体は`flags`導出の入力の1つとして残しても良い）。
- **Phase 3**：`getTeam(category)`を「非推奨だが後方互換のために残す」
  ラッパーへ格下げする（削除はしない。CLAUDE.mdの「既存機能を削除する変更」に
  該当するため、削除には別途ユーザー確認が必要）。

---

## 12. Planner / Workflow Compiler案【提案】

### 【既存】

Plannerは1回のLLM呼び出しで`category`を含む豊かなJSONを返しますが、
`handlePlanner.ts`が使うのは実質`category`と`plan[].task`（テキストのみ）
だけです。ユーザーが提示した理想形

```
User Request → Task Understanding → Task Type → Output Type →
Quality Requirement → Evidence Requirement → Reasoning Requirement →
Required Agents → Workflow → Execution
```

は、**現状のPlanner 1回のLLM呼び出しの中に、暗黙的にすべて詰め込まれています**
（`goal`＝Task Understanding、`category`＝Task Type、`difficulty`＝Quality
Requirement相当、`requiredCapabilities`＝Required Agents相当）。問題は
「LLMの頭の中では多段階の推論をしているはずなのに、出力形式が`category`という
1つの値に圧縮されてしまい、後続のコードがその推論過程を再利用できない」ことです。

### 【提案】Plannerの出力スキーマを「推論の各段階」に対応させる

新しいAgentを追加するのではなく（禁止事項どおり）、**Planner 1体のsystemPrompt/
出力スキーマを拡張**し、`handlePlanner.ts`が各段階を個別に読み取れるようにします。

```ts
interface PlannerOutputV2 {
  goal: string;                         // 既存
  taskUnderstanding: string;            // 既存の thinking を明確化

  intent: "answer" | "edit" | "create" | "explore";     // 8章 Axis 1
  outputType: OutputType;                                // 8章 Axis 2（既存 category を代替/拡張）
  qualityLevel: QualityProfile["level"];                 // 10章
  evidenceMode: EvidenceMode;                            // 9章
  reasoningRequirement: {
    needsAnalysis: boolean;             // Analystを含めるか（現行は business/research categoryのみ）
    needsCounterargument: boolean;      // AnalystにcounterArguments重視を指示するか(STEP66)
  };

  requiredAgents: AgentId[];            // 既存 requiredCapabilities を具体化
  reason: string;                       // 既存
  plan: { agent: string; task: string }[]; // 既存
}
```

これは「Workflow Compiler」という新しい概念を導入するというより、**現状すでに
Plannerが（プロンプト上は）行っている推論を、コードが読み取れる形へ分解する**
だけです。`handlePlanner.ts`は、`getDynamicTeam(flags)`（11章）へこの構造体を
渡すだけの薄いアダプタになります。

**「Planを信頼してよいか」という安全性の論点**：現行`handlePlanner.ts`が
`category`しか使わず`plan[]`のAgent選択を無視しているのは、恐らく
「LLMが存在しないAgent名を書く」「Reviewer/Writerの順序を誤る」といった
ハルシネーションへの安全策だったと推測されます（ただしこれはコード上の
コメントに明記された理由ではなく、本ドキュメントの推測であることを明示します）。
この懸念は、`requiredAgents`を**検証してから使う**（存在しないAgent名は無視、
Reviewer/Writerの位置はコード側で強制）ことで解消でき、「LLMの判断を全面的に
信頼する」のではなく「LLMの判断をコードが検証してから採用する」という
折衷案にできます。

### 【移行】

- **Phase 1**：`outputFormats.ts`のplannerエントリへ新フィールドを**追加**
  （既存の`category`/`difficulty`等は削除しない）。`handlePlanner.ts`は
  引き続き`category`のみを見る（新フィールドはログ・分析用途にのみ使う）。
- **Phase 2**：`requiredAgents`の検証ロジック（存在するAgent名か、
  Reviewer/Writerの位置は強制、禁止Agent混入時はcategoryベースへfallback）を
  追加し、`category`と`requiredAgents`のどちらを採用するかをA/B的に比較できる
  ようにする。
- **Phase 3**：検証済み`requiredAgents`を正として採用し、`category`は
  「フォールバック用の粗い分類」として格下げする。

---

## 13. 高速経路案【提案】

### 【既存】

既に存在する唯一の高速経路はAdvisor（`runAdvisor.ts`）で、条件は
`requestType === "question" && conversation.currentOutput`のみです。Advisorは
`runLLM()`を1回呼ぶだけで、Workflow/Agent/Evidence/Reviewerを一切経由しません。

### 【問題】

「この文章を100文字にして」「誤字を直して」「キャプションを3案出して」のような
軽量編集タスクは、Advisorの条件（question限定）に当てはまらず、フルWorkflowへ
入ってしまいます。

### 【提案】Advisorパターンを「編集」タスクへ拡張する

新しいAgentは作らず、Advisorと同じ「軽量ヘルパー関数」パターン
（`buildXxxContext()` + `runLLM()`1回）を、**編集専用のもう1つの軽量パスとして
横展開**します。

```
Intent（8章）
  ├─ "answer" かつ 成果物あり           → 既存Advisor（変更なし）
  ├─ "edit" かつ EvidenceMode === "none" → 新規: Quick Editor
  │    （currentOutputとユーザー指示だけをWriterのsystemPromptで1回処理。
  │     Researcher/Analyst/Reviewer/Critique/Revisionをすべてskip）
  └─ それ以外                            → 既存フルWorkflow
```

**なぜ新しいAgentを作らないか**：Quick Editorは、既存の`writer` Agent定義
（systemPrompt）をそのまま再利用し、`reviseWriterOutput()`（STEP68で実装済み）と
**ほぼ同じ関数シグネチャ**（現在の成果物＋指示→修正後の成果物、
`validateEvidenceIds()`適用込み）で実現できます。STEP68のRevisionが
「Reviewerの指摘を踏まえた修正」であるのに対し、Quick Editorは
「ユーザーの直接指示を踏まえた修正」という違いだけで、**コード構造としては
STEP68で既に確立したパターンの横展開**です。

### 【安全性への配慮（ユーザー要求の「安全性・品質を最優先」に対応）】

- Quick Editorが扱えるのは`EvidenceMode: none`かつ`intent: edit`の場合のみに
  厳格に限定する（Evidenceを要する変更・新規性の高い変更は対象外とし、
  誤判定時は安全側＝フルWorkflowへfallbackする）。
- 既存の`sections[].evidenceIds`は、Quick Editorでも
  `validateEvidenceIds()`を必ず適用し、STEP66の保証を維持する。
- Quick Editorが対象外と判断すべきケース（曖昧・複合的な指示）は、
  `requestTypeGuard.ts`と同じ「両方のシグナルが検出された場合はLLM判定を
  尊重する」という既存の安全側設計方針を踏襲する。

### 【移行】

- **Phase 1**：Quick Editorの対象範囲（正規表現ベースのパターン検出、
  `outputSpec.ts`/`requestTypeGuard.ts`と同じ手法）をログ収集のみの形で
  試験導入し、実際に「Quick Editor対象と判定されるが実はフルWorkflowが
  必要だった」誤判定率を計測する（実行経路は変えない）。
- **Phase 2**：誤判定率が許容範囲であれば、実際にフルWorkflowをbypassする
  経路として有効化する。

---

## 14. Research / Academic Workflow案【提案】

### 【既存】

STEP65〜68で構築した「Evidence→Claim→Reasoning→Counterargument→Conclusion→
Writer→Critic→Revision」は、**現状すでにコードとして存在します**が、
`category`に関わらず一律に適用されている部分（Writer Critique）と、
`category`次第で欠落する部分（Analyst、よってCounterargument）が混在しています
（5章・7.5参照）。

### 【提案】この構造を「maximum Quality Level」の定義そのものとして位置づける

新しい構造を作るのではなく、10章のQualityProfileの`maximum`レベルの**中身**を、
STEP65〜68で既に実装済みの経路として明文化します。

```
maximum Quality Level =
  EvidenceMode: primary-source-required
  + Analyst必須（insights[].counterArguments重視をプロンプトで強調）
  + Writer Critique必須（既存 reviewWriterOutput()）
  + Writer Revision許可（既存 reviseWriterOutput()、上限は当面1回のまま）
```

「通常会話では不要」という要求への対応は、10章のQualityProfileが
`instant`/`quick`では`allowsCritique: false`を返すことで実現されます
（＝Critique自体を条件付き実行にする。7.5の問題点の解消と同じ変更）。

**論文レベルへさらに近づけるために、今回新たに追加すべきと分かった要素**
（今回の調査で判明した、現状Writerの通常経路には無い工程）：

- Writerの`sections[].evidenceIds`は**存在確認**（STEP66）のみで、**意味的な
  支持関係の検証**（そのEvidenceが本当にその文でその主張を支持しているか）は
  Critique（LLMの目視相当）に依存しています。これは`validateEvidenceIds()`の
  設計思想（「Evidence IDが実在すること」と「Evidenceが主張を支持すること」は
  別問題、STEP66完了報告に明記）と一貫しており、後者を機械化することは
  今回のスコープ外とします（LLM品質に依存する領域）。
- `limitations`（Writer全体で1つのグローバル配列）は、Claim単位・Section単位の
  限界表明ではありません。「論文レベル」の要件に含まれる「反証と限界」を
  Section単位で表現する拡張は、STEP65のドキュメントが既に指摘済みの
  未解決事項であり、本ドキュメントでも同じ結論を維持します（`counterArguments`
  同様、Analystの`insights[]`単位に留め、Writerの`sections[]`への伝播は
  別途の判断が必要）。

### 【移行】

10章のQualityProfile導入と同時に実現できます。追加のPhaseは不要です。

---

## 15. TACT回答とTACT Designの分離案【提案】

### 【既存】

6章の通り、接続は一切存在しません。TACT Designは独立したサンプルデータの上で
動くプロトタイプです。

### 【提案】中間形式としての「Structured Deliverable」

TACT側の成果物（`context.outputs.writer`、`sections[].evidenceIds`を含む）を、
TACT Designの`DocumentModel`へ変換するAdapter層を新設する、という設計方針を
提案します。ただし今回はコードを書かないため、**型レベルの方針**のみ示します。

```
TACT側（core/*）
  WriterOutput（sections[].evidenceIds を含む、既存schema）
      │
      │ 新設: adaptWriterOutputToDocumentModel()
      │   currentOutputToDocumentModel.ts の隣に追加する想定の新規関数。
      │   既存の currentOutputToDocumentModel() 自体は変更しない
      │  （TACT Designが今のサンプルデータでも動き続けられるようにするため）。
      ▼
TACT Design側（components/design/*）
  DocumentModel + Citation拡張（16章）
```

ユーザーが提示した3ケースの分岐は、8章のIntent/Output Type軸でそのまま表現
できます。

| ユーザー依頼例 | Intent | Output Type | 結果 |
|---|---|---|---|
| 「トヨタの生成AI戦略について教えて」 | answer | chat | TACT自身が回答（既存Advisor or 軽量Workflow） |
| 「〜についてプレゼン資料を作って」 | create | presentation | フルWorkflow → Structured Deliverable → TACT Design |
| 「〜について経営会議向け資料を作って」 | create | presentation（qualityLevel: high以上） | Research→Analysis→Evidence→Writer→Reviewer→Design（フル経路） |

「Knowledge/Evidence/Claims/Reasoningなどの中間成果物」と「最終的な
Presentation/Document/Design」の分離は、**現状のTACT側の型が既にこの分離を
体現しています**（`Evidence`＝Knowledge層、`Analyst.insights[]`＝Claim/
Reasoning層、`Writer.sections[]`＝Document層への変換直前の層）。不足しているのは
Document層からDesign層（DocumentModel）への**変換Adapterだけ**であり、
TACT側のデータモデルを作り直す必要はありません。

### 【移行】

- **Phase 1**：`adaptWriterOutputToDocumentModel()`を新設し、まず
  `evidenceIds`を無視した最小変換（現行の`currentOutputToDocumentModel()`と
  同等の変換）から始める（既存のTACT Design UIへの影響を最小化）。
- **Phase 2**：`DocumentElement`へCitation拡張（16章）を追加した上で、
  Adapterが`evidenceIds`→`Evidence`実体を解決してDocumentModelへ埋め込む。
- **Phase 3**：`app/design/page.tsx`の`SAMPLE_CURRENT_OUTPUT`を、実際の
  Conversation/Workflow結果に差し替える経路を実装する（API設計が必要な
  大きめの変更のため、別STEPでの実装を推奨）。

---

## 16. Citation Architecture案【提案】

### 【既存】

追跡可能性の材料はすでに存在します：`Evidence.id/source/sourceType/confidence`
（`core/context/types.ts`）、`Writer.sections[].evidenceIds`
（STEP66、`validateEvidenceIds()`で機械検証済み）、`Analyst.insights[].
evidenceIds`（同様に検証済み）。しかし6.2・7.7で確認した通り、**この追跡可能性は
Writerの出力JSONの中で止まっており、ユーザーが見るどの画面にも一切表示されて
いません**。

### 【提案】「後付けでURLを貼る」のではなく「生成時点のIDをそのまま最終出力まで運ぶ」

```
Evidence（id, source, sourceType, confidence）
  ↓ evidenceIds（実在性は既にvalidateEvidenceIds()で保証済み）
Claim（Analyst.insights[] / Writer.sections[]）
  ↓
Citation（新設する薄い型。Evidence実体への「解決」を行うだけ）
  ↓
Output（FinalOutput.tsx / TACT Design DocumentModel の両方）
```

```ts
// 提案する最小限の新規型（既存Evidence型は変更しない）
interface Citation {
  evidenceId: string;      // 既存 Evidence.id への参照
  label: string;           // 表示用の短いラベル（例："[1]"）
  source?: string;         // Evidence.source をそのまま複製（表示層が
                            // context.evidence全体を持ち歩かなくて済むように）
  sourceType?: Evidence["sourceType"];
}

interface CitationIndex {
  // sections[index] や insights[index] ごとの Citation[] を持つマップ。
  // 「文章中はコンパクト表示、クリックで一覧」というUXを実現するための
  // 索引であり、本文テキスト自体は変更しない。
  bySection: Record<number, Citation[]>;
}
```

`buildCitationIndex(writerOutput, evidencePool)`という**純粋関数**
（`validateEvidenceIds()`と同じ思想：入力を書き換えず、対応表だけを作る）を
新設すれば、既存の`sections[].evidenceIds`と`context.evidence`から機械的に
導出できます。新しいEvidence管理システムは不要です。

**表示層への提案**（今回はUI実装禁止のため設計のみ）：`FinalOutput.tsx`は
`CitationIndex`を受け取り、section本文の末尾に`[1][2]`のようなコンパクトな
参照を追加表示し、クリックで該当`Citation[]`（→`source`）を展開する、という
構成が既存コンポーネント構造（`components/output/parseContentBlocks.ts`が
section本文を解析している）と自然に接続できます。TACT Design側は、
`DocumentElement`へ`citations?: Citation[]`という**追加のoptionalフィールド**
（既存フィールドは変更しない）を持たせることで、15章のAdapterから同じ
`CitationIndex`を再利用できます。

### 【移行】

- **Phase 1**：`buildCitationIndex()`を純粋関数として実装し、ログ出力・
  デバッグ目的にのみ使う（UI変更なし）。
- **Phase 2**：`formatOutputText.ts`（現在意図的に`evidenceIds`を除外している
  箇所）に、除外ではなく「Citation表示に変換する」分岐を追加する
  （既存の「内部管理情報は含めない」という判断自体は、生のUUIDを見せない
  という意味では維持しつつ、人間可読なラベル`[1]`へ変換する）。
- **Phase 3**：`DocumentElement.citations?`を追加し、15章のAdapterと接続する。

---

## 17. Workflow再利用性【既存の分析＋提案】

### 【既存】既存Agentの転用可能性

| 目的タスク | 既存Agentの組み合わせで対応可能か |
|---|---|
| Report | 既存の`research`/`business` categoryそのまま |
| Academic Research | 既存Agent＋14章のmaximum Quality Level（新Agent不要） |
| Presentation | 既存Agent＋15章のAdapter（新Agent不要、ただしAdapterは新規実装が要る） |
| Summary | Writer単独、または13章のQuick Editor（新Agent不要） |
| Business Analysis | 既存の`business` category（Analyst含む）そのまま |
| Market Research | 既存の`research` category（Analyst含む）そのまま |

### 【既存】Agentだけでは対応できないケース

調査の結果、以下は既存9 Agentの組み替えでは対応できず、**新しい種類のコード**
（Agentではなく、変換・索引・ルーティングのロジック）が必要と判断しました。

1. **TACT Design連携（15章のAdapter）**：Agentの追加ではなく、既存Writer出力を
   別スキーマへ変換するデータ変換層が必要です。
2. **Citation表示（16章）**：同様に、Agentではなく索引構築＋表示層の変換が必要です。
3. **高速経路の判定（8章・13章）**：Agentではなく、Task Reconstruction/
   Plannerが出力する分類をコード側で解釈するルーティングロジックが必要です。
4. **画像生成・音声等のマルチモーダル出力**：現行9 Agentはすべてテキスト
   （JSON）を返す設計であり、Designer Agentの出力（`screens[]`等）は
   「画像生成AIへの設計指示書」止まりです。実際の画像/音声生成を行う
   Agentは現状存在せず、これは新しいAgentカテゴリ（Tool経由か、専用Agentか）が
   必要になる可能性が高い領域です（ただし本STEPの実装対象外）。

### 【提案】

新しい未知のタスクが来た場合、まず「既存9 Agent＋Quality Profile/Evidence Mode
の組み合わせで表現できないか」を先に検討し、それでも表現できない場合にのみ
新しいAgentを検討する、という優先順位をPlanner設計（12章）のガイドラインとして
明文化することを提案します。

---

## 18. Cost / Latency設計【提案】

### 【既存】

LLM呼び出し回数は、Agent数（`getTeam()`の配列長）＋Tool呼び出し時の2パス
（`runAgent.ts`、Tool実行後の再呼び出し）＋STEP67 Critique（+1）＋STEP68
Revision時（+2：Revision＋再Critique）で決まります。現状これらはすべて
「無条件で最大構成」（例外は`getTeam()`のcategory差のみ）です。

### 【提案】Quality Levelごとの呼び出し回数の目安表

10章のQualityProfileをそのままコスト設計として転用します。

| level | Agent数目安 | LLM呼び出し回数目安（Tool・Critique・Revision込み） |
|---|---|---|
| instant | 1（Writer相当） | 1 |
| quick | 1〜2 | 1〜2 |
| standard | 現行 default〜research 相当（4〜6） | 5〜8（Critique含む） |
| high | 現行 planning〜business 相当（6） | 8〜11 |
| maximum | 6〜7＋Revision許可 | 10〜14（Revision発生時） |

この表はQualityProfileの`maxAgents`/`allowsCritique`/`allowsRevision`から
機械的に導出できるため、**別の設計を持つ必要はありません**（10章の型定義を
そのままコスト見積もりにも使う）。

### 【提案】観測性

`docs/tact-v2-architecture.md`が指摘する「観測性が低い」問題（9章）と同じ
課題がここでも該当します。実際にQuality Levelごとのレイテンシ・コストを
検証するには、`logs/<timestamp>-<agentId>.json`という現行のファイル出力に
加えて、「この実行がどのQuality Levelで、実際に何回LLMを呼んだか」を
`context.executionRecord`（既存フィールド）へ記録することを提案します
（新しい永続化機構は不要、既存フィールドへの追記のみ）。

---

## 19. 既存コードを壊さない移行戦略

各章の【移行】を統合した、優先順位付きの全体像です。**すべてのPhaseは、
既存の`category`ベースのWorkflowが並行して動き続けることを前提とします**
（新しい分類軸は既存分類の隣に追加し、置き換えは検証後に段階的に行う）。

```
Phase 0（ドキュメントのみ、本STEP）
  Dynamic Workflow Architecture の設計確定

Phase 1（追加のみ、既存経路に影響なし）
  - EvidenceMode型・QualityProfile型・Intent/OutputType型を定義（コードのみ、未接続）
  - reconstructCurrentTask() の出力へ needsEvidence 等のヒントフィールドを追加
  - buildCitationIndex() を純粋関数として実装（ログ用途のみ）
  - getDynamicTeam(flags) を getTeam() と並行して新設（未接続）

Phase 2（条件分岐の追加、安全網あり）
  - Critique/Revision(STEP67/68)の実行条件に qualityProfile.allowsCritique/
    allowsRevision を追加（7.5の解消）
  - Quick Editor（13章）を試験導入し、誤判定率をログ計測してから有効化
  - EvidenceMode: none の場合、Researcher/QueryBuilderをteamから除外

Phase 3（Planner出力の拡張と検証）
  - PlannerOutputV2（12章）を導入し、requiredAgentsの検証ロジックを追加
  - category → requiredAgents への段階的な主従逆転

Phase 4（TACT Design接続）
  - adaptWriterOutputToDocumentModel() の新設
  - DocumentElement.citations? の追加
  - SAMPLE_CURRENT_OUTPUT の実データ接続（別途API設計が必要な大きめの変更）

Phase 5（DAG化との合流）
  - docs/tact-v2-architecture.md の Phase B以降と合流。
    Dynamic Workflowで確立した「フラグの集合」を、DAGノード選択の入力として転用
```

各Phaseは独立してリリース可能な粒度にしてあり、Phase 1〜2は`docs/tact-v2-
architecture.md`のPhase A〜Cと並行して進められます（相互依存はありません）。

---

## 20. STEP70以降の実装ロードマップ（優先順位付き）

STEP70で最初に着手すべきものを、影響範囲の小ささ・既存資産の再利用度・
ユーザー体感インパクトの3点で評価し、優先順位を付けます。

1. **最優先**：`EvidenceMode`型の定義と`getTeam()`（または`getDynamicTeam`）への
   `none`条件の接続（9章Phase 1〜2、11章Phase 1）。既存資産（`researchRequirement.
   ts`）の転用度が最も高く、「壁打ちにResearcherが要らない」という最も分かり
   やすい体感インパクトを持つ。追加LLM呼び出しコストはむしろ**削減**方向。
2. **優先**：Critique/Revision（STEP67/68）の実行条件へのQuality Level接続
   （10章Phase 3、7.5の解消）。既存コード（`core/workflow/index.ts`の
   `if (context.outputs.writer)`ブロック）へ条件を1つ足すだけで済み、
   影響範囲が小さい。
3. **優先**：`reconstructCurrentTask()`出力への`intent`/`needsEvidence`ヒント
   フィールド追加（8章Phase 1）。既存のLLM呼び出しを1回のまま、出力
   フィールドを追加するだけで済み、後続すべてのPhaseの入力になる。
4. **中期**：Quick Editor（13章）の試験導入。STEP68で確立した
   `reviseWriterOutput()`パターンの横展開であり、実装パターンは既に検証済み。
5. **中期〜長期**：PlannerOutputV2 と `requiredAgents`検証ロジック（12章）。
   Plannerのプロンプト変更を伴うため、他のPhaseより品質回帰リスクが高く、
   慎重な検証（`docs/tact-v2-architecture.md`のPhase G同様の段階的移行）が
   必要。

TACT Design接続（Phase 4）・Citation UI表示（16章のPhase 2〜3）は、
API設計・UI実装を伴う大きめの変更であり、STEP70では着手せず、
それぞれ独立したSTEPとして計画することを推奨します。

---

## 21. 未解決事項

- **Planに対する信頼度の検証方法**：12章で述べた「LLMのAgent選択をコードが
  検証してから採用する」という設計の、具体的な検証ロジック（どこまで
  ホワイトリスト化するか）は今回設計していません。
- **Quality Levelの初期パラメータの妥当性**：10章・18章の表（maxAgents・
  LLM呼び出し回数目安）は、既存の`category`別Agent数から類推した初期値で
  あり、実測（STEP53/54で行われたような実測ベースの調整）は行っていません。
- **Quick Editorの誤判定コスト**：13章で「安全側にfallbackする」と述べましたが、
  fallback発生時にユーザーへ追加のレイテンシが生じることの体感影響は
  未検証です。
- **TACT Designの実データ接続の認証・永続化設計**：15章Phase 3
  （`SAMPLE_CURRENT_OUTPUT`の実データ化）は、Conversation/DBとの接続を伴う
  ため、本ドキュメントのスコープ外（別STEPでのAPI設計が必要）です。
- **画像生成・音声等のマルチモーダル対応**（17章）：新しいAgentカテゴリが
  必要になる可能性が高いと分析しましたが、具体的な設計は今回行っていません。
- **`docs/tact-v2-architecture.md`のDAG化との実装順序**：19章Phase 5で
  「合流できる」と述べましたが、実際にどちらを先に着手すべきかは、
  チームの優先順位判断に委ねます（本ドキュメントは両立可能性のみ示しています）。

---

## 22. 今回採用しなかった設計案と理由

- **完全に新しいTask Classifier Agentの新設**：STEP69の禁止事項
  （新規Agent追加禁止）に反するだけでなく、7.1で判明した通り、**既に3つの
  分類ロジックが存在し、それらを統合する方が既存資産の再利用度が高い**ため
  採用しませんでした。
- **`category`のenum自体を今回作り直す（例：新しいenum値を今すぐ追加する）**：
  8章で述べた3軸モデルへの移行は、`category`という1軸のenumを別の1軸のenumへ
  置き換えるだけでは実現できません（Intent/OutputType/Depthという直交する
  3軸が必要）。しかし今回はコード変更が禁止されているため、`category`の
  enum値自体を今変更する提案はせず、将来の移行計画（19章）としてのみ位置づけました。
- **Reviewer/Writerの順序制約をPlannerの自由記述に委ねたまま拡張する**：
  12章で述べた通り、既存の順序制約（ReviewerはWriterの直前）はプロンプト
  指示のみに依存しており、コード側の強制がありません。この状態のまま
  Dynamic Workflowを拡張すると、Agent数が増えるほど誤った順序が生成される
  リスクが高まると判断し、「Plannerの判断をコードが検証する」という
  折衷案（12章）を採用しました。
- **DAG実行エンジンを本ドキュメントで独自に再設計すること**：
  `docs/tact-v2-architecture.md`が既に詳細な設計（Phase A〜K）を提示済みで
  あり、重複した設計をここで作ることは「ドキュメントの手動同期」という
  TACT自身が抱える問題（`docs/tact-v2-architecture.md`原則1）を繰り返すだけ
  だと判断し、代わりに「両ドキュメントがどう接続するか」（19章Phase 5）
  のみを示しました。
- **Evidence Modeを`Evidence`型自体のフィールドとして持たせること**：
  Evidence Modeは「このタスクにEvidenceがどれだけ必要か」という**タスク側**の
  属性であり、「個々のEvidenceの信頼度」という**Evidence側**の属性
  （`Evidence.confidence`/`sourceType`、既存）とは概念が異なります。混同すると
  `Evidence`型の意味が曖昧になるため、別の型（`EvidenceMode`、タスク単位）
  として独立させました。
- **Citationを本文中に埋め込み文字列として生成させること**（例：Writerに
  `[出典: https://...]`を直接文中へ書かせる）：既存の`sections[].evidenceIds`
  という構造化された参照の仕組み（STEP66）をすでに持っているため、
  非構造化テキストへ後退させる理由がなく、16章では構造化Citation索引
  （`CitationIndex`）を提案しました。
