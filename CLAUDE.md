@AGENTS.md

# TACT開発ルール（Claude Code向け）

このファイルはTACTというマルチAgentワークフローシステムの開発に、Claude Codeとして
参加する際に守るべきルールを定めます。プロジェクトの現状（何が実装されていて何が未使用か）は
`docs/architecture.md` と `docs/agents.md` に、開発時のコーディング規約は `docs/coding.md` に、
Prompt設計の考え方は `docs/prompts.md` にまとめてあります。作業前に必ず該当ドキュメントを確認してください。

## 1. アーキテクチャを勝手に変更しない

- `core/workflow/`（実行エンジン）・`core/agents/`（Agent定義）・`core/prompt/builder.ts`
  （PromptBuilder）という現在の構造は、明示的な指示なく作り替えない。
- ディレクトリ構成の変更（例: `core/agent/` と `core/agents/` の統合、未使用ファイルの削除）は、
  必ず着手前に対象と理由をユーザーへ説明し、承認を得てから行う。
- 「動いていないから」「重複しているから」という理由だけで、`docs/architecture.md` に
  「未使用」と記載されたファイルを自己判断で削除しない。削除して良いか必ず確認する。

## 2. 各Agentの責務を侵食しない

- Planner・QueryBuilder・Researcher・Analyst・Designer・Engineer・Stakeholder・Reviewer・Writerは
  それぞれ明確な責務分担を持つ（`docs/agents.md` 参照）。あるAgentのsystem promptを直すときに、
  他のAgentの責務（例: ResearcherのEvidence収集をAnalystのsystem promptに書き足す、
  Writerに新しい分析をさせる指示を混ぜる）を侵食する変更をしない。
- Plannerが「どのAgentを・どの順序で実行するか」を決めるオーケストレーターであるという設計を
  尊重し、Workflow実行順序のロジック（`core/workflow/handlePlanner.ts` など）を、
  他の目的（例: UI都合）のために書き換えない。

## 3. Optimizer（Brain/Optimizer）は評価専任として扱う

- `core/brain/` と `core/optimizer/` は、実行結果を事後評価し、改善ルールをBrain Memoryへ
  蓄積して次回以降のPromptに反映する仕組みであり、ワークフローの実行順序やAgent選択そのものを
  直接書き換える権限を持たない設計になっている（詳細は `docs/architecture.md` の
  「7. Optimizerの位置づけ」）。この非対称性（評価はするが実行制御はしない）を崩す変更、
  すなわちOptimizer/Brainの判断でPlanner・Reviewerの決定を直接上書きするような実装は、
  明示的な指示がない限り追加しない。

## 4. 型安全を優先する

- 新規コード・修正コードで `any` を使わない。既存の `any` を見つけても、依頼された変更の範囲外なら
  無理に一括修正しない（変更範囲が肥大化するため）。範囲内であれば、`docs/coding.md` の方針に従い
  具体的な型へ置き換える。
- `strict` モード（`tsconfig.json`）を弱める設定変更はしない。

## 5. 既存実装を尊重する

- 既存のAgent system prompt（`core/agents/*.ts`）は、そのAgentの振る舞いを規定する重要な
  設計資産である。文言の意図が分かりにくくても、指示されていない限り書き換えたり要約したりしない。
- 既存の命名・ディレクトリ構成に矛盾や重複（例: `core/agent/` と `core/agents/`、
  2つの`optimizer.ts`）が見つかっても、それを「バグ」として即座に修正するのではなく、
  まず事実として報告し、修正するかどうかをユーザーに委ねる。

## 6. 実装前に変更方針を説明する

- コードを書き始める前に、何を・なぜ・どう変えるのかを簡潔に説明し、特に複数ファイルにまたがる
  変更や、`core/workflow/` ・ `core/agents/` ・ `core/prompt/` など中核ディレクトリに触れる変更は、
  着手前に承認を得る。
- ドキュメント作成のみを依頼された場合は、コード（`.ts`/`.tsx`）を変更しない。

## 7. 大きな変更は段階的に行う

- 複数Agent・複数ファイルにまたがる変更は、一度に全部変えようとせず、意味のある単位
  （例: 1Agentのsystem prompt調整、Evidenceパイプラインの1関数修正）に分割し、
  都度動作確認できる粒度で進める。
- 大規模なリファクタリング（例: `core/prompt/` の未使用モジュール群を実際に使う構成へ移行する）は、
  提案の上、ユーザーの同意を得てから着手する。

