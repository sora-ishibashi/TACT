# Source

- **Project / Product name**: Agent Control Plane (ACP)、開発元は HumanLayer（HumanLayer社／`humanlayer` GitHub org）
- **Repository URL**: https://github.com/humanlayer/agentcontrolplane
- **Official docs URL**: リポジトリ内 `docs/`（README上のリンクは `/humanlayer/agentcontrolplane/blob/main/docs` を指しているが、独立したドキュメントサイトは確認できず）。関連の設計思想として https://github.com/humanlayer/12-factor-agents （HumanLayer社が公開する「12-factor-agents」原則集、READMEで明示的に参照されている）
- **License**: Apache License 2.0
- **License evidence**: `https://raw.githubusercontent.com/humanlayer/agentcontrolplane/main/LICENSE`（Apache-2.0全文、Copyright “Agent Control Plane Authors”, 2024）。リポジトリ内の各ソースファイル冒頭にも同ライセンスヘッダが付与されていることを `contactchannel_types.go` 取得時に確認。ディレクトリ／ファイル単位で異なるライセンス条項は確認されなかった。
- **Last checked date**: 2026-09-07（本調査実施日）
- **Repository activity / maintenance status**: `agentcontrolplane` リポジトリの最新コミットは **2025-07-02**（"restore readme"）。★474 / Fork 60。Archivedバッジは無いが、調査日（2026-09-07）時点で1年以上コミットが無く、README冒頭に「⚠️ ACP is in alpha」の警告が明記されている。加えて、同じ `humanlayer` org のメインリポジトリ `humanlayer/humanlayer`（人間承認SDK/CLIの元祖リポジトリ）は README上で明示的に **deprecated** とされ、"the code here is pretty much all deprecated. we're doing a full rebuild, check out https://humanlayer.com" と書かれている。現在の humanlayer.com は "The multiplayer control plane for your software factory"（コーディングエージェント向けIDE/クラウド製品）を謳っており、ACPが体現していた「Kubernetes上のAgent Control Plane」路線とは製品の重心が変わっている可能性が高い。**つまりACPは、組織の主力プロダクトの外側にあるalpha段階のOSSで、直近1年以上更新が止まっている。**
- **Exact version / commit inspected if possible**: `main` ブランチ HEAD（2025-07-02時点の最新コミット、コミットハッシュはWeb取得のため未確定。ファイルは `raw.githubusercontent.com/humanlayer/agentcontrolplane/main/...` 経由で取得）

# Problem Solved

READMEおよびリポジトリ説明文より、プロジェクト自身の言葉で述べられている問題設定は以下の通り（TACT用語に寄せず原文の主張をそのまま記載）:

- 「outer-loop agents that run without supervision」＝人間がその場で監督しない、長時間・非同期に自律動作するエージェントを対象とする。
- そうしたエージェントは「asynchronous tool calls like requesting human feedback on key operations」（人間へのフィードバック要求のような、非同期なツール呼び出し）を行う必要があるが、これを単純さ・明確さ・制御性（"simplicity, clarity, and control"）を保ったまま実現する「distributed agent scheduler」が必要である、という立て付け。
- 設計思想として HumanLayer社の "12-factor-agents" を参照しており、そこでは「launch/pause/resumeをシンプルなAPIで扱う」「人間への連絡も他のツール呼び出しと同様の非同期ツールコールとして扱う」「制御フローをフレームワークのブラックボックスに委ねず、明示的なwhileループとして所有する」といった原則が掲げられている（`humanlayer/12-factor-agents` README要約より）。
- Kubernetes上のCRD＋Operatorパターンを採用することで、「context windowの累積そのものを実行状態として扱い、etcdのレプリケーションとKubernetesの信頼性保証に乗せる」ことで、耐障害性・再開可能性を実現しようとしている（README/リポジトリ説明の要約）。

# Architecture

## Core concepts
- **LLM**（CRD）: プロバイダ（OpenAI, Anthropic, Vertex AI, Mistral）・APIキー参照・モデルパラメータを保持する設定リソース。
- **Agent**（CRD, `acp/api/v1alpha1/agent_types.go`）: `LLMRef`（必須）、`MCPServers []LocalObjectReference`（任意）、`HumanContactChannels []LocalObjectReference`（任意）、`System string`（必須、system prompt）、`SubAgents []LocalObjectReference`（任意、委譲先Agent一覧）、`Description string`（delegateToAgentツールの説明文に使われる）を持つ。
- **Task**（CRD, `acp/api/v1alpha1/task_types.go`）: 1回のAgent実行インスタンス。`AgentRef`（必須）、`UserMessage`または`ContextWindow []Message`（初期文脈）、`ContactChannelRef`（任意、人間連絡先）、`ThreadID`（会話継続用）、`BaseURL`/`ChannelTokenFrom`を持つ。Statusには`Phase`・`ContextWindow`（会話履歴全体を保持）・`Output`・`SpanContext`（OTel）が入る。
- **ToolCall**（CRD, `acp/api/v1alpha1/toolcall_types.go`）: Task内で発生する個々のツール呼び出しを、独自ライフサイクルを持つ第一級オブジェクトとして表現。`ToolType`は`MCP`／`HumanContact`／`DelegateToAgent`の3種。
- **MCPServer**（CRD, `acp/api/v1alpha1/mcpserver_types.go`）: `Transport`（`stdio`または`http`）、`Command`/`Args`/`Env`（stdio用）、`URL`（http用）、`ApprovalContactChannel *LocalObjectReference`（このMCPサーバのツール実行前に人間承認を要求する設定）を持つ。
- **ContactChannel**（CRD, `acp/api/v1alpha1/contactchannel_types.go`）: `Type`（`slack`または`email`）、`SlackChannelConfig`（`ChannelOrUserID`, `ContextAboutChannelOrUser`, `AllowedResponderIDs`）、`EmailChannelConfig`（`Address`, `ContextAboutUser`, `Subject`）を持つ。人間への連絡経路をKubernetesリソースとして宣言的に管理する。

## Main entities
Task 1つに対しToolCallが0〜N個ぶら下がる。ToolCallがサブエージェント委譲（`DelegateToAgent`）の場合、子Taskが新規作成される（親子関係はラベルで表現、`executeDelegateToAgent()`が冪等にTaskを作成しラベルで相関を取る、と要約取得できた＝`acp/internal/controller/toolcall/executor.go`）。

## State machine
`acp/internal/controller/toolcall/state_machine.go` に実装（詳細は下記「State Machine」節）。TaskとToolCallそれぞれが独立したフェーズ遷移を持ち、Kubernetesの標準reconcileループ（`ctrl.Result{RequeueAfter: ...}`）で駆動される。

## Execution model
- Kubernetes Operator（controller-runtime想定）としてTask/ToolCall/Agent/LLM/MCPServer/ContactChannelそれぞれにコントローラが存在（`acp/internal/controller/{agent,contactchannel,llm,mcpserver,task,toolcall}/`）。
- 「context windowの累積そのものを実行状態として扱う」設計（README要約）。つまり明示的な"実行スタック"を別管理せず、会話履歴（`ContextWindow []Message`）をTask CRのStatusとして永続化し、それをそのまま次のLLM呼び出し・再開の入力として使う。
- ツール呼び出しやAgent委譲が起きるたびに、その時点の会話状態をチェックポイントとして保存し、完了イベントをもとにcontrol loopが再開する（README要約："checkpointing a conversation chain whenever a tool call or agent delegation occurs"）。

## Persistence model
- Source of truthは **Kubernetes etcd**（CRDインスタンスとしてTask/ToolCall等がKubernetes APIサーバー経由でetcdに保存される）。アプリケーション独自のDB（Postgres等）は確認できなかった。
- 人間承認・人間連絡の外部呼び出し結果との相関は、ToolCallのStatusフィールド `ExternalCallID string` に、HumanLayer側が発行したcall IDを保存する形で行われる（`toolcall_types.go`のToolCallStatus構造体で確認）。

## Human interaction model
2種類の人間関与パターンがREADME要約およびコントローラ要約から確認できた:
1. **承認ゲート（Approval）**: `MCPServer.ApprovalContactChannel` が設定されている場合、そのMCPサーバのツール実行前に必ず人間承認を要求する。ToolCallは `AwaitingHumanApproval` フェーズに入り、承認されれば `ReadyToExecuteApprovedTool`、拒否されれば `ToolCallRejected` に遷移する。
2. **人間への問い合わせ自体をツールとして呼ぶ（HumanContact as Tool）**: `Agent.HumanContactChannels` を設定すると、Agentは人間への問い合わせを明示的なツール（`ToolType: HumanContact`）として能動的に呼び出せる。承認ゲートとは異なり、非決定的な人間からの入力そのものを得るためのもの。ToolCallは `AwaitingHumanInput` フェーズに入る。

いずれも実チャネルはSlack／Emailで、HumanLayer社のクラウドAPI（HumanLayer本体のSaaS）経由で配信・回収される（`getAPIKey()`, `configureContactChannel()` の存在から、外部HumanLayer APIキーをKubernetes Secret経由で利用する設計と分かる）。

## Retry / recovery
- `waitForApproval()` / `waitForHumanInput()` は5秒間隔でHumanLayer APIをポーリングし（`CheckApprovalStatus()` / `CheckHumanContactStatus()`）、エラー時は15秒のバックオフでリトライする、という実装が `state_machine.go` の要約から確認できた。
- Task側にも `TaskPhaseErrorBackoff` という明示的なフェーズが存在する（`task_types.go`のTaskPhase enum）。ただし具体的なバックオフ秒数・最大リトライ回数の実装詳細（exponential backoffか固定間隔か等）はソース全文を取得できておらず未確認。

## Permission / policy
- 「誰が承認できるか」の制御として `SlackChannelConfig.AllowedResponderIDs`（承認可能なSlackユーザーIDを制限）が存在することを確認。
- それ以外の、LLM出力や環境条件に基づく決定論的なポリシーエンジン（TACTでいうPolicy/Permissionレイヤに相当する専用コンポーネント）は、取得できた範囲のコードには見当たらなかった。承認要否は静的な `ApprovalContactChannel` の有無で決まり、動的なポリシー評価ロジックは確認できていない（**不明/未確認**、全ソースを精査すれば見つかる可能性はあるが本調査では非対象部分に留まった)。

## Audit
- Kubernetes Events（`kubectl get events`）に全フェーズ遷移・アクションが記録される、とREADME要約に明記。ToolCall/Task CRのStatus自体もetcdに保存されるため、`kubectl describe`/`kubectl get -o yaml` でイベント発生時点の文脈（`ContextWindow`全体）を確認できる。専用の監査ログテーブル／改ざん防止の仕組み（TACTのAuditに相当する専用モデル）は確認できなかった。
- OpenTelemetry対応は「進行中（In Progress）」とREADMEに明記されており、トレース収集は完成していない可能性がある。

## Credential handling
- LLMプロバイダのAPIキー、HumanLayer APIキー、MCPサーバのEnv変数はいずれも Kubernetes Secret 参照（`SecretKeyRef`）経由で注入される設計（`mcpserver_types.go`のEnvVarSource、`getAPIKey()`のfallback priorityの記述より）。TACT視点で言う「LLM/Agentに生の認証情報を渡さない」設計思想と概ね整合する（ただし実際にLLMプロンプトへ機密情報が漏れないかまでは未検証）。

## Provider/runtime coupling
- **Kubernetesへの強い結合**: CRD＋controller-runtime前提の設計であり、Kubernetesクラスタなしでは動作しない（TACTのようなNext.js/Supabaseベースの構成とは実行基盤が根本的に異なる）。
- **HumanLayerクラウドAPIへの結合**: 人間承認・人間連絡の実処理はHumanLayer社のSaaS APIに委譲されている（自前でSlack/Email連携を実装しているわけではない）。ACP単体をセルフホストしても、人間対話部分は外部SaaS依存が残る可能性が高い（未検証、README/コードの要約からの推測）。

（コード参照パス: `acp/api/v1alpha1/{task_types.go, toolcall_types.go, agent_types.go, mcpserver_types.go, contactchannel_types.go}`、`acp/internal/controller/toolcall/{state_machine.go, executor.go, toolcall_controller.go}`）

# State Machine

## Implemented
**TaskPhase**（`acp/api/v1alpha1/task_types.go`、Go定数として確認済み）:
`Initializing` → `Pending` → `ReadyForLLM` → `SendContextWindowToLLM` → `ToolCallsPending` → `CheckingToolCalls` → `FinalAnswer`
（エラー系: `ErrorBackoff`, `Failed`）

**TaskStatusType**: `Ready` / `Error` / `Pending`

**ToolCallPhase**（`acp/api/v1alpha1/toolcall_types.go`、Go定数として確認済み）:
`Pending` → `Running` → `Succeeded` / `Failed`
人間関与系: `AwaitingHumanInput`, `AwaitingHumanApproval` → `ReadyToExecuteApprovedTool` / `ToolCallRejected`
サブエージェント系: `AwaitingSubAgent`
エラー系: `ErrorRequestingHumanApproval`, `ErrorRequestingHumanInput`

**ToolCallStatusType**: `Ready` / `Error` / `Pending` / `Succeeded`

**ToolType**: `MCP` / `HumanContact` / `DelegateToAgent`

これらはいずれも実際のGo型定義（`const`ブロック）として確認したものであり、READMEの説明文だけでなくソースコードで裏取りできている。

## Inferred
- ポーリング間隔「5秒」・エラーバックオフ「15秒」は `state_machine.go` の要約取得結果に基づくもので、ファイル全文を直接確認したわけではないため「推定（コード要約に基づく、要ソース原文再確認）」として扱う。
- Task/ToolCallのタイムアウト・キャンセルを表す専用フェーズやフィールドは、確認した範囲の型定義には存在しなかった。Kubernetesリソースとして `kubectl delete` すれば実質的にキャンセルできると推測されるが、それは「設計されたキャンセル機能」ではなく「Kubernetes汎用の削除操作」に過ぎない（**未確認、推定**）。
- ロードマップ（README）に「Trigger workflows from webhooks, Slack messages, and emails」が“今後”の項目として明記されており、現時点の人間応答の相関はWebhook受信ではなく **ACP側からのポーリング** で行われていると判断できる（`CheckApprovalStatus()`/`CheckHumanContactStatus()`の存在、および「webhook」がロードマップの未実装項目である事実の両方から推定）。

# TACT Equivalent

| ACP概念 | TACT概念 | 対応の性質 |
|---|---|---|
| Task（1回のAgent実行、ContextWindowを保持） | Run（TaskをCapability/Provider/Modelの組で1回実行したもの） | かなり近い。ただしACPのTaskは「LLM 1体との対話全体」を指し、TACTのTaskとRunの分離（1 Task→N Runs）は無い。ACPのTaskはTACTでは「Runに相当する粒度」に近く、TACTのTaskに相当する「複数Runにまたがる論理的な作業単位」の概念はACPには存在しない。 |
| ToolCall（`HumanContact`型） | HumanInteraction | 近い。`AwaitingHumanInput`/`AwaitingHumanApproval`という明示的な待機状態と、応答が返るまでresumeしない設計はTACTのHumanInteraction設計の参考になる。 |
| ToolCall（`AwaitingHumanApproval`→承認/拒否） | Approval | 近い。「protected writeはApproval取得前に実行されない」というTACTの要件と、ACPの「ApprovalContactChannelが設定されたMCPツールは承認されるまでReadyToExecuteApprovedToolに進まない」という設計は構造的に一致する。 |
| MCPServer | Capability（の一部、外部ツール群） | 部分的に対応。ACPではMCPは「3種類あるToolTypeの1つ」であり、TACTのCapabilityよりは狭い（MCPは外部ツール呼び出しの手段の1つに過ぎない）。 |
| LLM（CRD） | Provider（の一部） | 部分的に対応。プロバイダ設定・認証情報の保持という点は似るが、ACPのLLMはAgentに直結する設定オブジェクトであり、TACTのProvider neutralityほど抽象化されていない。 |
| ToolType=DelegateToAgent / SubAgents | Capability間の委譲、または将来のTask分割 | 部分的に対応。ACPの委譲は「子Task生成＋結果をContextWindowに合流」という単純なモデルであり、TACTのTask/Run分離や監査要件と比べると設計が薄い。 |
| ContextWindow（Task Statusに格納される会話履歴） | Context | 部分的に対応。TACTのContext READ権限のような、粒度別の権限制御は確認できず、ACPでは会話全体がフラットに蓄積される。 |
| Kubernetes Events | Audit | 弱い対応。Kubernetes Eventsは汎用的な運用ログであり、TACTが要求するような専用のAudit実体（誰が・いつ・何を承認したかの正式記録）としての設計は確認できなかった。 |
| Conversation | 対応なし | ACPには「Conversation」と「Work（Task）」を分離する概念は存在しない。TaskがLLMとの対話そのものであり、TACTのConversation/Work分離モデルに相当する区別はない。 |
| Work | 対応なし（Taskが兼ねている） | 上記と同様、ACPのTaskはTACTの「Work」概念とも「Task」概念とも部分的に重なるが、正確には一致しない。無理に対応させるべきではない。 |
| Policy / Permission（決定論的な評価エンジン） | 対応不明瞭 | ACPには承認要否を動的に評価する専用ポリシーエンジンは確認できず、静的な `ApprovalContactChannel` の有無のみで制御される。TACTが要求する「LLM判断に頼らない決定論的なPolicy/Permission」とは設計の厚みが異なる（弱い対応、または対応なし）。 |

# Reusable Code

いずれも **Go言語・Kubernetes Operator（controller-runtime）前提のコード** であり、TACTはNext.js/TypeScript + Supabaseというスタックのため、コードをそのまま持ち込む（コピー＆リンク）ことは実質的に不可能。

- **対象**: `acp/api/v1alpha1/*.go`（CRD型定義一式）
  - License上の可否: Apache-2.0のため法的には利用可能。
  - dependency: Kubernetes API machinery (`k8s.io/apimachinery`) 前提。
  - TACTへそのまま持ち込めるか: **不可**（言語・実行基盤が根本的に異なる）。
  - adaptation required: 型定義の「考え方」（Phase enum、ExternalCallID相関）をTypeScript型として再設計する必要がある＝実質的には「コード」ではなく「スキーマ設計の参考」としてのみ有効（後述のReusable Schema/Patternを参照）。
  - security concern: 該当なし（移植しないため）。

- **対象**: `acp/internal/controller/toolcall/state_machine.go`, `executor.go`
  - License上の可否: Apache-2.0で可。
  - dependency: controller-runtime, HumanLayer Go/HTTPクライアント。
  - TACTへそのまま持ち込めるか: **不可**。
  - adaptation required: ポーリングによる相関ロジック（5秒間隔ポーリング＋15秒バックオフ、と要約取得）は概念として参考にできるが、実装はTACTのWorkflow実行エンジン（`core/workflow/`）向けにゼロから書き直す必要がある。
  - security concern: 外部API呼び出し（HumanLayer SaaS）へのAPIキー受け渡し方法は、TACTの「LLMに認証情報を渡さない」方針との整合を個別に確認する必要がある（今回未検証）。

総括: **Reusable Code = None（直接移植可能なコードは無し）**。言語・実行基盤の相違により、コードそのものの再利用価値は無いと判断。

# Reusable Schema

- **ToolCallPhase state enum**（`Pending/Running/Succeeded/Failed/AwaitingHumanInput/AwaitingSubAgent/AwaitingHumanApproval/ReadyToExecuteApprovedTool/ErrorRequestingHumanApproval/ErrorRequestingHumanInput/ToolCallRejected`）: TACTのHumanInteraction/Approvalの状態列挙として、名前の付け方（"Awaiting"接頭辞で待機状態を明示、"ReadyToExecute*"で再開後の実行可能状態を明示、拒否と失敗を別状態として分離）は概念的に参考になる。ただし列挙そのものをコピーするのではなく、TACTの既存Approval/HumanInteraction設計に合わせて必要な状態だけ抽出すべき。
- **ExternalCallID相関スキーマ**: ToolCallStatusが`ExternalCallID string`という1フィールドだけで外部サービス（HumanLayer）の追跡IDを保持し、それをポーリングキーとして使う、という「resume tokenを1つの外部IDフィールドとして持つ」設計は、TACTのresume token/interaction id設計の最小構成例として参考になる。
- **ContactChannel schema**（Slack: `ChannelOrUserID` + `AllowedResponderIDs`、Email: `Address` + `Subject`）: 「誰が応答してよいか」をチャネル側で制限する発想（`AllowedResponderIDs`）は、TACTのHumanInteractionにおける応答者検証の参考になりうる。

これらは**スキーマの「考え方」としてのみ**参考にできるものであり、Go structやJSON Schemaをそのまま輸入するものではない（TACTは独自にTypeScript型として設計すべき）。

# Reusable Pattern

- **「ポーリングによる非同期完了待ち」パターン**: LLM/Agentの実行そのものをブロックせず、ToolCallを別リソース（別状態）として切り出し、一定間隔でポーリングして完了を検知し、完了したら元のTaskの会話文脈に結果を合流させて再開する、という構造。TACTがすでに志向している「Work lifecycleとHTTP request lifetimeの分離（durable execution）」と方向性が一致しており、概念パターンとして参考価値が高い。
- **「Approvalゲートと能動的HumanContactを別ToolTypeとして分離する」パターン**: 「実行前に人間の許可を得る（Approval、受動的ゲート）」と「Agentが自発的に人間に質問する（HumanContact、能動的な情報収集）」を明確に別のツール種別として区別している点は、TACTの「Approval」と「HumanInteraction」を別概念として扱う方針と整合し、概念設計の裏付けとして参照できる。
- **「resume tokenを最小限の1フィールドにする」パターン**: 複雑な状態機械を組まず、`ExternalCallID`という単一の文字列フィールドと、フェーズ（enum）の組み合わせだけで再開ロジックを構成している。これはシンプルさを重視するTACTの設計原則（"Build less"）とも整合する、参考にできる最小構成の実例。
- **「会話全体を状態として持ち、専用の実行スタックを持たない」パターン**: ACPは実行スタックを別途持たず、蓄積された`ContextWindow`（会話履歴）そのものを再開の入力として扱う。これはシンプルだが、TACTのように「Context READ権限」を細かく制御したい場合には粒度が粗すぎる可能性があり、**そのまま採用すべきパターンではなく、反面教師としても参考になる**（過度なフラット化の弊害）。

# Reusable UX

- Slack/EmailベースでApproval/HumanContactを送るという体験は、READMEおよび型定義（`ContextAboutChannelOrUser`, `ContextAboutUser`, `Subject`など、LLMや人間向けに文脈を補足するフィールドの存在）から、「人間に送る通知に、なぜこの承認/質問が必要なのかの文脈を添える」という配慮がされていることが読み取れる。UI/UXの実装（画面、コンポーネント）そのものは確認できておらず、ACPリポジトリ自体はUIを持たない（ロードマップに「ACP UI」が"今後"の項目として明記されている＝現時点でUIは存在しない）。
- 総括: **Reusable UX = None**（具体的な画面・UIコンポーネントとして参照できるものは確認できなかった。通知文面設計の考え方のみ「Reusable Pattern」側に記載）。

# Risks

- **License**: Apache-2.0であり法的リスクは低い。ただし、ACPが依存する「HumanLayer本体（SaaS/クライアントSDK）」のライセンス・利用規約は今回未調査であり、もし実際にHumanLayer社のクラウドAPIクライアントコードやSDKパターンを参考にする場合は別途確認が必要。
- **Security**: LLMプロンプトへの機密情報混入有無、Secret経由のAPIキー注入が実際に安全に扱われているかは、ソース全文レビューをしていないため未検証。
- **Provider lock-in**: 人間承認・連絡の実処理をHumanLayer社のSaaS APIに依存しており、ACP自体をセルフホストしてもこの部分はベンダー依存が残る可能性が高い（推定）。
- **Runtime lock-in**: Kubernetes CRD/Operatorパターンに強く結合しており、TACTのNext.js/Supabase基盤とは実行モデルが根本的に異なる。移植ではなく「概念の参考」に留めるべき。
- **Architecture mismatch**: ACPはAgent中心（Agentがトップレベルのオーケストレーション単位）の設計であり、TACTが明確に否定している「中心はAgentではなくWork」という思想と対立する。TACTのConversation/Work分離、Task/Run分離もACPには存在しない。**概念のつまみ食いは可能だが、アーキテクチャ全体を輸入すべきではない**。
- **Agent-centric bias**: 上記の通り、AgentがLLM・ツール・サブエージェントを束ねる主役として設計されており、TACTの「Agent/LLM/SaaS/HumanはすべてParticipant/Capability」という設計原則とは重心が異なる。
- **Overengineering**: Kubernetes Operatorという実行基盤の重さ自体が、TACTの規模・要件に対しては明らかにオーバーエンジニアリングであり、基盤ごと採用する選択肢は最初から除外すべき。
- **Scaling concern**: 5秒間隔ポーリング×15秒バックオフという実装（要約ベース、未確定）は、多数の同時待機Taskがある場合にKubernetes APIサーバーやHumanLayer APIへの負荷になりうる。TACTで同種の設計を採る場合はポーリング間隔・件数上限を別途設計する必要がある。
- **Persistence mismatch**: ACPはetcd（Kubernetesネイティブ）を単一の永続化先としているのに対し、TACTはSupabaseを単一のsource of truthとする方針であり、両者は非互換。ACPの永続化コードは一切再利用できない。
- **Multi-tenant concern**: 確認した範囲のCRD設計はnamespace単位のスコープであり、SaaS的なマルチテナント（テナントごとのデータ分離・課金・権限分離）を明示的に扱う設計は確認できなかった（**不明**、要追加調査）。
- **Secret handling**: Kubernetes Secret経由の間接参照という設計自体は妥当に見えるが、TACTが要求する「Context READ権限とAction WRITE権限の分離」のような粒度までは踏み込んでおらず、そのままでは不十分。
- **メンテナンス状況のリスク（追加）**: 前述の通り `agentcontrolplane` は最終コミットが2025-07-02で1年以上更新停止、かつ組織全体の主力製品は別方向（コーディングエージェントIDE/クラウド）にピボットしている形跡がある。**「現在進行形で磨き込まれている設計」ではなく「alpha段階で止まったプロトタイプ」として評価すべき**であり、これを権威ある正解として過度に信頼するのはリスクがある。

# Classification

- **Kubernetes CRD/Operatorという実行基盤そのもの**: REJECT（TACTのスタックと根本的に非互換、採用の意味がない）
- **ToolCallのAwaiting系フェーズ命名・状態分離パターン（概念）**: REFERENCE_ONLY（名前・区分の発想は参考になるが、コード・スキーマをそのまま輸入はしない）
- **ExternalCallID（resume token）を単一フィールドで持つ設計パターン**: ADAPT（TACTのHumanInteraction/Approvalスキーマに、同種の「外部相関ID一本」という発想を適用する余地がある。ただし独自にTypeScript型として設計し直す必要がある）
- **Approval（受動的ゲート）とHumanContact（能動的問い合わせ）を別ToolTypeとして分離する設計思想**: ADAPT（TACTのApproval/HumanInteraction分離という既存方針の裏付け・参考として活用できる）
- **ポーリングベースの非同期完了検知パターン**: REFERENCE_ONLY（概念は参考になるが、TACTがWebhook/Realtime等どの方式を採るかは別途Workflow/Orchestrator側の検討が必要であり、今回のPrior Art調査の範囲でAdapt可否を断定しない）
- **Reusable Code（移植可能なコード片）**: REJECT（言語・基盤の相違によりコードとしての再利用価値なし）
- **UI/UX資産**: REJECT（ACP自体にUIが存在しないため、参照対象が無い）

# Recommendation

## Adopt
- ToolCall/HumanInteractionの状態を「Awaiting系フェーズ＋単一のexternal correlation IDフィールド」で表現するという、シンプルな設計パターンの考え方。
- Approval（実行前ゲート、protected write用）とHumanContact（Agentが能動的に発する質問）を明確に別種のインタラクションとして区別する設計思想。TACTの既存方針（Approval取得前にprotected writeを実行しない）を補強する外部傍証として扱える。

## Do Not Adopt
- Kubernetes CRD/Operatorという実行基盤・永続化モデル（etcd依存）。TACTはSupabaseをsource of truthとする方針と非互換。
- Agent中心（Agentがトップレベルの編成単位）というアーキテクチャ全体思想。TACTの「中心はWork」という原則と対立するため、部分的な概念借用に留め、アーキテクチャごと輸入しない。
- HumanLayer社のクラウドAPIへの依存構造そのもの（ベンダーロックインのリスクがあり、かつ現状メンテナンスが停滞しているプロジェクトである）。

## Why
ACPは「非同期な人間承認・人間連絡をツール呼び出しの一種として扱い、5秒ポーリング＋単一のExternalCallIDで相関を取る」という、TACTが目指すDurable Work/Pause-Resume/HumanInteraction設計と方向性が近い、コードで裏取りできる実例である。しかしKubernetes CRD/Operatorという実行基盤に強く結合しており、かつAgent中心の設計思想を採っているため、TACTのWork中心・Supabase中心・Provider neutralityという既存方針とはアーキテクチャレベルで整合しない。加えて、当該リポジトリ自体が2025年7月を最後に更新が止まっているalpha段階のプロジェクトであり、HumanLayer社自身も元のSDK/CLIをdeprecated扱いにして別方向（コーディングエージェントIDE）へピボットしている。以上より、**コードやスキーマの直接移植ではなく、「状態設計・相関ID設計・Approval/HumanContact分離」という概念レベルの参考情報として扱うのが妥当**と判断する。

## Suggested TACT Phase
本調査はPrior Art研究のみであり、`docs/prior-art/humanlayer-acp.md` の作成をもって完了とする。次のPhaseで具体的な設計へ反映する場合は、TACTの既存Approval/HumanInteractionスキーマ（該当ファイルは本調査の対象外のため未特定）に対して、ExternalCallID相当のresume token設計を追加するかどうかを、別途明示的なPhase指示のもとで検討することを推奨する（本ドキュメント単体では実装方針を決定しない）。
