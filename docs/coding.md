# Coding Rules

TACTの開発で今後守るコーディングルールです。`docs/architecture.md` / `docs/agents.md` が
「現在の実装がどうなっているか」を記述するのに対し、このドキュメントは
「これから書くコードがどうあるべきか」を定める規範（ルール）です。既存コードベースには
本ドキュメントに反する箇所（`any` の多用、巨大な関数など）が現時点でも残っており、
新規コードから段階的に適用していくことを想定しています。ルールと現状の乖離があるのは
`[提案]` された規範だからであり、既存実装が誤りだったと断定するものではありません。

---

## 1. TypeScript

- `strict: true`（`tsconfig.json` で既に有効）を維持する。新たに `strict` を緩める設定変更はしない。
- 関数の引数・戻り値には明示的な型を付ける。特に `core/` 配下の関数（Agent間でやり取りされる
  データを扱う）は型を省略しない。
- Agentの出力JSON（LLM応答）のように「実行時まで形が確定しない」データは、
  `any` で受けるのではなく、期待する形の `interface`/`type` を定義してから
  `JSON.parse()` の戻り値をその型へアサーションする（または軽量なバリデーションを通す）。
- 型定義は原則1箇所に集約する。`core/agents/types.ts` と `core/agent/types.ts` のように、
  同じ概念（`Agent` / `Provider` / `AgentId`）を指す型が複数ディレクトリに重複して存在する状態は
  作らない。既存の重複を見つけた場合は、まず `docs/architecture.md` の「未使用」表記を確認し、
  実際に使われている方へ寄せる。

## 2. `any` の扱い `[提案]`

- 新規コードで `any` を使わない。特にAPIルート・Workflowエンジン（`core/workflow/*`）・
  Reactコンポーネントの `Props` 型では禁止とする。
- 現状 `core/workflow/runAgent.ts` の `step: any` / `context: any`、多くのコンポーネントの
  `Props` の `any` 型（例: `components/layout/Workspace.tsx`、`components/layout/RightPanel.tsx`）
  など、既存コードには `any` が広く使われている。これらは**新規に真似しない**。
  改修の機会があれば `WorkflowStep` / `WorkflowContext` / 具体的なProps型へ置き換える。
- どうしても型が確定できない外部入力（LLM応答の生JSONなど）は `unknown` で受け取り、
  使う直前に型ガード・パース関数を通す。

## 3. 小さな関数

- 1つの関数は1つの責務にとどめる。`core/workflow/runAgent.ts` のように
  「Evidence選定・Prompt構築・LLM呼び出し・Tool実行・Evidence保存・Memory保存・ログ保存」を
  1関数内で行う構成は増やさない。新規に手を入れる際は、意味のあるまとまりごとに
  関数として切り出す（例: Evidence保存処理を `saveResearcherEvidence(context, parsed)` のように分離する）。
- 目安として、1関数がインデント2段階を超えてネストする場合、あるいは1画面で処理内容が
  把握できない場合は分割を検討する。

## 4. DRY（重複の排除）

- 同じ責務を持つロジックを複数箇所に持たない。例えば `core/prompt/builder.ts` 内の
  `agentRules`（Agentごとの簡易ルール）と `core/prompt/responsibilities.ts` は内容が
  一部重複しているが、これは新規追加時の模範にはしない。新しいAgent向けテキストを追加する場合は
  `responsibilities.ts` / `outputFormats.ts` のような専用モジュールに1箇所だけ書き、
  `buildPrompt()` からはそれを参照する。
- 使われなくなったコード（レガシー実装）は放置せず、参照が完全にゼロであることを確認できた時点で
  削除する（`docs/architecture.md` の「未使用」一覧が削除候補の起点になる）。

## 5. 責務分離

- `core/agents/*.ts`（Agentの人格・ルール・出力フォーマットの定義）と
  `core/workflow/*.ts`（Agentをどう並べ、いつ再実行するかというオーケストレーション）の境界を崩さない。
  Agentのふるまいを変えたいときはsystem promptを、実行順序や再試行ロジックを変えたいときは
  `core/workflow/` を編集する、という対応関係を保つ。
- Evidence関連の責務は `core/evidence/`（Evidenceの選定・採点・重複排除など、Evidence配列に対する
  純粋なロジック）に置く。Tool実行結果からのEvidence生成は `core/tools/pipeline/` に置く。
  両者を混ぜない。

## 6. UIとロジックの分離

- `components/` 配下のコンポーネントに、Workflow実行ロジック（SSE解析、状態遷移の判定など）を
  直接書き続けない。現状 `components/InputBar.tsx` はSSEの受信・パース・状態更新まで1コンポーネントで
  行っており、新規に同様のロジックを増やす場合は、まずSSEクライアント部分をhook
  （例: `useTactStream()`）などUIから独立した関数へ切り出すことを検討する。
- Reactコンポーネントの `Props` に `any` を使わない（「2. `any` の扱い」参照）。
  API応答の型（`WorkflowContext` やAgent出力の型）を `core/` 側からimportして再利用する。

## 7. 命名規則

- ファイル名: `core/` 配下は `camelCase.ts`（例: `runAgent.ts`, `selectEvidence.ts`）。
  Reactコンポーネントは `PascalCase.tsx`（例: `FinalOutput.tsx`）。既存の命名と一致させる。
- 関数名: 動詞＋名詞（`buildPrompt`, `runAgent`, `selectEvidence`, `checkEvidence` など既存の
  命名パターンに合わせる）。
- ディレクトリ名は単数形・複数形を混在させない。`core/agent/`（単数）と `core/agents/`（複数）が
  併存している状態は今回のドキュメント整備で判明した既存の問題であり、新規ディレクトリでは
  同様の紛らわしい命名を避ける。
- 型名の末尾に `Result` / `Response` / `Request` を使う場合は、既存の `LLMRequest` /
  `LLMResponse` / `ToolResult` / `OptimizerResult` の命名パターンに合わせる。

## 8. Next.jsの前提 `[重要]`

- このリポジトリの `AGENTS.md` に記載の通り、このプロジェクトのNext.jsバージョンは
  学習データにある一般的なNext.jsと挙動・規約が異なる場合がある。App Router関連のコードを
  書く前に `node_modules/next/dist/docs/` を確認し、非推奨の書き方をしない。
