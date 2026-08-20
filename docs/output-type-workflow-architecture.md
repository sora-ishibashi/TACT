# Output Type / Workflow Architecture（調査・設計）

STEP73の成果物です。**コード変更は一切行っていません。** `core/conversation/`・
`core/workflow/`・`core/evidence/`・`core/agents/`・`core/prompt/`・`components/design/`・
`components/output/`・`app/design/page.tsx`・既存docs一式を実際に読み、STEP69〜72で
実装したEvidenceMode/QualityProfileの先に、「何を作るのか（Output Type）」がWorkflow・
最終成果物の形・TACT/TACT Designの分岐にどう接続すべきかを設計します。

`docs/dynamic-workflow-architecture.md`（STEP69、Adaptive Workflowの北極星設計）・
`docs/tact-v2-architecture.md`（10〜30 Agent・DAG化を見据えた長期設計）・
`docs/data-schemas.md`（スキーマ統一提案）とは前提として矛盾しないよう設計しています。
特にSTEP69の10章（QualityProfile初期案）・16章（Citation Architecture案）は、STEP71で
実装された部分とまだ未実装の部分を今回改めて仕分けします。

推測ではなく実コード上の事実だけを根拠にしています。事実（【既存】）と提案（【提案】）は
明確に分離しています。なお、依頼文中の`core/workflow/getTeam.ts`・
`core/workflow/evidenceMode.ts`というパスは実在せず、実際には`core/planner/getTeam.ts`・
`core/evidence/evidenceMode.ts`です（事実として報告するのみで、指摘は本旨ではありません）。

---

## 1. Executive Summary

STEP70〜72で、TACTは「Evidenceが必要か（EvidenceMode）」「どこまで品質保証するか
（QualityProfile）」という2軸を実装し、実LLM E2Eで機能することを検証済みです。しかし
**「何を作るのか（Output Type / 出力の形）」は、依然としてWorkflowの実行そのものには
一切接続されていません。**

調査の結果、TACTには既に**4つの独立した分類・調整機構**が存在することが判明しました。

| 機構 | 層 | 何を決めるか | Workflow実行への影響 |
|---|---|---|---|
| Task Reconstruction の `requestType` | Conversation | 依頼か質問か | question+成果物ありならAdvisorへ分岐（Workflow丸ごとskip） |
| Task Reconstruction の `artifactType` | Conversation | 成果物の型（report/comparison/proposal/presentation） | **Writerへのテキストスタイル指示のみ**。Agent構成・Critique/Revisionには無関係 |
| Task Reconstruction の `outputSpec`（STEP51/52） | Conversation | 出力の分量・配分 | **Writerへのテキスト指示のみ**。Agent構成には無関係 |
| Planner の `category`（STEP以前から） | Workflow | Agent構成の土台 | `getTeam(category)`でAgent配列を決定 |
| `evidenceMode`（STEP70） | Workflow | Evidenceが必要か | Researcher/QueryBuilder/Analystのteamからの除外 |
| `qualityProfile`（STEP71） | Workflow | 品質保証工程 | Critique/Revisionの実行可否 |

このうち上3つ（Conversation層）は**下3つ（Workflow層）に一切伝わっていません**。
`core/workflow/index.ts`・`core/workflow/handlePlanner.ts`をコード上で確認したところ、
`artifactType`・`requestType`・`conversationMode`という文字列は**1箇所も出現しません**
（`grep`で確認済み）。Conversation層が算出したこれらの値は、`composedTask`という
1本のテキスト文字列へ埋め込まれるだけで、Workflow層はそのテキストを読むだけです。

さらに、STEP70で実装した`evidenceMode`/STEP71の`qualityProfile`と、STEP51/52の
`outputSpec`も互いに独立しています。同じ「どれだけ丁寧に作るか」を決めたい2つの機構が、
別の層で、別の入力から、別々に計算されています。

**STEP73の結論**：新しい「Output Type」という巨大分類器を1つ追加するのではなく、
①既に存在する`artifactType`を「Document Format」として再定義・拡張し、②新たに
「Destination（TACT本体かTACT Designか）」という、現状どこにも存在しない軸だけを追加し、
③これらをWorkflow層（`evidenceMode`/`qualityProfile`と同じ場所）へ**決定論的に**渡す
経路を作ることを提案します。既存の4機構を作り直すのではなく、**Conversation層で
既に計算されている値をWorkflow層へ届けるだけ**で、多くの価値が得られます。

---

## 2. 現状の分類機構（実コードの事実）

### 2.1 Task Reconstruction（`core/conversation/reconstructTask.ts`）【既存】

Conversationの各Turnで**1回のLLM呼び出し**により、以下を算出します。

```ts
interface TaskReconstruction {
  task: string;                    // Plannerへ渡す自然文
  editIntent: string;              // add|modify|revert|new|clarify
  scope: "targeted" | "full";
  requestType: "task" | "question";
  artifactType: "report" | "comparison" | "proposal" | "presentation";
  conversationMode: "evidence" | "idea";
  // ...preserve/target/constraints等は章単位編集の保護用
}
```

- `requestType`：`question`かつ`conversation.currentOutput`が存在する場合のみ、
  `core/conversation/index.ts`が**Workflowを起動せずAdvisorへ委譲**します
  （唯一の既存「高速経路」、STEP69で確認済み）。
- `artifactType`：`composeTask()`内の`buildArtifactStyleGuidance()`が、
  comparison→Markdown表指示、proposal→企画書構成指示、presentation→スライド形式指示、
  という**テキストガイダンス**を`composedTask`へ追記するだけです。Writerの出力
  **スキーマ自体**（`outputFormats.ts`のwriterエントリ）は4種類とも同一です。
- `conversationMode`：`idea`の場合、`IDEA_MODE_MARKER`という固定文字列が
  `composedTask`へ埋め込まれ、`core/workflow/runAgent.ts`がWriter実行時にこの
  マーカーを検出してIdea Mode用の追加指示を差し込みます（STEP39）。STEP70の
  `detectEvidenceMode()`もこの同じマーカーを再利用しています（後述）。
- `artifactType`は`ARTIFACT_TYPE_SNAPSHOT_KEY`（`"__artifactType"`）として
  `run.outputs`へスナップショット保存され、次Turn以降の全面書き直し時に文脈が
  失われないよう復元されます（STEP36）。

**`TaskReconstructionResult`型は`artifactType`/`conversationMode`/`outputSpec`を
構造化した値としても返しますが**、コード内コメントが明記する通り「将来的な用途
（UI表示・ログ参照等）のため」であり、**Workflow自体はこれらのフィールドを直接
参照しません**（`composedTask`という文字列だけが`runWorkflow()`のuserInput引数として
渡ります）。

### 2.2 OutputSpec（`core/conversation/outputSpec.ts`、STEP51/52）【既存】

`artifactType × ユーザー明示指定 × mode`から、`detailLevel`（brief/standard/detailed/
deep）と各フィールド（executiveSummary/sections/keyFindings/recommendations/
nextActions）ごとの`allocation`（low/medium/high）を決定論的に計算し、`composedTask`へ
テキストガイダンスとして追記します。**これもテキストのみで、Agent構成には無関係**です。

### 2.3 Planner（`core/agents/planner.ts` → `core/workflow/handlePlanner.ts`）【既存】

Plannerは`category`（7値）・`difficulty`・`requiredCapabilities`・`plan[]`
（Agent別task文）を1回のLLM呼び出しで返しますが、`handlePlanner.ts`が実際に使うのは
`category`（→`getTeam(category)`）と`plan[].task`（テキストのみ）だけです
（STEP69で確認済み、今回`handlePlanner.ts`を再読して変化なしを確認）。

### 2.4 EvidenceMode / QualityProfile（`core/evidence/evidenceMode.ts`・
`core/workflow/qualityProfile.ts`、STEP70/71）【既存】

`handlePlanner.ts`が、`userInput`（`composedTask`の先頭段落）から**正規表現ベースで
決定論的に**算出します。新しいLLM呼び出しは追加していません。

```ts
type EvidenceMode = "none" | "helpful" | "required" | "primary-source-required";
type QualityProfile = "instant" | "standard" | "high" | "maximum";
```

`evidenceMode === "none"`のとき`researcher`/`queryBuilder`/`analyst`を`getTeam()`の
結果からteamレベルで除外し、`qualityProfile`が`QUALITY_PROFILE_CONFIG`経由で
Writer Critique（STEP67）/Writer Revision（STEP68）の実行可否を決めます。実LLM E2E
（STEP70〜72）でこの2軸が正しく機能することを検証済みです。

`detectEvidenceMode()`は`IDEA_MODE_MARKER`（2.1のconversationModeが埋め込む文字列）を
`userInput`から検出しています。つまり**部分的にはConversationMode由来の情報が既に
Workflow層へ漏れ伝わっています**（意図的な設計ではなく、テキストマーカーの
副次的な検出です）。

### 2.5 「Output Type」に相当する既存の型は存在するか

`AgentId`（`researcher`等9種）、`category`（7値）、`artifactType`（4値）、
`EvidenceMode`（4値）、`QualityProfile`（4値）はいずれも存在しますが、
**ユーザーが列挙した用途（キャプション生成・SNS投稿・メール・要約・リライト・校正・
壁打ち・お悩み相談等）を表現できる分類は、現状どこにも存在しません**。最も近いのは
`artifactType`ですが、4値とも「ある程度まとまった分量の文書」を想定した値であり、
「Instagram用キャプションを3案」のような超軽量な出力は`report`にfallbackするしか
ありません（`buildArtifactStyleGuidance()`のswitch文の`default`ケース）。

---

## 3. 現状の問題点

### 3.1 4つの分類機構が相互に不接続【既存事実からの分析】

2章の通り、Conversation層（requestType/artifactType/conversationMode/outputSpec）と
Workflow層（category/evidenceMode/qualityProfile）は、テキスト埋め込み（`composedTask`）
という1本の細い糸でしか繋がっていません。これにより：

- `artifactType: "presentation"`と判定されていても、Workflow側はそれを知らず、
  通常の`category`ベースのAgent選定・`evidenceMode`判定を独立に行います。
- `outputSpec.detailLevel: "brief"`（簡潔に）と決まっていても、`qualityProfile`は
  別の正規表現で独立に判定するため、両者が矛盾した結論（例：outputSpecは簡潔指示、
  qualityProfileはhigh＝Critique+Revision実行）になり得ます。
- 逆に、`qualityProfile: instant`（超高速）と判定されても、`outputSpec`側はそれを
  知らないため、`detailLevel`の既定値（`standard`）のままWriterへ「十分な説明を」
  という指示が飛ぶ可能性があります。

これは実害が確認されたバグではなく、**「同じ意図を持つはずの2つの調整軸が、
別々の入力・別々のタイミングで、別々の結論を出し得る」という構造的リスク**です。

### 3.2 Writerの出力スキーマは1種類しかない【既存事実】

`outputFormats.ts`のwriterエントリは、`category`にも`artifactType`にも`evidenceMode`
にも`qualityProfile`にも関わらず**常に同一**です（title/executiveSummary/sections[]/
keyFindings[]/recommendations[]/nextActions[]/status/confidence/confidenceReason/
limitations[]/suggestedTasks[]）。STEP70〜72で「不要なAgentを呼ばない」ことには
成功しましたが、**「Writerが最終的に返すJSONの形」は依然として一種類のまま**です。
「Instagram用キャプション3案」のような依頼でも、Writerは（省略されるとはいえ）
`keyFindings`・`recommendations`・`nextActions`という項目名を意識したJSONを組み立てる
必要があります。これはSTEP70〜72が最適化した「どのAgentを呼ぶか」の一段上にある、
**「Writerが何を返すべきか」という、まだ手つかずの問題**です。

### 3.3 TACT DesignはWorkflowと一切接続されていない【既存事実、STEP69で確認済み・
再確認】

`app/design/page.tsx`は`SAMPLE_CURRENT_OUTPUT`というハードコードされたローカル定数を
使用（コード内コメントで「将来的な差し込み口」と明記）。`components/design/
currentOutputToDocumentModel.ts`は`evidenceIds`/`evidence`を一切参照しません
（`grep`で確認）。`components/design/mockDesignAgent.ts`（1047行）・`AIPanel.tsx`・
`DocumentRenderer.tsx`はいずれも`runLLM`/`fetch`/`OpenAI`への参照が0件で、実際のLLM
呼び出しを一切含みません。**「TACT本体からTACT Designへ何を・どう渡すか」という
経路そのものが、データもロジックも今回改めて確認する限り存在しません。**

### 3.4 Citation UXの土台はあるが、どの表示層にも実装されていない【既存事実、
STEP69で確認済み・再確認】

`components/output/FinalOutput.tsx`（TACT本体の表示、336行）を全文確認した結果、
`title`/`executiveSummary`/`keyFindings`/`sections[].heading,content,points`/
`recommendations`/`nextActions`のみをレンダリングし、`evidenceIds`/`source`/
`confidence`への参照は0件です。`components/output/formatOutputText.ts`は
「evidenceIds等の内部管理情報はユーザー向けコピー結果に含めない」と明記して
意図的に除外しています。TACT Design側（3.3）も同様にゼロです。**Evidence追跡性
（STEP66）はWriterのJSON内部に存在するだけで、どの画面にも一度も表示されない
状態が、TACT本体・TACT Designの両方で続いています。**

### 3.5 `docs/data-schemas.md`の提案は一部STEP65〜68以降の変更に追いついていない
【既存事実】

`docs/data-schemas.md`の`AnalysisInsight`型は`{title, importance, reason,
evidenceIds}`のみで、STEP65で判明・STEP66で追加された`background`/
`causeAndEffect`/`counterArguments`を含みません。`WriterOutput`/`WriterSection`
（`evidenceIds?: string[]`）はSTEP66の実装と一致しています。事実としての指摘に
留め、`docs/data-schemas.md`自体の修正はSTEP73の範囲外とします。

---

## 4. Output Typeの定義【提案】

### 4.1 「Output Type」を単一の分類にしない

STEP73の依頼文が挙げた用途（専門的レポート、市場調査、論文、壁打ち、お悩み相談、
アイデア出し、キャプション、SNS投稿、メール、要約、リライト、校正、プレゼン資料、
TACT Design向け情報生成）を1つのenumで表現しようとすると、以下の3つの異なる関心事が
混ざります。

1. **「どれだけの分量・構造を持つ成果物か」**（既に`artifactType`が担っている軸）
2. **「Evidenceがどれだけ要るか」「どれだけ品質保証するか」**（既にEvidenceMode/
   QualityProfileが担っている軸、STEP70〜72で実装・検証済み）
3. **「最終的にどこへ渡すか」**（TACT本体で完結 or TACT Designへ、現状どこにも
   存在しない軸）

したがって、**新しい1つの「Output Type」型を作るのではなく、既存の`artifactType`を
「Document Format」として再定義・値を拡張し、新たに「Destination」という軸だけを
追加する**ことを提案します。

### 4.2 Document Format（＝拡張された`artifactType`）【提案】

```ts
type DocumentFormat =
  | "report"          // 既存。通常の調査レポート
  | "comparison"       // 既存。複数対象の比較
  | "proposal"         // 既存。企画書・提案書
  | "presentation"      // 既存。プレゼン資料構成
  | "academic"          // 新規。論文・学術リサーチ（4.3で詳述）
  | "micro"             // 新規。キャプション/SNS投稿/メール/短文要約等、
                         //         構造化されたsections[]を必要としない軽量出力
  | "conversation";     // 新規。壁打ち・お悩み相談・アイデア出し等、
                         //         「成果物」ではなく「応答」が主目的
```

- `report`/`comparison`/`proposal`/`presentation`は**無変更**（既存の
  `buildArtifactStyleGuidance()`・`outputSpec.ts`のロジックをそのまま使う）。
- `academic`は「maximum QualityProfile」との組み合わせが前提となる新値です
  （4.3参照）。
- `micro`/`conversation`は、**Writerの出力スキーマを軽量化する将来の拡張の
  トリガー**として位置づけます（3.2の問題への対応）。STEP73では設計のみとし、
  実際にWriterのJSON構造を分岐させる実装は行いません（12章のロードマップへ送る）。

### 4.3 Destination（新規軸）【提案】

```ts
type Destination = "tact" | "design";
```

現状どのコードにも存在しない、純粋に新しい概念です。判定方法は7章で検討します。

---

## 5. Output Type別Workflow比較

STEP69の調査・STEP70〜72の実装を踏まえた比較表です。「Evidence要件」
「Analyst要件」等の列は、既存のEvidenceMode/QualityProfileの語彙をそのまま使います
（新しい判定軸を作らない）。

| # | 用途 | EvidenceMode | Researcher | Analyst | Stakeholder | Designer(Agent) | QualityProfile | Critique | Revision | DocumentFormat | Destination |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | キャプション生成 | none | 不要 | 不要 | 不要 | 不要 | instant | 不要 | 不要 | micro | tact |
| B | リライト | none | 不要 | 不要 | 不要 | 不要 | instant | 不要 | 不要 | micro | tact |
| C | 壁打ち | none | 不要 | 不要 | 状況次第 | 不要 | standard | 実行 | 不要 | conversation | tact |
| D | お悩み相談 | none/helpful | 不要 | 不要 | 状況次第 | 不要 | standard | 実行 | 不要 | conversation | tact |
| E | 市場調査 | required | 必要 | 必要 | 状況次第 | 不要 | high | 実行 | 実行 | report | tact |
| F | 専門的レポート | required〜primary | 必要 | 必要 | 状況次第 | 不要 | high〜maximum | 実行 | 実行 | report | tact |
| G | 論文・学術リサーチ | primary-source-required | 必要 | 必要 | 不要 | 不要 | maximum | 実行 | 実行 | academic | tact |
| H | TACT Design向け情報生成 | 依頼内容次第（不変） | 依頼内容次第 | 依頼内容次第 | 依頼内容次第 | 状況次第 | 依頼内容次第 | 依頼内容次第 | 依頼内容次第 | 依頼内容次第 | **design** |

**重要な観察**：A〜Gの縦の列（EvidenceMode/Analyst/QualityProfile/Critique/Revision）
は、STEP70〜72で**既に実装・実LLM検証済みの組み合わせと一致します**（STEP71/72の
E2Eで、C相当の壁打ちケースがstandard+Critique実行+Revision不実行になることを実測
確認済み、E/F/G相当の調査系がrequired/primary-source-required+high/maximumになる
ことも実測確認済み）。つまり**Output Type（用途）が違っても、EvidenceMode×
QualityProfileという2軸の組み合わせとしては既に表現できているケースが大半**です。

**Hだけが質的に異なります。** HはEvidenceMode/QualityProfileの値に関わらず
成立し得る（一次情報を使った企業調査資料をDesignへ渡すことも、既存文章を
スライド構成に直すだけの依頼をDesignへ渡すこともあり得る）**独立した軸**です。
これは4.3のDestinationが「他の軸と直交する」という設計判断の裏付けになります。

---

## 6. EvidenceModeとの関係

EvidenceModeは「Evidenceが必要か」だけを判定しており、Output Type（Document
Format）とは意味的に独立です。5章の表が示す通り、同じDocumentFormat
（例：`report`）でも、ユーザー提供情報だけで完結する依頼（EvidenceMode: none）と
外部調査が要る依頼（EvidenceMode: required）の両方が有り得ます。**この独立性は
既にSTEP71で「Evidence不要=品質チェック不要にしない」という設計判断として
明文化・実装済みであり、Output Typeについても同じ独立性を維持すべき**という
結論です（DocumentFormatがEvidenceModeを決め打ちしない）。

一方、`DocumentFormat: "academic"`だけは例外的にEvidenceModeの下限
（`primary-source-required`推奨）と強く相関します。これは「べき論」であって
「強制」ではないため、7章で判定方法を検討します。

---

## 7. QualityProfileとの関係

同様にQualityProfileも独立軸ですが、5章の表の通り、`micro`/`conversation`は
`instant`/`standard`と、`academic`は`maximum`と強い相関を持ちます。ここで
判断すべきは「DocumentFormatがQualityProfileを直接決定してよいか、それとも
現行通りEvidenceMode/QualityProfileは`userInput`から独立に決定論的に判定される
べきか」です。

**【提案】DocumentFormat/Destinationは、EvidenceMode/QualityProfileの判定に
「入力の一部」として渡すが、上書きはしない。**

現状の`detectQualityProfile(userInput, evidenceMode)`のシグネチャに、第3引数として
`documentFormat`（オプショナル）を追加できる余地はありますが、STEP70/71で確立した
「決定論的パターンマッチングによる安全側デフォルト」という設計思想を壊さないため、
DocumentFormatは**追加のシグナルの1つ**として扱い、既存の`RIGOR_SIGNAL_PATTERNS`
等と同列に軽く影響させる程度に留めるべきです（例：`documentFormat === "academic"`
なら`RIGOR_SIGNAL_PATTERNS`と同じ扱いで`maximum`側へ倒す、程度）。**DocumentFormatが
QualityProfileを強制的に上書きする設計にはしない**ことを推奨します。理由：
ユーザーが「論文っぽいタイトルだけ考えて」のように、DocumentFormat的には
`academic`寄りでもQualityProfile的には`instant`が適切なケースが有り得るためです
（2軸の独立性を壊さない）。

---

## 8. TACT / TACT Designの境界【提案】

### 8.1 現状（3.3の再掲）

接続点はゼロ。`SAMPLE_CURRENT_OUTPUT`（ハードコード）と`mockDesignAgent.ts`
（ルールベース、LLM不使用）だけで動くプロトタイプです。

### 8.2 提案：中間形式としての「編集可能な情報構造」

ユーザー提示の構造（Title/Summary/Sections/Claims/Evidence/Evidence IDs/Primary
Sources/Key Findings/Recommendations/Counterarguments/Conclusion）を検討した結果、
**このほぼ全てが既にTACT側のデータ構造として実在する**ことを確認しました。

| ユーザーが挙げた要素 | 既存の対応物 | 状態 |
|---|---|---|
| Title | `WriterOutput.title` | 実装済み |
| Summary | `WriterOutput.executiveSummary` | 実装済み |
| Sections | `WriterOutput.sections[]` | 実装済み |
| Claims | `AnalystOutput.insights[]`（STEP65で「実質Claim構造」と確認済み） | 実装済み（Analystのみ、Writerには非構造化のまま） |
| Evidence | `WorkflowContext.evidence[]`（`Evidence`型） | 実装済み |
| Evidence IDs | `sections[].evidenceIds` / `insights[].evidenceIds` | 実装済み（STEP66で機械検証済み） |
| Primary Sources | `Evidence.sourceType`（official/government/paper等） | 実装済み |
| Key Findings | `WriterOutput.keyFindings[]` | 実装済み |
| Recommendations | `WriterOutput.recommendations[]` | 実装済み |
| Counterarguments | `AnalystOutput.insights[].counterArguments`（STEP66） | 実装済み（Analystのみ） |
| Conclusion | 明示的な単一フィールドは無い（`executiveSummary`または`sections[]`末尾に混在） | **未実装** |

つまり、「TACT DesignへEvidence追跡性を保ったまま渡す」ために**新しく作るべき
データはほとんどありません**。必要なのは、①これらを1つの受け渡し用構造として
まとめるAdapter（STEP69の16章で既に提案済みの`adaptWriterOutputToDocumentModel()`
と同義）と、②`Conclusion`という現状抜け落ちているフィールドの追加検討だけです。

### 8.3 TACT本体で完結する場合とDesignへ渡す場合の違い

```
TACT本体で完結:
  Evidence → Analysis(Claim/Reasoning/Counterargument) → Writer(文章化) → Critique → Revision
  → WriterOutput(自然文中心のJSON) → components/output/FinalOutput.tsx でそのまま表示

TACT Designへ渡す場合:
  Evidence → Analysis(Claim/Reasoning/Counterargument) → Writer(文章化) → Critique → Revision
  → WriterOutput → [新設Adapter] → DocumentModel + Citation拡張
  → components/design/DocumentRenderer.tsx で編集可能な形として表示
```

**重要な設計判断**：「Writerが構造化情報から直接Design用の構造を作る」のではなく、
**既存のWriterOutput（自然文中心）を土台に、Adapterが変換する**構成を推奨します。
理由：Writerのsystemプロンプト・出力スキーマ（3.2で指摘した「1種類のみ」問題は
別課題として12章のロードマップへ送る）を今回変更する必要がなく、STEP66〜68で
築いたEvidence追跡性・Critique/Revisionの仕組みをそのまま両方の出力先で使い回せる
ためです。

---

## 9. Citation / Evidence Data Model【提案】

STEP69の16章で提案した`Citation`/`CitationIndex`案を、STEP66〜72の実装状況を
踏まえて再確認・具体化します。

### 9.1 既存の材料（再掲・確認済み）

`Evidence.id`/`Evidence.source`/`Evidence.sourceType`/`Evidence.confidence`
（`core/context/types.ts`）、`sections[].evidenceIds`（STEP66で実装、
`validateEvidenceIds()`で実在性を機械検証済み）。すべて実装済みです。

### 9.2 新設が必要なもの（最小限）

```ts
// 新設が必要な、唯一の薄い型（純粋なマッピングであり、Evidence型自体は変更しない）
interface Citation {
  evidenceId: string;       // 既存 Evidence.id への参照
  label: string;            // 表示用の短いラベル（例: "[1]"）
  source?: string;          // Evidence.source の複製（表示層の利便性のため）
  sourceType?: Evidence["sourceType"];
  isPrimarySource?: boolean;
}

// sections[index] ごとのCitation一覧を持つ索引。本文テキスト自体は変更しない。
type CitationIndex = Record<number, Citation[]>;
```

`buildCitationIndex(writerOutput, evidencePool): CitationIndex`という**純粋関数**
（`validateEvidenceIds()`と同じ設計思想：入力を書き換えない）を新設すれば、
既存の`sections[].evidenceIds`と`context.evidence`だけから機械的に導出できます。
**新しいEvidence管理システムは不要**であり、この結論はSTEP69から変わりません。

### 9.3 「小さなCitation表示→クリックで展開」という要求への対応

ユーザーが説明したUX（本文中はコンパクト表示、クリックで一次情報一覧を展開）は、
**Presentation Layerの実装課題であり、今回は着手しません**（指示通り）。ただし
Data Model側で今回明確にすべきは、「`CitationIndex`さえあれば、TACT本体の
`FinalOutput.tsx`とTACT Designの`DocumentRenderer.tsx`の両方が、同じ1つの索引を
参照するだけで済む」という設計です。8.3のAdapterが`WriterOutput` +
`CitationIndex`を渡せば、レンダラー側の実装だけが異なり、**Citationのデータ源は
1箇所（Workflow層で計算した`CitationIndex`）に統一できます**。

---

## 10. Plannerとの責務分担【提案】

STEP69で指摘した「Plannerの出力にはより豊かな判断（`plan[]`・`difficulty`・
`requiredCapabilities`）が既に含まれているのに、`handlePlanner.ts`は`category`しか
使わない」という状態は、STEP73時点でも変わっていません（2.3で再確認済み）。

STEP73の問い「Plannerが毎回自由にAgentを選ぶべきか、それとも分類器がWorkflow Specを
作りPlannerは不足部分だけ補完すべきか」について、STEP70〜72の実証結果を根拠に
以下のように判断します。

**【結論】分類器（決定論的パターンマッチング）が主導し、Plannerの自由裁量は
`category`・`plan[].task`（テキスト）という現状の役割に限定し続けるべきです。**

根拠：

1. **コスト**：EvidenceMode/QualityProfileの判定に新しいLLM呼び出しを追加しなかった
   ことで、STEP70のE2Eでは「none」判定タスクにおいてLLM呼び出し回数が
   `queryBuilder`/`researcher`/（`analyst`）分だけ確実に削減されました。もし
   Plannerに「Evidenceが要るか」まで自由判断させていた場合、判断自体はLLM 1回の
   中に含まれるため追加コストはありませんが、**判断のブレ**（同じような依頼でも
   実行のたびに違うAgent構成になるリスク）が生じます。
2. **誤分類リスク**：STEP70の静的テスト・実LLM E2Eで、`detectEvidenceMode()`の
   決定論的パターンは「判定に迷う場合は安全側（Researcherを維持する`helpful`）に
   倒す」という設計により、実測で期待通りの分岐を達成しました。LLM
   （Planner）に同じ判断をさせた場合、**プロンプトの微妙な言い回し変化・
   モデルの気まぐれで結果が変わるリスク**があり、実際にSTEP65で「Plannerの
   `category`判定自体は毎回安定しているが、`plan[]`のAgent選択は使われていない
   （信頼されていない）」という既存の設計判断（推測：ハルシネーション対策）が
   観察されています（STEP69で明記した推測、今回も同じ推測を維持）。
3. **既に確立した成功パターンの一貫性**：STEP70〜72で「Plannerの自由な選択には
   頼らず、`category`という粗い出力だけをPlannerに任せ、その先の細かい調整
   （Evidence要否・品質保証レベル）は決定論的関数が行う」という分業が実証された
   ため、Output Type（DocumentFormat/Destination）についても**同じ分業パターンを
   踏襲する**のが最も一貫性があります。

**Plannerの役割の再定義（提案）**：

```
Planner（LLM、1回）:
  - goal（目的の要約）
  - category（Agent構成の粗い土台、現状のまま）
  - plan[]（Agent別task文、現状のまま）
  - difficulty/requiredCapabilities（現状通り、将来の拡張余地として保持するが
    今回は使わない）

決定論的関数（Workflow層、LLM呼び出しなし）:
  - evidenceMode（既存、STEP70）
  - qualityProfile（既存、STEP71）
  - documentFormat（新規提案。ただしまず既存artifactTypeをWorkflow層へ
    伝播させるだけで多くが解決する。7章参照）
  - destination（新規提案）
```

Plannerに「不足部分だけ補完させる」設計（ユーザー提示の第2案）は、将来
Agent数が増え、決定論的パターンでは表現しきれない微妙な判断が必要になった
段階で検討する価値がありますが、**STEP73時点では時期尚早**と判断します
（現状の決定論的アプローチがまだ限界に達していないため）。

---

## 11. Dynamic Workflowへの接続案【提案】

### 11.1 DocumentFormat/Destinationの判定方法

STEP69・本ドキュメント7章の議論を踏まえ、以下を提案します。

**DocumentFormat**：新しいLLM分類は追加せず、2つの経路を検討します。

- **経路A（推奨）**：`core/conversation/reconstructTask.ts`が既に算出している
  `artifactType`を、Workflow層（`runWorkflow()`の引数）へ**構造的に渡す**。
  現状`composedTask`という1本の文字列に埋め込まれているだけなので、
  `runWorkflow(workflow, userInput, mode, onEvent, currentOutput, seedEvidence,
  artifactType?)`のように**引数を1つ追加する**だけで実現できます（`artifactType`
  自体の判定ロジックには一切触れない）。ただし2.1で確認した通り、
  `app/api/tact/route.ts`等、Conversation層を経由せず`runWorkflow()`を直接呼ぶ
  経路が存在するため、この引数は必ずoptionalにし、未指定時は
  `detectEvidenceMode()`と同様に`userInput`からの決定論的パターンマッチングへ
  フォールバックする設計にする必要があります。
- **経路B**：`detectEvidenceMode()`/`detectQualityProfile()`と全く同じパターンで、
  `detectDocumentFormat(userInput): DocumentFormat`を新設し、`userInput`
  （`composedTask`の先頭段落）から独立に決定論的推定する。Conversation層の
  `artifactType`とは別の判定になるため、**2つの判定がズレるリスク**を新たに
  抱えます（3.1で指摘した問題を悪化させる）。

**→ 経路Aを推奨**：STEP69で発見した「既存分類が乱立し互いに接続されていない」
という問題そのものを繰り返さないためには、**既にConversation層で計算済みの
`artifactType`をWorkflow層へ届けること**が最優先であり、Workflow層で同じ判断を
再度独自に行う経路Bは避けるべきです。

**Destination**：現状どこにも判定ロジックが存在しないため、新設が必要です。
決定論的パターン（例：「プレゼン資料」「スライド」「Designで編集」等の
キーワード）と、`artifactType === "presentation"`をデフォルトの強いヒントとして
使う、`detectEvidenceMode()`と同型の`detectDestination(userInput, artifactType):
Destination`を新設することを提案します（新しいLLM呼び出しは不要）。

### 11.2 概念モデルの評価

ユーザーが提示した仮説

```
Intent / Output Type / Evidence Mode / Quality Profile / Conversation Mode
  ↓
Workflow Specification
  ↓
必要なAgent / 順序 / Tool / Critique / Revision / Output Schema
```

は、**「複数の軸が合流してWorkflowの実行内容を決める」という構造としては正しい**
ですが、実コードの現状に照らすと以下の修正が必要です。

- `Intent`は`requestType`（既存）とほぼ同義であり、新設不要。
- `ConversationMode`は既にIDEA_MODE_MARKERとしてWorkflow層へ一部伝播しています
  （2.4）。独立した新しい合流点として扱うのではなく、「evidenceModeの`none`判定に
  既に部分的に寄与している既存シグナル」として扱うのが実態に近いです。
- `Output Type`は4章の通り、`DocumentFormat`と`Destination`の2軸に分解すべきです。
- 「Workflow Specification」という単一の合流点は、12章で検討する通り、
  **新しい永続的な型として作るのではなく、既存フィールド（evidenceMode/
  qualityProfile/documentFormat/destination）を実行時に参照する形で十分**です。

---

## 12. Workflow Specification案【提案、ただし新規型は最小限】

### 12.1 本当に新しい型が必要か

ユーザー提示の案：

```ts
type WorkflowSpec = {
  outputType: ...;
  evidenceMode: ...;
  qualityProfile: ...;
  requiredAgents: ...;
  allowsCritique: ...;
  allowsRevision: ...;
  destination: ...;
}
```

各フィールドを既存コードと照合すると：

| フィールド | 既存の対応物 | 新規性 |
|---|---|---|
| `evidenceMode` | `context.evidenceMode`（STEP70） | 既存、そのまま参照可能 |
| `qualityProfile` | `context.qualityProfile`（STEP71） | 既存、そのまま参照可能 |
| `allowsCritique`/`allowsRevision` | `QUALITY_PROFILE_CONFIG[qualityProfile]`（STEP71） | 既存、`qualityProfile`から導出可能（別途保持は冗長） |
| `requiredAgents` | `dynamicPlan.map(s => s.agent)` | 既存、`dynamicPlan`から導出可能（別途保持は冗長） |
| `outputType`/`destination` | なし | **新規** |

**結論**：新規性があるのは`documentFormat`（≒outputType）と`destination`だけです。
残りは全て既存フィールドの複製になってしまうため、**`WorkflowSpec`を
`WorkflowContext`に永続保存する新しいstateとしては作らない**ことを提案します。

### 12.2 代替案：ログ・観測用の「計算済みビュー」としてのみ提供

```ts
// 新しいcontext fieldではなく、必要なときに既存contextから導出する
// 純粋関数(STEP71のexecutionRecord同様、記録・観測専用)
function summarizeWorkflowSpec(context: WorkflowContext): {
  documentFormat?: DocumentFormat;
  destination?: Destination;
  evidenceMode?: EvidenceMode;
  qualityProfile?: QualityProfile;
  allowsCritique: boolean;
  allowsRevision: boolean;
  requiredAgents: string[];
} {
  // context.evidenceMode / context.qualityProfile / context.documentFormat /
  // context.destination（12.1で新設が必要な2つ）と、
  // QUALITY_PROFILE_CONFIG・dynamicPlanから導出するだけ
}
```

こうすることで、STEP71の`executionRecord.critiqueExecuted`/`revisionExecuted`と
同じ「既存構造から導出する記録専用の値」という設計原則を`documentFormat`/
`destination`にも適用でき、`context`へ保存する新規フィールドは
`documentFormat`/`destination`の2つだけに抑えられます。

---

## 13. 実装ロードマップ【提案、優先順位付き】

すべて**既存の`getTeam()`/Planner本体/Writer・Reviewer systemPrompt/UIには
触れない**という、STEP70〜72で維持してきた制約を引き継ぎます。

| Phase | 内容 | 新規LLM呼び出し | 破壊的変更 |
|---|---|---|---|
| **P1** | `runWorkflow()`へ`artifactType`（optional引数）を追加し、未指定時のみ
  決定論的フォールバックする。`context.documentFormat`として保持するだけ
  （Workflow分岐にはまだ使わない） | なし | なし（追加的） |
| **P2** | `detectDestination(userInput, artifactType)`を新設し、
  `context.destination`として保持する（Workflow分岐にはまだ使わない） | なし | なし（追加的） |
| **P3** | `buildCitationIndex(writerOutput, evidencePool)`を純粋関数として実装し、
  ログ用途にのみ使う（9.2） | なし | なし（追加的） |
| **P4** | `detectQualityProfile()`へ`documentFormat`を弱いシグナルとして接続する
  （7章、`academic`→maximum寄り等） | なし | 小（既存の判定結果が一部変わり得る） |
| **P5** | `documentFormat === "micro"`/`"conversation"`の場合に限り、Writerへの
  出力スキーマ簡略化を検討する（3.2の解消。Presentation Layer・
  outputFormats.tsへの変更を伴うため、別STEPでの慎重な設計が必要） | なし | 中〜大 |
| **P6** | TACT Design Adapter（`adaptWriterOutputToDocumentModel()`拡張版、
  `Citation`型接続）の実装 | なし | なし（TACT Design側は新規追加のみ） |
| **P7** | `app/design/page.tsx`の`SAMPLE_CURRENT_OUTPUT`を実データに接続 | なし
  （既存Workflow結果を渡すだけ） | 中（API設計が必要） |

P1〜P3は「既存構造を壊さず設計検証のために必要な最小限の変更」に該当し得ますが、
**STEP73では実装しません**（次章参照）。

---

## 14. 今回実装しないもの

指示通り、以下はすべて未実装のままです。

- `DocumentFormat`/`Destination`型の新規作成（コード上には未反映、本ドキュメントの
  提案のみ）
- `runWorkflow()`の引数追加
- `detectDestination()`・`buildCitationIndex()`の実装
- Writerの出力スキーマ分岐
- TACT Design Adapter・Citation UI
- Planner・`getTeam()`・Reviewer・Writer systemPromptの変更
- 既存`requestType`/`artifactType`/`category`の統合・置き換え

**本STEPで行ったコード変更はありません。**（ファイル変更0件）

---

## 15. 未解決事項

- `DocumentFormat: "micro"`/`"conversation"`が実際にWriterの出力スキーマへどう
  反映されるべきかの詳細設計（P5）は今回行っていません。`sections[]`を完全に
  廃止するのか、単に空配列を許容するだけで十分なのかは実装時に要検証。
- `Destination`の判定精度（キーワードベースでどこまで正確に「Designへ渡すべきか」を
  当てられるか）は、実データが無いため未検証です。
- `Conclusion`フィールド（8.2で「未実装」と指摘）をAnalyst/Writerのどちらに
  持たせるべきかは今回結論を出していません。
- P4（DocumentFormatをQualityProfile判定へ接続する）の具体的な重み付け
  （`RIGOR_SIGNAL_PATTERNS`と同列に扱ってよいか、もっと弱い影響に留めるべきか）は
  実運用データを見てから調整が必要です。
- TACT Designの認証・永続化・API設計（P7）は本ドキュメントのスコープ外です。

---

## 16. STEP74への提案

### 今すぐ実装すべきもの
1. **P1: `artifactType`をWorkflow層へ伝播させる引数追加**。新しいLLM呼び出しなし、
   既存の`optional`引数追加のみで、3.1で指摘した「Conversation層とWorkflow層の
   分断」を最小コストで一部解消できる。
2. **P2: `Destination`判定の新設**（`context.destination`への保存のみ、Workflow
   分岐にはまだ使わない）。TACT Design接続（P6/P7）に着手する前提条件として
   最初に固めておくべき。

### 設計だけ固めるもの
3. **P5: Writer出力スキーマの`micro`/`conversation`分岐**。Presentation Layer
   （`outputFormats.ts`・`FinalOutput.tsx`）への影響があるため、実装前に
   具体的なJSON形状・後方互換性（既存の`sections[]`前提コードへの影響）を
   個別STEPで設計すべき。
4. **P6: TACT Design Adapter + Citation型**。8.3・9章で設計方針は固まったが、
   実際のフィールドマッピング（`insights[]`→`Claims`、`Conclusion`の扱い含む）は
   実装時に詳細化が必要。

### 実運用データを見てから決めるもの
5. **P4: DocumentFormatのQualityProfile判定への接続度合い**。過度に強く
   接続すると7章で懸念した「2軸の独立性」が崩れるため、まず`documentFormat`を
   ログ専用（P1/P2）として運用し、実際の判定結果とユーザーの反応を見てから
   接続の強さを決めるべき。
6. **P7: TACT Designの実データ接続**。API設計・認証を伴う大きな変更であり、
   P1〜P6の設計が実運用で安定してから着手すべき。
