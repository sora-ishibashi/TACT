# Prompts

TACTのPrompt設計について、現在の実装（`core/prompt/`, `core/agents/*.ts`, `core/workflow/runAgent.ts`）
を対象に記述します。`[提案]` の付いた箇所は、コードから直接読み取れない改善案です。

---

## 1. PromptBuilderの役割

実行時に使われるPromptBuilderは `core/prompt/builder.ts` の `buildPrompt()` 一つです。

```ts
buildPrompt(
  agentId, userInput, task,
  outputs, stepOutputs, toolResults,
  memory, handoffs, evidence, mode
) => string
```

`core/workflow/runAgent.ts` は、Agent 1回の実行につき最大2回 `buildPrompt()` を呼びます
（初回、およびTool実行後の再構築）。`buildPrompt()` は与えられたコンテキストから
「そのAgent専用のuserPrompt」を1つの文字列として組み立てて返すだけで、副作用は持ちません。
LLM呼び出し（`runLLM`）自体は `runAgent.ts` 側の責務です。

`buildPrompt()` が呼ばれるたびに、渡す情報を `agentId` ごとに切り替えます（`visibleOutputs`
によるAgent別フィルタリングなど）。つまりPromptBuilderは「共通テンプレート＋Agentごとの
可視範囲制御」を担うモジュールという位置づけです。

なお、`core/prompt/` には `compiler.ts` / `evidence.ts` / `format.ts` / `memory.ts` / `priority.ts` /
`tools.ts` / `workflow.ts` / `outputs.ts` / `sections.ts` / `templates.ts` / `handoffs.ts` という、
`buildPrompt()` と役割が重なる（Evidenceセクションだけ・Toolセクションだけ、のように
セクション単位に分割した）モジュール群が存在しますが、**現状どこからもimportされておらず未使用**です。
`buildPrompt()` は同等の処理をすべて自分の関数内にインライン実装しています
（`format.ts` は中身が空のファイルです）。

`[提案]` 上記の未使用モジュール群は、将来 `buildPrompt()` を分割・保守しやすくする際の
下敷きとして使える可能性がありますが、現状は死んでいるコードであり、そのまま使うと
実際のプロンプトには反映されません。利用する場合は `builder.ts` から明示的にimportし直す必要があります。

## 2. Promptの責務

1つのAgent実行に渡るプロンプトは2つのパートに分かれます。

- **systemPrompt**（`core/agents/*.ts` の `systemPrompt` フィールド）: そのAgentの人格・
  MISSION・絶対ルール・出力フォーマット例など、Agent固有の恒常的な指示。Agent定義ファイル内に
  すべて書かれ、実行時に動的に変化しない。
- **userPrompt**（`buildPrompt()` の戻り値）: その回の実行固有の動的コンテキスト
  （現在のタスク、Evidence、他Agent出力、Tool結果、Memoryなど）。`core/prompt/responsibilities.ts`
  （Agentごとの責務説明）と `core/prompt/outputFormats.ts`（Agentごとの出力JSON雛形）を
  `buildPrompt()` が読み込んで埋め込む。

両者は `core/llm/providers/openai.ts` の `runOpenAI()` 内で、OpenAIの `messages` 配列における
`role: "system"` と `role: "user"` として別々に渡されます。

セクションごとの責務（`buildPrompt()` 内での実装順）は `docs/architecture.md` の
「5. Prompt構成」の一覧を参照してください。要点のみ挙げると：

- **Agent Responsibilities**（`responsibilities.ts`）: 何をして良い/悪いかの簡潔な宣言。
- **Brain Memory**（`core/brain/memory.ts: formatBrainMemory()`）: 過去実行から蓄積された、
  全Agent共通の改善ルール。
- **Reviewer Memory**（`context.memory[agentId]`）: そのAgentに対して過去のReviewerが
  出した未解決の改善要求。
- **Shared Evidence**: `selectEvidence()` で絞り込んだ、そのAgent向けの関連Evidence上位15件。
- **Output Format**（`outputFormats.ts`）: そのAgentが返すべきJSONの雛形。

## 3. 再利用方針

- Agentをまたいで共通のテキスト（利用可能Agent一覧、利用可能Tool一覧、Evidence表示形式など）は
  `buildPrompt()` の中で1度だけ生成し、全Agentの呼び出しで再利用する（Agentごとに生成し直さない）。
- Agentごとに異なる部分（責務説明・出力フォーマット・可視Agent範囲）は、`buildPrompt()` 本体に
  ベタ書きせず、`responsibilities.ts` / `outputFormats.ts` のような「Agent名をキーにした
  レコード（`Record<AgentId, string>`）」として外出しする、という方針が既存コードから読み取れます。
  ただし `agentRules`（Agent別の簡易ルール）と `handoffInstructions`（次のAgentへの引き継ぎ文言）は
  `builder.ts` 内に直書きされており、この方針が一貫して適用されているわけではありません。
  `[提案]` 新規にAgent別テキストを追加する場合は、`responsibilities.ts` / `outputFormats.ts` と
  同じ形（別ファイルの `Record<AgentId, string>`）に合わせることを推奨します。
- Evidenceの文面化（Evidence一覧をテキストへ変換する処理）は `buildPrompt()` 内に直接実装されて
  いますが、同等の処理を行う `core/prompt/evidence.ts: buildEvidenceSection()` が別途未使用のまま
  存在します。Evidence表示形式を変更する場合は、どちらか一方に統一してから修正することを推奨します
  `[提案]`。
- `buildPrompt()` は `handoffs`（`context.handoffs`、各Agentが出力した `handoff` フィールドを
  集約したもの）を引数として受け取りますが、関数本体では一度も参照していません。実際にプロンプトへ
  出力されている「Current Handoff」セクションは、この `handoffs` 引数ではなく `builder.ts` 内に
  ハードコードされた `handoffInstructions`（次に動くAgent名などの固定文言）です。したがって
  各Agentが出力する `handoff` フィールドの中身（summary・importantPoints など）は、この経路からは
  後続Agentのプロンプトに反映されません。ただし `handoff` は `parsed`（Agentの出力全体）の一部として
  `context.outputs` / `context.stepOutputs` にも保存されるため、「Outputs from Other Agents」や
  「Workflow History」セクション経由では間接的に読めます。

## 4. 出力フォーマット定義の重複について

各Agentの出力JSONフォーマットは、次の2箇所で別々に定義されています。

- Agent自身の `systemPrompt`（`core/agents/*.ts`）内に書かれた出力フォーマット例
- `core/prompt/outputFormats.ts` の `outputFormats[agentId]`（`buildPrompt()` がuserPromptの
  末尾に追加する「Output Format」セクション）

この2つは、Writer・Researcher・QueryBuilder・Designer・Engineer・Stakeholder・Reviewerなど
複数のAgentで、フィールド名や構造が一致していません（詳細・具体例は `docs/agents.md` の
各Agentの節を参照。Writerが最も差異が大きい例、Researcherは `outputFormats.ts` 側の例文自体に
JSON構文の誤り＝カンマ抜けがある例です）。実行時は両方がそのままLLMへ渡るため、
どちらが優先されるかは実装（コード）からは一意に決まりません。ただし実際の実行ログ
（`logs/*.json`）をいくつか確認したところ、ResearcherもWriterも実際には `outputFormats.ts` 側の
（プロンプトの末尾に近い）形式で応答しており、`systemPrompt` 本文が独自に示す形式ではなく
`outputFormats.ts` の形式が優先される傾向が見られました（ログ数件からの観察であり、
常にそうなることを保証するものではありません）。`[提案]` 新しいAgentを追加する場合や
既存の出力フォーマットを変更する場合は、`systemPrompt` 内の例と `outputFormats.ts` の該当エントリを
必ず同時に更新し、一致させることを推奨します。

## 5. Tool Calling時のルール

TACTのTool呼び出しは、OpenAIのFunction Calling機能ではなく、Agentが返すJSON内の
`toolRequests` フィールドを使った自前プロトコルです。

- Agentは、Toolを使いたい場合、他のフィールドを省略して以下の形だけを返す。

  ```json
  {
    "toolRequests": [
      { "tool": "web-search", "arguments": { "query": "..." } }
    ]
  }
  ```

- `core/workflow/runAgent.ts` は、`agent.tools.length > 0` かつ `parsed.toolRequests` が
  非空配列の場合のみToolを実行する。Agent定義（`core/agents/*.ts`）の `tools: string[]` に
  含まれないToolは、たとえLLMが `toolRequests` に書いても実行判定の対象にならない
  （ただし現状 `agent.tools` の中身とToolRegistryの登録有無は個別にチェックしておらず、
  未登録Toolを指定した場合は `runTool()` が例外を投げ、`executeToolCalls()` がそれを
  `{ success: false, error }` として結果に含める形で吸収する）。
- Tool結果を受け取った後、`buildPrompt()` は同じAgentに対してもう一度呼ばれ、
  「Tool実行は完了している。`toolRequests` は空配列にしてJSONを完成させよ」という指示文が
  追記された上で `runLLM()` が再実行される。1つのAgentステップにつき、Tool使用時は
  最大2回LLMを呼ぶ。
- Plannerが `toolRequests` を返した場合、`runAgent.ts` はそれを明示的に削除し、実行しない
  （Planner自身はTool実行禁止というルールがコード側でも強制されている）。
- Tool結果のうち `web-search` のものだけが自動的にEvidence化される
  （`core/tools/pipeline/executeToolPipeline.ts` が `request.tool === "web-search"` を判定）。
  他のToolを追加する場合、Evidence化が必要かどうかをこの判定に追加するかどうか検討が必要。
- プロンプト内の「Tool Results」セクションには、Tool結果の中身は埋め込まれず、
  `"[Tool Results Available]"` という有無だけの表示になる。実際のTool結果データは
  Evidence化された内容（Shared Evidenceセクション）を通じてのみ、次回のLLM呼び出しに伝わる。

`[提案]` Tool結果の中身がPromptに直接渡らず「Evidence化されたものだけが伝わる」設計のため、
Evidence化の対象にならないTool（例えば `calendar`）を追加した場合、Agentがその生データを
Prompt上で直接参照できない可能性がある。新しいToolを追加する際は、Evidence化が必要かどうかを
`core/tools/pipeline/executeToolPipeline.ts` 側で明示的に判断すること。
