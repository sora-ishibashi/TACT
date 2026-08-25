@AGENTS.md

# TACT開発ルール（Claude Code向け）

このファイルはTACTというマルチAgentワークフローシステムの開発に、Claude Codeとして
参加する際に守るべきルールを定めます。プロジェクトの現状（何が実装されていて何が未使用か）は
`docs/architecture.md` と `docs/agents.md` に、開発時のコーディング規約は `docs/coding.md` に、
Prompt設計の考え方は `docs/prompts.md` にまとめてあります。作業前に必ず該当ドキュメントを確認してください。

TACT開発では「実装→最小限の確認→実際に動かす→改善」のサイクルを高速に回すことを優先します。
今回の方針は「安全性を下げる」ためではなく、「必要な安全確認だけ残して、PDCAを止める確認を
減らす」ためのものです。以下のルールは、この前提のもとで運用してください。

## 1. 基本方針：低〜中リスクの変更は自律的に進める

- 明示的に指示されたSTEPについて、既存コードから合理的に実装方法を判断できる場合は、
  実装前に許可を求めず、そのまま作業を開始する。
- 「この方針で進めてよいですか？」「このファイルを変更してよいですか？」「この方法で
  実装してよいですか？」といった確認は、低リスクな変更については行わない。
- 実装方法に複数の選択肢がある場合は、既存構造を最も壊さず、変更範囲が小さい方法を
  自律的に選択する。

## 2. アーキテクチャ保護

- `core/workflow/`（実行エンジン）・`core/agents/`（Agent定義）・`core/prompt/builder.ts`
  （PromptBuilder）という現在の構造を勝手に作り替えないというルールは維持する。
- ただし、明示的に依頼されたSTEPの範囲内で必要となる複数ファイルの変更については、
  事前承認を要求しない。
- 以下に該当する変更のみ、着手前にユーザーへの確認を必要とする。
  - Workflow全体の設計変更
  - Agent責務そのものの変更
  - PlannerによるAgent選択ロジックの変更
  - Optimizer/Brainの権限変更
  - DBスキーマの破壊的変更
  - 既存APIとの互換性を壊す変更
  - 大規模なディレクトリ再編
  - 既存機能を削除する変更
  - セキュリティやデータ損失につながる可能性がある変更
- それ以外の通常の実装変更は、指示されたSTEPの範囲内で自律的に進める。
- 「動いていないから」「重複しているから」という理由だけで、`docs/architecture.md` に
  「未使用」と記載されたファイルを自己判断で削除しないことは変わらず維持する。

## 3. Agent責務

- Planner・QueryBuilder・Researcher・Analyst・Designer・Engineer・Stakeholder・Reviewer・
  Writerの責務分担（`docs/agents.md` 参照）を勝手に変更しない。
- ただし、明示的にAgentのPromptや責務改善を依頼された場合は、その範囲内で自律的に実装する。
- 他Agentの責務を侵食する変更（例: ResearcherのEvidence収集をAnalystのsystem promptに
  書き足す、Writerに新しい分析をさせる指示を混ぜる）が必要になった場合のみ、実装を止めて
  報告する。
- Plannerが「どのAgentを・どの順序で実行するか」を決めるオーケストレーターであるという
  設計は引き続き尊重する。

## 4. Optimizer / Brain

- `core/brain/` と `core/optimizer/` が実行結果を事後評価する評価専任であり、Workflowの
  実行順序やAgent選択そのものを直接書き換える権限を持たないという設計（`docs/architecture.md`
  「7. Optimizerの位置づけ」）は維持する。
- Optimizer/BrainがPlannerやWorkflowを直接制御する構造へ変更する場合のみ、ユーザーに確認する。
- 通常の評価ロジック・Prompt改善・型修正・バグ修正については、明示された範囲内で自律的に
  実装する。

## 5. 型安全

- 新規コードでは `any` を使わない。
- 既存の `any` は、今回の変更範囲外なら修正しない。既存エラーを見つけても、それが今回の
  作業と無関係なら勝手に修正範囲を広げない。
- ただし今回の変更によって発生したTypeScript / ESLintエラーは、自律的に修正する。
- `strict` モード（`tsconfig.json`）を弱める設定変更はしない。

## 6. 実装前確認の簡略化

- 実装前の長い方針説明や承認確認は原則不要。明示されたSTEPを理解したら、必要なファイルを
  確認してそのまま実装を開始する。
- 実装前に確認が必要なのは、以下の場合のみ。
  - 指示内容が複数の意味に解釈でき、実装結果が大きく変わる場合
  - データ損失の可能性がある場合
  - 既存API互換性を壊す可能性がある場合
  - DBスキーマを変更する場合
  - Workflow / Agentの根本設計を変更する必要がある場合
  - ユーザーの明示的な制約と実装要求が衝突する場合
- それ以外は質問せず進める。
- ドキュメント作成のみを依頼された場合は、コード（`.ts`/`.tsx`）を変更しないことは
  引き続き維持する。

## 7. 変更範囲

- 明示されたSTEPを完了するために必要な複数ファイルの変更は、ユーザーへの事前承認なしで
  行ってよい。
- ただし、依頼されたSTEPと無関係なリファクタリングやコード整理は行わない。
- 「必要な変更」と「ついでに改善できる変更」を区別し、後者は勝手に実装しない。

## 8. テスト

- テストは必要最小限にする。STEPの目的を確認するためのテストを優先し、網羅的な検証を
  毎回要求しない。
- 基本的には以下までで良い。
  1. TypeScript / ESLintで今回の変更による新規エラーがないことを確認する
  2. STEPの中心機能を1〜数ケース確認する
  3. 実際に動かせる場合は実機で簡単に確認する
- 既存エラーは今回の変更によるものでないことが確認できれば、それ以上追わない。

## 9. エラーへの対応

- 今回の変更によって発生したエラーは、自律的に原因を調査して修正する。修正方法が明確で
  低リスクなら、ユーザーに確認せず修正する。
- 既存エラーについては、今回の変更に関係しない限り勝手に修正しない。

## 10. 作業完了時の報告

- 完了時は長大な報告を避け、以下だけ簡潔に報告する。
  - 何を変更したか
  - テスト結果
  - 問題があればその内容
  - 次に必要な作業があればそれ
- 変更していないファイルを大量に列挙する必要はない。
- git diffや既存エラーの詳細も、ユーザーが求めた場合を除き簡潔にする。

## 11. TACT開発の優先思想

TACT開発では完璧な設計を最初から完成させることよりも、

「小さく実装する」→「実際に動かす」→「ユーザーが触る」→「違和感を見つける」→「すぐ修正する」

というPDCAを高速に回すことを優先します。したがって、低リスクな変更について過剰な確認・
設計レビュー・承認待ちを行いません。ユーザーから明示的にSTEPが与えられた場合、そのSTEPの
意図を満たす最小限の変更を自律的に実装してください。

## 12. 既存ルールとの関係

上記以外の既存ルールは維持します。特に以下は引き続き重要です。

- アーキテクチャを勝手に破壊しない
- Agent責務を勝手に変更しない
- Optimizer / Brainの権限を勝手に拡張しない
- 新規コードで `any` を使わない
- 不要なリファクタリングをしない
- DB/API互換性を不用意に壊さない

既存のAgent system prompt（`core/agents/*.ts`）が重要な設計資産であること、既存の命名・
ディレクトリ構成の矛盾や重複を見つけても即座に「バグ」として修正するのではなくまず事実として
報告することも、これまでと変わらず維持します。

## 13. TACT Research Phase方式の開発ルール（Phase66〜、スマホからの継続作業向け）

`core/tact-research/`・`core/tact-conversation/`・`core/tact-artifact/`・
`core/tact-orchestrator/` を中心とするTACT Research/Comparison Table基盤の開発は、
上記1〜12の一般ルールに加えて、Phase単位で以下の順序を守る。

- Phase方式で開発する。1つのPhase指示 = 1つの調査・実装スコープとして扱い、
  指示されていない次のPhaseへ勝手に進まない。
- 各Phaseの基本順序: 実装前にRoot Causeをコードレベルで確認 → 最小実装 →
  Unit Test → 全Regression（`npm test`） → `tsc --noEmit` → `eslint` →
  （必要なら）`next build` → 実装完了報告。
- **Reality Test（実LLM/実Search APIを使った実機確認）は、ユーザーの明示的な許可が
  出た場合のみ実行する。** 実装完了報告の時点では実行せず、そこで一旦停止する。
- Reality Test実行後は、結果を報告して停止する。結果を見て次に何をするかは
  ユーザーが判断する（「次のPhaseへ自動で進む」ことをしない）。
- Root Causeが完全に特定できていない状態で、大規模な設計変更・Pipeline刷新を
  行わない。特定できなかった場合は「未特定」と正直に報告して止める。
- Search/LLM呼び出しは無制限に増やさない（Discovery/Deepeningのような多段階化は、
  上限回数を明示した上で最小限にする）。API/DBコストを意識し、不要な呼び出しを
  増やす変更は避ける。
- No-Fabrication（確認できない情報を「情報未確認」等で扱い、推測で埋めない）は
  常に維持する。
- 既存Architecture（Research/Conversation/Artifact/Orchestratorの一方向依存、
  既存Block/Schema）を優先し、新しいSchema・新しいPipeline・新しいProviderの追加は
  最小限にする。可能な限りoptional/additiveな変更（既存の型に`?`付きフィールドを
  足す等）を基本とする。
- Phase単位で1 commitを基本とする（例: `phase95: validate stale knowledge fix`）。
  ただしReality Testのみでcode変更が無いPhaseはcommit不要。

## 14. 現在地点（最終更新: Phase94、2026-08-25）

TACT Research／Comparison Table基盤は Phase66〜94 まで進行済み（2026-08-25時点で
`checkpoint: TACT Research/Artifact pipeline through Phase94` としてまとめてcommit・
push済み）。

- **Phase90〜92**: Research結果からComparison Tableを生成する基盤
  （Table Schema・Evidence Grounding・Query Condensation）を実装。ただし実機では
  個別イベントEntityがほとんど発見できず、ポータル/一覧ページの情報に留まっていた。
- **Phase93**: Research Capabilityへ Discovery → Deepening（`core/tact-research/
  candidateDiscovery.ts`）を追加。実機でDiscovery→Deepeningの発火自体は確認できたが、
  Candidate抽出（ポータル判定）の精度が低く、個別Entity発見には未到達（改善は
  Phase95以降で扱う、今回は着手しない）。
- **Phase94**: Reality Testで繰り返し観測されていた「別Conversationの古いResearch
  結果（Evidence anomaly: `claim`=昔のUser Input、`source`=昔のtask ID）が、
  全く無関係なTurnでCore-only Answerability（LLM 0回・Search 0回）の根拠として
  誤って再利用される」問題のRoot Causeを特定・修正。Research由来のKnowledgeは
  `freshness: "volatile"` として区別されていたが、DBへ永続化される際にこの情報が
  失われていたため、`assessAnswerability()` / `knowledgeGap.ts` の
  `classifyRequirement()` がCore-only判定の根拠として誤って使ってしまっていた。
  `KnowledgeItem.metadata` 経由でfreshnessを永続化し、Core-only判定の2箇所から
  volatileなResearch Knowledgeを除外することで修正（過去のResearch結果を閲覧する
  `/api/tact/knowledge` は意図的に対象外のまま）。591 tests passed / tsc 0 errors /
  eslint 0 errors・0 warnings（既存Legacy Workflowファイルの既存エラーは対象外）。
  **Phase94のReality Testはまだ実行していない**（許可待ちで停止中）。

**Phase95の起点**: まずPhase94のReality Test（Phase90〜93と同じ3ターン構成）を
実行し、Turn2/Turn3で実際に`performWebResearch()`まで到達すること・Evidence
anomalyが再発しないことを実データで確認する。それを踏まえて、Candidate抽出精度の
改善（Phase93で残った課題）へ進むかどうかを判断する。
