# Writing Quality Architecture（調査・設計）

STEP65の成果物です。**コード変更は一切行っていません。** `core/agent/`・`core/agents/`・
`core/brain/`・`core/optimizer/`・`core/evidence/`・`core/workflow/`・`core/prompt/`・
`core/conversation/`・`core/context/types.ts`を実際に読み、TACTの現在の文章生成能力を
「論文レベル」の定義（主張の明確さ・根拠・推論の明示・事実と解釈の区別・反証と限界・
重複の少なさ・論理飛躍の少なさ）に照らして評価し、最小実装案と理想構成を示します。

`docs/tact-v2-architecture.md`（Orchestrator/DAG/Registry寄りの長期設計）・
`docs/data-schemas.md`（Agent間JSONスキーマの統一）とは軸が異なります。本ドキュメントは
「TACTが生成する**文章そのものの論理品質**」だけを対象とします。ただし、両ドキュメントで
判明している構造（`Evidence`/`EvidenceItem`/`SharedEvidence`/`ImprovementNote`等）は
そのまま前提として引き継ぎます。

---

## 0. 調査対象と方法

実際に読んだファイル：`core/agent/*`, `core/agents/*.ts`（9Agent全て）, `core/brain/*`,
`core/optimizer/*`, `core/evidence/*.ts`（10ファイル全て）, `core/workflow/runAgent.ts`,
`core/workflow/handleReviewer.ts`, `core/workflow/defaultWorkflow.ts`,
`core/planner/getTeam.ts`, `core/prompt/outputFormats.ts`, `core/context/types.ts`,
`core/conversation/mergeWriterOutput.ts`, `docs/data-schemas.md`, `docs/tact-v2-architecture.md`。

推測ではなく、実際のコード上の事実だけを根拠にしています（行番号は調査時点のものです）。

---

## 1. 現在のパイプラインの実際の姿

### 1.1 Agentの並び順は固定、チーム構成はcategoryで決め打ち

`core/planner/getTeam.ts`は、Plannerが出力した`category`（`coding`/`planning`/`design`/
`business`/`writing`/`research`/default）を見て、**あらかじめハードコードされたAgent配列**を
返すだけです。Plannerが「Reasoningまで踏み込むかどうか」を判断している訳ではありません。

重要な事実：**`writing`カテゴリとdefaultカテゴリには`analyst`が含まれません**
（`queryBuilder → researcher → reviewer → writer`のみ）。「レポートを書いて」のような
一般的な文章生成依頼が`writing`または`research`以外に分類された場合、TACTで唯一
Claim/Reasoning/Evidence対応付けの構造を持つAnalystが**丸ごとスキップされ**、
Writerが生Evidenceから直接プレーンテキストを一発生成する経路になります。

### 1.2 Reviewerは常にWriterの手前で1回だけ動く。Writerの後には誰もいない

`core/workflow/defaultWorkflow.ts`の順序、および`core/agents/reviewer.ts`本文の
「指定してはいけないAgent: planner / reviewer / writer」という明示的な禁止から、
現在のReviewerは**Researcher/Analyst/Designer/Engineer/Stakeholderの成果物だけを見て
Writerの手前で承認・差し戻しを判断する役**であり、**Writerが実際に生成した最終文章そのものを
読んで批評する仕組みは存在しません**。`core/workflow/handleReviewer.ts`の差し戻し先も
`retryAgents`（Researcher等）かフォールバックの`researcher`だけで、Writerへの差し戻し経路は
コード上そもそも存在しません。

これは「ReviewerがWriterの文章を採点するだけなのか、具体的な修正指示を返すのか」という
調査項目7への直接の答えです：**現状はそのどちらでもなく、ReviewerはWriterの文章を一度も
見ません**。「文章批評→修正」ループは、現在ゼロから追加する必要があります。

### 1.3 Evidenceの実体

`core/context/types.ts`の`Evidence`型は、`docs/data-schemas.md`が提案した`SharedEvidence`に
近い形（`id, claim, evidence(自由記述), source?, confidence(low/medium/high), score,
sourceType?, hash?, createdBy, createdAt, tags, references?`）まで**既に実装されています**。
`docs/data-schemas.md`が指摘した「Researcherの`claim`が常に`"Unknown"`になる」バグは、
`core/evidence/normalizeResearcherEvidence.ts`の`toClaim()`が`record.claim ?? record.name ??
record.topic ?? ... ?? record.headline`という多段フォールバックに拡張されており、
`core/prompt/outputFormats.ts`のResearcherエントリ（`{claim, evidence, source, confidence,
reason}`、L39-108）とキー名が一致するため、**実測形とコードの間のズレはPhase 1相当の分だけ
解消されています**。

ただし、**`core/agents/researcher.ts`のsystemPrompt自体は今も3つの異なる出力形を
自己矛盾したまま同居させています**：
1. 本文中盤の巨大な`Output`例（L778-873）：`market: [{topic, facts, sources, confidence}]`等、
   カテゴリごとに異なるキー名を要求
2. 本文終盤の`Evidence Format`セクション（L879-912）：`{title, fact, source, confidence,
   relevance}`という別の平坦な形
3. プロンプト末尾に実際に付与される`core/prompt/outputFormats.ts`のResearcherエントリ：
   `{claim, evidence, source, confidence, reason}`（カテゴリ別Record、キー名は③のみ`toClaim`と
   一致）

3のみが`toClaim`/`toSource`と一致するため実害は限定的ですが、**LLMへ矛盾した指示が3種類
同時に渡っている**という事実自体は、Evidenceの形がターンごとにブレる主要因になり得ます
（`docs/data-schemas.md`が指摘した「同じsystemPromptなのに実行のたびに違う形」問題の温床が
今も残っています）。

### 1.4 Evidence→Claim対応付けは「Analystだけ」機械的に保証されている

`core/evidence/validateEvidenceIds.ts`は、Analystの`insights/comparisons/opportunities/
risks/recommendations`各項目の`evidenceIds`が、①配列であること②UUID形式であること③今回
実際に渡されたEvidence poolに実在すること、を機械的に検証し、存在しないIDだけを除去します
（項目自体は消さない）。`core/workflow/runAgent.ts` L990-999で`agent.id === "analyst"`の
場合のみ呼ばれます。

**これは「主張(Claim)が捏造Evidence IDで裏付けを詐称する」ことを防ぐ、既に動いている
実装済みの安全網です。** しかし範囲はAnalystのみで、**Writerの`sections[].evidenceIds`は
一度も検証されません**。Writerが存在しないUUIDや別ターンのEvidence IDを書いても、
現在のコードは検出しません。

### 1.5 Analystの出力は、既にClaim/Reasoning構造にかなり近い

`core/prompt/outputFormats.ts`のAnalystエントリ（L?〜、`insights[]`）を見ると：

```
insights[]: { title, importance, background, causeAndEffect, futureImplication, reason, evidenceIds }
risks[]:         { title, reason, severity,  evidenceIds }
opportunities[]: { title, reason, impact,    evidenceIds }
recommendations[]: { priority, action, reason, evidenceIds }
```

`core/agents/analyst.ts`（`outputFormats.ts`内の補足指示、実質analystの拡張プロンプト）は、
以下をかなり具体的に指示しています：

- `background`＝Evidenceから確認できる事実・背景（**事実**の置き場）
- `causeAndEffect`＝Evidenceが支持する範囲でのみ因果を明言し、支持できなければ「不明」と
  書かせる（**論理飛躍を防ぐ明示的なガード**。「〜に寄与する」のような弱い言い回しへ逃げる
  ことも禁止している）
- `futureImplication`＝未来予測が必要な場合のみ、外挿できない場合は「特定できない」と書かせる
- `reason`＝backgroundとcauseAndEffectを踏まえた「なぜこのInsightが重要か」（**Reasoning**に
  相当）
- 各項目に`evidenceIds`必須、`validateEvidenceIds`で機械検証

これは、ユーザーが提示した理想形（Evidence→Claim→Reasoning→Counterargument→
Limitation→Confidence）のうち、**Evidence・Claim(title)・Reasoning(reason/causeAndEffect)・
Confidence(confidence/confidenceReason)の4つまでは、Analystという1つのAgentの中に
既に実装されている**ことを意味します。欠けているのは主に**Counterargument**と
**項目単位のLimitation**（現状Limitationは「Writer全体で1つ」のグローバルな
`limitations: string[]`のみ）です。

### 1.6 事実／解釈／仮説の区別は、限定条件下でのみ存在する

`core/workflow/runAgent.ts` L528-576の`writerIdeaModeBlock`は、`context.userInput`に
`IDEA_MODE_MARKER`が含まれる場合のみ、Writerへ「FACT/HYPOTHESIS/IDEA/OPINION/QUESTIONを
混同するな」という指示を追加します。これは**Idea Mode（まだ正解のない仮説・アイデアを
検討する会話）専用のガードであり、通常の調査レポート生成では一切適用されません**。
通常経路でのFact/Interpretation区別は、`core/agents/writer.ts`の「事実→分析→結論の順で
書け」という一般的な文章構成指示（L395-412）に委ねられているだけで、構造的な強制はありません。

### 1.7 重複検出・論理飛躍検出は、プロンプトの指示としてのみ存在する

`core/agents/reviewer.ts`は「④重複チェック」（opportunities/risks/recommendations間の
実質的な重複）や「論理チェック」（結論と根拠が一致しているか・論理が飛躍していないか・
推測と事実が混ざっていないか）をL152-158, L275-284で明示的に要求しています。ただし：

- 対象は**Analystの出力のみ**（Writerの最終文章は前述の通りReviewerが見ない）
- 判定はすべてLLMの自己申告に委ねられており、`core/brain/analyzer.ts`
  （`analyzeExecution`）にも`core/optimizer/optimizer.ts`（`optimizeExecution`）にも、
  重複や論理飛躍を機械的に検出するロジックは一切ない（`analyzeExecution`が見るのは
  `reviewer.issues`・`context.evidence.length === 0`・`failedAgents`の3つだけ）

---

## 2. 現在のTACTを評価する（3段階）

| # | 評価項目 | 判定 | 根拠 |
|---|---|---|---|
| 1 | Evidence管理 | **できている** | `Evidence`型（`core/context/types.ts`）が体系化済み。`selectEvidence`/`rankEvidence`/`scoreEvidence`/`deduplicate`/`indexEvidence`/`checkEvidence`/`evidenceGuard`/`researchRequirement`まで、専用モジュール群が既に揃っている |
| 2 | Claim管理 | **部分的にできている** | AnalystのInsight/Risk/Opportunity/Recommendationは実質的にClaim構造だが、①Analystはcategory次第でスキップされる ②Writerの最終出力はClaim構造を保持せず自由文へ崩れる |
| 3 | Evidence→Claim対応 | **部分的にできている** | `validateEvidenceIds`がAnalystの`evidenceIds`をUUIDレベルで機械検証。ただしWriterの`sections[].evidenceIds`は未検証、`keyFindings`/`recommendations`/`nextActions`にはそもそも`evidenceIds`フィールド自体が無い |
| 4 | Fact/Interpretation/Hypothesisの区別 | **部分的にできている** | Analystの`background`(事実)と`causeAndEffect`/`reason`(解釈)は構造的に分離済み。だがWriterの通常経路には無く、IDEA_MODE_MARKER時のみ有効 |
| 5 | Reasoning管理 | **部分的にできている** | Analystの`causeAndEffect`/`reason`が事実上のReasoningフィールド。ただし独立したフィールドとして最終文章まで保持されず、Writerの一段落プロンプト内で溶かされる |
| 6 | Counterargument管理 | **現在できていない** | プロンプト全文検索でも`反証`/`counterArgument`/`反対意見`という語が一切出現しない。フィールドとしても存在しない |
| 7 | Limitation管理 | **部分的にできている** | Writer全体で1つの`limitations: string[]`のみ存在。Claim単位・Insight単位のLimitationは無い |
| 8 | Confidence管理 | **できている** | Researcher(`confidence`数値0-1)→Evidence(`low/medium/high`変換、`normalizeResearcherEvidence.ts`)→Analyst(`confidence`+`confidenceReason`、全体で1値)→Writer(`confidence`+`confidenceReason`、全体で1値)まで一貫した概念として存在。ただし全て「Agent単位で1値」であり「Claim単位」ではない |
| 9 | 論理構造管理 | **部分的にできている** | Writerに「事実→分析→結論」の順で書くようプロンプト指示はあるが、構造を強制する型・検証は無い |
| 10 | 段落構造管理 | **部分的にできている** | `sections[].heading/content`という構造はあるが、1セクション内部の論理構成（主張→根拠→推論→結論）は自由文任せ |
| 11 | 重複検出 | **部分的にできている** | Reviewerのプロンプト指示としては存在（Analystの出力のみ対象）。機械的な検出ロジックは無い |
| 12 | 論理飛躍検出 | **部分的にできている** | Analystの`causeAndEffect`に対する「支持できない因果は「不明」と書け」という強いプロンプトガードがある（かなり具体的で機能する可能性が高い）。ただしAnalystのみ対象、機械的検証なし |
| 13 | 引用整合性 | **部分的にできている** | `validateEvidenceIds`がAnalystの引用IDをUUIDレベルで検証。Writerの引用は無検証 |
| 14 | Reviewerによる批評 | **部分的にできている** | Researcher/Analyst等の中間成果物には詳細な批評基準がある。**Writerの最終文章そのものへの批評は存在しない**（1.2参照） |
| 15 | Writerへのフィードバックループ | **現在できていない** | Reviewerの`retry`にWriterを指定することがプロンプト上明示的に禁止されている。Writer出力の再生成ループは存在しない |
| 16 | 最終文章の一貫性 | **部分的にできている** | Writerプロンプトに「事実→分析→結論」「重複削除」等の指示はあるが、最終出力を検証する第三者が存在しないため保証はプロンプト遵守頼み |

---

## 3. 最終報告

### ① 現在の文章生成能力

**「専門的なレポート」と「調査レポート」の中間、ただし論点によっては論文要約に片足がかかっている状態**、と評価します。

根拠：
- Writerのプロンプト（`core/agents/writer.ts`）は「事実→分析→結論」「Evidence最優先」「推測禁止」「対象読者への適応」など、一般的なAI生成レポートより明確に上の水準を要求している。
- Analystが選択された場合（`business`/`research`カテゴリ）、`causeAndEffect`に対する「支持できない因果は書くな」という強いガードは、実際に論文的な厳密さに近い（このガードの実効性はLLM次第だが、プロンプト設計としては既に高水準）。
- **しかし、Analystは`writing`/default/`design`/`coding`カテゴリでは不在**であり、この場合Writerは生Evidenceから一発でClaim/Reasoningの両方を即興で作る必要がある。この経路は「一般的なAI生成レポート」の水準に近い。
- **最終文章を誰も検証しない**（1.2）ため、「毎回必ず論文レベルになる」という保証はどの経路にも存在しない。品質はLLMの1回の生成品質にほぼ全面的に依存している。

つまり現状は「良いときはかなり良い（特にAnalyst経由）が、経路によって品質の下限が大きく揺れる」状態です。

### ② 最大のボトルネックTOP5

1. **Writerの最終文章を誰も批評しない**（1.2）。Reviewerの複数の高水準な評価基準（論理飛躍・矛盾・推測混入チェック）はAnalystの出力にしか適用されず、実際にユーザーへ届く文章そのものには一度も適用されない。
2. **Analystが経路によってスキップされる**（1.1）。TACTで唯一Claim/Reasoning構造を持つAnalystが、`getTeam()`のcategory分岐次第で不在になり、Writerが単独でEvidenceから結論まで飛ぶことになる。
3. **Evidence→Claim対応付けの機械検証がAnalystだけに閉じている**（1.4）。`validateEvidenceIds`という優れた既存資産があるのに、最終成果物であるWriterの`sections[].evidenceIds`・`keyFindings`・`recommendations`・`nextActions`には一切適用されていない。特に`keyFindings`/`recommendations`/`nextActions`は`evidenceIds`フィールド自体が存在しない。
4. **Counterargument（反証）がどこにも存在しない**（2の項目6）。Analystにもフィールドが無く、プロンプトにも一度も登場しない。「この結論はこのEvidenceだけでは言い切れない」という限界の指摘は、Writer全体で1つのグローバルな`limitations`にのみ委ねられ、個々の主張単位では扱えない。
5. **ResearcherのsystemPromptが自己矛盾した3つの出力形を同時に指示している**（1.3）。実害は`outputFormats.ts`側の形が優先されることで限定的だが、LLMへの指示品質そのものが不安定であり、Evidence構造のブレの温床になっている。

### ③ 現在すでに存在するもの（そのまま活用できる）

- `Evidence`型と`selectEvidence`/`rankEvidence`/`scoreEvidence`/`deduplicate`/`checkEvidence`/`evidenceGuard`一式（Evidence管理基盤そのものは十分成熟している）
- `validateEvidenceIds`（Evidence ID の実在性・形式を機械的に検証する仕組み。Writerへ範囲拡張するだけで転用できる）
- Analystの`insights[].background/causeAndEffect/reason/evidenceIds`構造（Claim/Reasoning/Evidence対応付けの実質的なプロトタイプが既にプロンプトレベルで実装されている）
- Analystの`causeAndEffect`に対する「支持できない因果は書くな」という論理飛躍防止のプロンプト設計（考え方自体を他Agentへ転用できる）
- Reviewerの評価基準一式（Evidence整合性・論点網羅性・重複チェック・論理チェック）。**対象をAnalystからWriterへ広げるだけで転用できる**、既に高水準な評価軸
- `confidence`/`confidenceReason`の概念（Researcher→Evidence→Analyst→Writerで一貫した命名・意味を保っている）
- `writerIdeaModeBlock`のFACT/HYPOTHESIS/IDEA/OPINION/QUESTION区別（Idea Mode限定だが、通常経路への拡張の土台になる）

### ④ 欠けているもの（本当に必要なものだけ）

ユーザー提示の`Claim`型をそのまま作ることは推奨しません。理由は⑤で述べます。本当に必要なのは
以下の2つだけです。

1. **Writerの最終出力にEvidence追跡性を持たせること**：`keyFindings`/`recommendations`/
   `nextActions`各項目に`evidenceIds?: string[]`を追加し、`validateEvidenceIds`の
   `VALIDATED_FIELDS`を拡張してWriter出力にも適用する。これは**新しい型を作らずに**、
   既存の`validateEvidenceIds`と`sections[].evidenceIds`という既存フィールドパターンを
   横展開するだけで実現できる。
2. **ReviewerがWriterの最終文章を1回だけ見る経路を追加すること**：新しいAgentを増やすのでは
   なく、既存Reviewerの評価基準（論理チェック・重複チェック・Evidence整合性）を、
   Writerの出力に対しても適用できるようにする。ワークフロー順序を「Writer→Reviewer
   （最終チェックのみ・新しいEvidenceは追加禁止）」という**1回限りの末尾ステップ**として
   追加するだけで、「批評→修正」ループの最小形になる。

**Counterargument/Limitationについては、新しいAgentも新しい大きな型も不要**という判断です。
Analystの`insights[]`に`counterArguments?: string[]`という**1フィールドだけ**を追加し、
「Evidenceの中に反対方向の情報がある場合のみ記入、無ければ省略可」という指示を足せば、
既存の`background/causeAndEffect/reason/evidenceIds`という枠組みの中で自然に収まります。
これも新しい型・新しいAgentは不要です。

### ⑤ 最小実装案（「これだけ追加すれば一段上がる」構成）

3点だけを提案します。いずれも**既存のAgent構成・型定義を壊さず、新しい大きな抽象化も
作りません**。

1. **`validateEvidenceIds`の対象をWriterへ拡張**（`core/workflow/runAgent.ts`の呼び出し条件を
   `agent.id === "analyst"` → `agent.id === "analyst" || agent.id === "writer"`へ、
   `VALIDATED_FIELDS`に`sections`を明示的に含める。`keyFindings`/`recommendations`/
   `nextActions`へも`evidenceIds?`を追加するかは②のプロンプト変更とセットで判断）。
   **影響範囲**：`core/workflow/runAgent.ts`, `core/agents/writer.ts`
   （`evidenceIds`を書くよう指示を追加）, `core/prompt/outputFormats.ts`
   （Writerエントリへ`evidenceIds`追加）。
2. **Reviewerを、Writerの後にもう一度だけ軽量に走らせる**。新しいAgentは追加せず、
   既存の`reviewer`をWorkflowの末尾（Writerの直後）にもう1ステップとして追加し、
   このパスでは「新しい情報の追加・Evidenceの再取得は禁止、既存文章の論理チェック・
   重複チェックのみ」という限定的な役割にする（既存`reviewer.ts`のsystemPromptに、
   「この2回目の呼び出しでは対象がWriterの最終文章であること」を分岐させる最小限の
   追記で対応可能）。承認されなければWriterを1回だけ再実行する（新しい`retry`先として
   `writer`を許可する、ただし無限ループを避けるため既存の`maxReview`をこの末尾チェックにも
   適用する）。
   **影響範囲**：`core/workflow/defaultWorkflow.ts`（または動的Plan生成側）,
   `core/agents/reviewer.ts`, `core/workflow/handleReviewer.ts`
   （Writerをretry対象として許可する分岐を追加）。
3. **Analystに`counterArguments?: string[]`を1フィールドだけ追加**し、
   「Evidence上に反対方向の情報がある場合のみ記入」という指示を`insights`/
   `opportunities`/`recommendations`のいずれかに付与する（全部に付ける必要はない。
   まずは`insights`だけで十分）。
   **影響範囲**：`core/agents/analyst.ts`, `core/prompt/outputFormats.ts`
   （Analystエントリへ1フィールド追加）。

この3点だけで、②③④で挙げたボトルネックの少なくとも3/5（Writerの文章が誰にも
批評されない／Evidence追跡がWriterの最終出力で途切れる／反証が存在しない）に
直接対応できます。**新しい型定義・新しいAgent・新しいディレクトリは一切増やしません。**

`getTeam()`のcategory別チーム構成変更（Analystを`writing`/defaultにも含めるかどうか）は、
今回は提案に含めません。これは「①Plannerが認識する主張の構造」に関わる設計判断であり、
CLAUDE.mdが定める「Agent責務・Plannerの選択ロジックの変更」に該当するため、
別途ユーザーへの確認を要すると判断しました。

### ⑥ 理想構成（将来形）

```
Evidence（現状のまま。既に成熟）
  ↓
Claim（Analystの insights/opportunities/risks/recommendations を正式にClaimとして扱う。
       新しい型ではなく、既存のAnalyst出力形をそのまま「Claim」という概念名で捉え直す）
  ↓
Reasoning（Analystの background/causeAndEffect/reason を正式にReasoningの構成要素とする）
  ↓
Counterargument（⑤で追加する counterArguments フィールド。Evidence上に対立情報がある場合のみ）
  ↓
Conclusion（現状どおりWriterが担う。ただしWriterへ渡すのは自由文のEvidence羅列ではなく、
            構造化されたClaim+Reasoning+Counterargumentのリストにする）
  ↓
Writer（「Evidenceから考える」役割ではなく、「検証済みのClaim構造を自然な文章として
        構成する」役割へ寄せる。ただし完全な役割転換は大きな変更のため、
        段階的に進める前提）
  ↓
Critic（⑤②で追加する「Writer後のReviewer」。将来的にはAnalystと同じ評価粒度
        （Evidence整合性・論理飛躍・重複）をWriterの最終文章にも適用する専用パスへ育てる）
  ↓
Revision（CriticがretryをWriterへ返した場合の再生成。既存のReviewer↔Agent再実行の
          仕組み（`handleReviewer.ts`）をそのまま転用できる。新しい制御機構は不要）
```

この理想構成のポイントは、**「Evidence→Claim→Reasoning→Counterargument→Conclusion→
Writer→Critic→Revision」という9段のパイプラインのうち、Evidence・Claim・Reasoningの
3段は既にAnalystというAgent1体の中に実装済みであり、Counterargumentは1フィールド追加、
Critic/Revisionは既存Reviewer/Agentループの転用で済む**、という点です。**新しい
Agentは1体も増やさずに到達可能**だと判断しています。

### ⑦ STEP66への提案（優先順位付き）

1. **最優先**：⑤の1（`validateEvidenceIds`をWriterへ拡張し、`sections`/`keyFindings`/
   `recommendations`/`nextActions`にEvidence追跡性を持たせる）。最も既存資産の転用度が
   高く、新しいAgent呼び出しが不要（追加のLLM呼び出しコストがゼロ）で、かつ
   「事実と主張の対応関係を追跡できる」という論文レベルの土台要件Dに直結する。
2. **優先**：⑤の3（Analystの`insights`に`counterArguments?`を追加）。Analystが選択される
   経路限定だが、影響範囲が最小（1フィールド＋プロンプト追記のみ）で、Counterargument
   というTACTに完全に欠けている概念を初めて導入できる。
3. **優先（ただし検証を要する）**：⑤の2（Writer後にReviewerをもう一度走らせる）。
   効果は最も大きいが、①LLM呼び出しが1回増える（コスト・レイテンシ増）②`maxReview`や
   `retry`制御へWriterを含める分岐が必要、という実装・検証コストが他の2つより高い。
   STEP66でまず1・2を実装し、効果を確認してから着手することを推奨する。
4. **STEP67以降で検討**：`getTeam()`のcategory別チーム構成に`analyst`を含めるかどうかの
   見直し（`writing`/default経路でもClaim構造を持たせるかどうか）。これはPlanner/Agent
   責務の変更に該当するため、着手前にユーザーへの確認が必要。
5. **長期・任意**：`docs/data-schemas.md`のPhase 6（zod等による実行時バリデーション）と
   合流させ、Writerの`evidenceIds`検証を型レベルでも保証する。

---

## 4. 補足：投資判断のための率直な自己評価

- ユーザー提示の`Claim`型（`id, statement, evidenceIds, reasoning?, counterArguments?,
  limitations?, confidence?`）は、**既存のAnalyst出力形とほぼ1対1で対応します**
  （`title`≒`statement`、`evidenceIds`はそのまま、`reason`≒`reasoning`、
  `confidence`は全体で1値という違いのみ）。したがって「新しい型を作る」のではなく
  「既存のAnalyst出力を`Claim`という概念で呼び直す」ことで十分であり、今回
  新しい型定義ファイルは提案していません。
- 逆に、**Reviewerの「Writerの文章を一度も見ない」という構造的欠落**は、型の追加では
  解決できない、Workflowの実行順序に関わる問題です。ここだけは⑤の2のような
  ワークフロー変更が必要になります。
