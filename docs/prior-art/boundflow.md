# Source

- Project / Product name: BoundFlow（"boundflow/boundflow"。backend は Go、Python SDK が別途存在する構成）
- Repository URL: https://github.com/boundflow/boundflow
- Official docs URL: https://boundflow.dev/docs/ （トップページ: https://boundflow.dev/）
- License:
  - Backend（リポジトリ全体、`LICENSE`）: Apache License 2.0
  - Python SDK（`sdk/python/pyproject.toml`）: MIT
- License evidence:
  - `https://raw.githubusercontent.com/boundflow/boundflow/main/LICENSE` を直接fetchし、Apache License 2.0の全文（"Work"/"Derivative Works"などの定義を含む標準条文）であることを確認。末尾のcopyright noticeは "Arjun Lama (2026)"。
  - `https://raw.githubusercontent.com/boundflow/boundflow/main/sdk/python/pyproject.toml` を直接fetchし、`license = "MIT"`（プロジェクト名 `boundflow`、version `0.6.0`）を確認。
  - リポジトリ他ディレクトリ（`internal/`配下やその他サブパッケージ）ごとに異なるライセンスが付与されているかは個別ファイル単位までは確認しきれていない。少なくとも backend（Apache-2.0）と Python SDK（MIT）で明示的に異なるライセンスが併存していることは確認済み。
- Last checked date: 2026-09-07
- Repository activity / maintenance status（GitHub API `https://api.github.com/repos/boundflow/boundflow` より）:
  - Created: 2026-03-22 / Last push: 2026-09-03 / Last updated: 2026-09-02
  - Stars: 6, Forks: 2, Open issues: 7
  - README上の自己申告: "public preview (pre-1.0)"。"The engine is complete and covered by Go, mock-LLM, and live-LLM test suites, but it hasn't yet been run in production with external users."
  - コミット数: mainブランチで228コミット（WebFetch経由の要約情報のため参考値）
- Exact version / commit inspected if possible: 特定コミットハッシュは未取得（`main`ブランチのHEADをWebFetch経由で参照。fetchのタイミングにより数コミットのズレがある可能性あり）。Python SDK側は `pyproject.toml` に明記された `version = "0.6.0"` を確認。

# Problem Solved

（BoundFlow自身の言葉での問題設定。TACTの語彙に寄せず、原文の趣旨をそのまま要約する）

BoundFlowは "the open source control plane for running production AI agents and workflows safely, at scale" を名乗り、本番稼働するAI agent/workflowの運用上の課題を3つに整理している。

1. **Runtime Governance** — 実行中のagentに対するper-run cost cap・tool-call数上限・token/latency上限・model選択制約などを「実行中にハードに」強制する仕組みが必要。
2. **Lifecycle Management（Operational Lifecycle Management）** — workflowが自身のcost/failure/approval-rejectionのシグナルに反応して、model切り替え・cooldown・pause・既知良好versionへのrollbackを人手を介さず行えるようにする必要がある。
3. **Durable Execution** — workerがクラッシュしてもcheckpointから別workerが再開でき、進捗を失わない必要がある。

README冒頭では以下のように明示的にスコープを限定している。

> "BoundFlow is not a prompt framework, an inference provider, or an agent-builder; it is the operational layer around the agents you build."

また、control planeとdata planeを明確に分離することを設計原則としている。

> "BoundFlow's control plane schedules, governs, and audits every run. This separates management (the control plane) from execution (the data plane): the backend never sees inference keys or traffic, and never pays for tokens."

human-in-the-loopの例として、README中のコード例には以下のコメントが付されている（`refund` workflowの例）。

> "nothing irreversible runs until the branch it's gated behind does."

# Architecture

- **Core concepts**: Control Plane（Go製backend。`server` / `scheduler` / `worker` の3つのprocess modeがPostgresを共有し、gRPCで通信）と Data Plane（operator自身のインフラ上で動くworker。operator自身のinference keyを使用し、backendはinference keyやtoken消費に一切触れない）を分離する。
- **Main entities**（DB migrationsから直接確認。`migrations/*.sql`）:
  - `workflows`（`migrations/002_workflow_table.up.sql`）: tenantに紐づく、versioned・繰り返し呼び出される「workflow定義＋現在のlifecycle状態」を表す行。`lifecycle_state`・`workflow_state` の2種類の状態列を持つ。
  - `customer_requests`（`migrations/003_customer_requests_table.up.sql`）: workflowへの1回の呼び出し（invocation）に対応する行。`customer_request_status`・`run_outcome` を持ち、`result`・`completed_at` を保持する、append的な「実行履歴」レコード。
  - `jobs`（`migrations/004_jobs_table.up.sql`）: **`workflow_id` を主キーとする、workflowごとに1行だけ存在する「現在の実行スロット」**。`owner`・`lease_expires_at`・`attempts`・`approval_*`・`input_*` カラムを持つ、mutableな実行状態。`job_status` enumを持つ。
  - `agent_state`（`migrations/006_agent_state_table.up.sql`）: `(workflow_id, agent_name)` 単位のruntime_policy／lifecycle_policy／invocation_metrics。
  - `audit_events`（`migrations/011_audit_events.up.sql`）: tenant横断のgovernance監査ログ。
- **State machine**: workflowレベル・request（Run相当）レベル・job（実行スロット）レベル・operationレベル（proto）の4層に、それぞれ別のenumが存在する（詳細は次章「State Machine」）。
- **Execution model**: `proto/boundflow/v1/operation.proto` にて `AtomicOperation` というstep単位の実行モデルを定義。各operationは `AtomicOperationResult` を返し、`status`（`OperationStatus` enum）とともに `next_operation`（次stepへの遷移）・`approval_gate`（`ApprovalGate` message）・`input_gate`（`InputGate` message）のいずれかを持つ。Python SDK側の使用例（README実測）:

  ```python
  @worker.workflow("refund", version=1)
  async def refund(ctx):
      await ctx.run_agent(analyst)
      return AwaitApproval(
          on_approve=Next("issue_refund", ctx.context),
          on_reject=Complete(),
          justification="Approve the $5,000 refund?",
      )

  @worker.operation("refund", "issue_refund")
  async def issue_refund(ctx):
      # the sensitive action, now sanctioned
      return Complete()
  ```

- **Persistence model**: 単一のPostgres DBを `server`/`scheduler`/`worker` の3プロセスが共有。`internal/storage/postgres/` 配下にテーブルごとのGoファイル（`job.go`・`workflow.go`・`customer_request.go`・`audit.go` 等）。
- **Human interaction model**: `ApprovalGate`（`on_approve`/`on_reject`/`timeout_seconds`/`approval_id`/`justification`/`metadata`）と `InputGate`（`on_answer`/`on_timeout`/`timeout_seconds`/`input_id`/`prompt`/`metadata`）の2種類のgateがproto上明確に分離されている。承認/拒否と、外部からの自由入力待ちが別のgate typeとして扱われている点が特徴。
- **Retry / recovery**（`internal/storage/postgres/job.go` のSQLをWebFetch経由で確認）:
  - `AcquireJob`: `owner IS NULL OR lease_expires_at < now()` の行を claim し、`owner`・`lease_expires_at` を更新する（claim-before-execute + lease方式）。
  - `RequeueJob`: `UPDATE jobs SET status='pending', owner=NULL, lease_expires_at=NULL, attempts=attempts+1 WHERE workflow_id=$1 AND request_id=$2 AND attempts < $3 RETURNING attempts` — **同一の `jobs` 行（＝同一 `workflow_id`／同一 `request_id`）に対して `attempts` をインクリメントする形でretryする**。`attempts < maxAttempts` の判定自体をUPDATE文のWHERE句に埋め込み、上限到達時は0行更新（＝呼び出し元が「使い切り＝恒久失敗」と判断できる）という、アプリケーションコードではなくSQLの書き込み層でretry上限を強制するパターン。
  - `internal/scheduler/abandonedjobresolver.go`: tickerで定期的に `SweepAbandonedJobs()` を呼び、`abandon_requested_at IS NOT NULL` かつ未完了状態のjobを `status='completed'`（`failure_reason` 付き）に強制遷移させる。コード中コメントには "the server-side twin of the worker's dispatch-time check" とあり、worker側にも同種のdispatch時チェックが存在することが示唆されている（ただし該当worker側コードそのものは未確認）。
- **Permission / policy**（`docs/governance.md` をWebFetch経由で確認）: `RuntimePolicy`（`max_cost_usd`・`max_llm_calls`・`max_tokens_per_call`等、実行中にworker側でハード強制）と `LifecyclePolicy`（複数run分の集計metricsを見て事後的にmodel downgrade／cooldown／pause／version rollbackを自動実行）の2層構造。後者はworkflowのversionそのものを自動的にrollbackし得る、という点は要注意（後述「Risks」参照）。
- **Audit**: `audit_events` テーブル（`tenant_group_id`・`workflow_id`・`request_id`・`event_type`・`actor`・`occurred_at`・`details jsonb`）による決定ログと、`trace_id` で束ねられる `operation → agent → llm/tool` のtraceツリー（OpenTelemetry export対応、`docs/observability.md`）の2系統が併存する。
- **Credential handling**: "the backend never sees inference keys or traffic, and never pays for tokens"（README）。workerが自前のinference keyを保持・使用する設計。ただし実際の鍵の保管・ローテーション方法を示すコードそのものは確認していない（未確認）。
- **Provider/runtime coupling**: gRPC/proto上はmodel名等をdataとして渡す設計でprovider中立に見えるが、Python SDKの `pyproject.toml` の core dependencies に `anthropic>=0.40` が直接含まれており（`sdk/python/boundflow/anthropic_client.py` も存在）、SDKレベルでは特定providerへの実装依存が確認できる。LangChain/LangGraphはoptional dependency group扱い。

（参照した主なソースパス: `migrations/002_workflow_table.up.sql`, `migrations/003_customer_requests_table.up.sql`, `migrations/004_jobs_table.up.sql`, `migrations/006_agent_state_table.up.sql`, `migrations/011_audit_events.up.sql`, `proto/boundflow/v1/operation.proto`, `internal/storage/postgres/job.go`, `internal/scheduler/abandonedjobresolver.go`, `sdk/python/pyproject.toml`, `docs/governance.md`, `docs/observability.md`, `docs/concepts.md`, `README.md`）

# State Machine

Implemented（DB migrationsおよびprotoで直接確認したもの）:

- `job_status`（`jobs` table, `migrations/004_jobs_table.up.sql`）: `pending`, `dispatched`, `running`, `awaiting_next`, `awaiting_approval`, `approved`, `rejected`, `awaiting_input`, `answered`, `input_timed_out`, `completed`, `failed`
- `customer_request_status`（`customer_requests` table, `migrations/003_customer_requests_table.up.sql`）: `unscheduled`, `scheduled`, `in_progress`, `failed`, `completed`, `superceded`, `abandoned`, `paused`
- `run_outcome`（`customer_requests`/`jobs` の `result_type`列, 同migration）: `successful`, `customer_marked_failure`, `uncaught_operation_exception`, `operation_timeout`, `interrupted`, `suspended`
- `lifecycle_state`（`workflows` table, `migrations/002_workflow_table.up.sql`）: `creating`, `active`, `scheduled`, `blocked`, `invoking`, `awaiting_approval`, `awaiting_input`, `deleted`, `interrupted`, `halted`
- `workflow_state`（`workflows` table, 同migration）: `active`, `paused`, `cooldown`, `disabled`, `suspended`
- `OperationStatus`（proto enum, `proto/boundflow/v1/operation.proto`）: `OPERATION_STATUS_UNSPECIFIED`, `OPERATION_STATUS_IN_PROGRESS`, `OPERATION_STATUS_COMPLETED`, `OPERATION_STATUS_FAILED`, `OPERATION_STATUS_CANCELLED`
- `OperationFailureType`（同proto）: `UNSPECIFIED`, `CUSTOMER_MARKED`, `UNCAUGHT_EXCEPTION`
- `CancelReason`（同proto）: `UNSPECIFIED`, `TIMEOUT`, `SUSPENSION`

Inferred（コードから間接的に推測したもの。直接の断定的記述は未確認）:

- `job_status` 上の `dispatched`（claim済・未実行）と `running`（実行中）の境界は、`AcquireJob` のclaimロジック（owner/lease_expires_atの更新）とenumの並び順から推測したものであり、両者を明確に区別する記述そのものは見つけられていない。
- `jobs` テーブルには `job_status` に明示的な `cancelled` 値が存在しない。suspension/abandon系のフローでは `SweepAbandonedJobs` が最終的に `status='completed'`（`failure_reason` に理由文字列）にしてしまうことをSQLで確認しており、「人間が明示的にキャンセルした」ケースがTACTの言う `CANCELLED` に相当する独立stateとしては実装されていないと推測される（`completed` という成功寄りの語に一元化されている点は設計上の癖として注意が必要）。

なにも見つからなかった、ということはない（state machineの実体はmigrations/protoから複数確認できている）。

# TACT Equivalent

（ジャンル上、genuineに対応すると判断できたものだけ記載。無理な当てはめはしない）

- **Task**: `workflows` 行がもっとも近い。tenant配下でversioned・`workflow_type` で分類され、繰り返し呼び出される「登録済みの仕事の型」という点で、TACTの「Task = 論理的な仕事の単位」に近い。ただしBoundFlowの `workflows` は同時に「現在のlifecycle状態（active/paused/blocked等）」も保持しており、TACTのTaskよりも実行状態寄りの責務を負っている。
- **Run**: `customer_requests` 行がもっとも近い。1つのworkflow呼び出し＝1行、`run_outcome`・`result`・`completed_at` を持つ、append的な履歴レコードという性質は、TACTの「1 Task → N Runs」のRun概念とほぼ一致する。
- **Attempt（Runの中の再試行回数）**: `jobs.attempts` カラムがこれに相当する。ただし `jobs` テーブル自体は `workflow_id` を主キーとする「workflowごとに1行だけの現在の実行スロット」であり、TACTが想定するような「Runごとの実行状態＋attempt番号」を独立テーブルとして持つ設計ではない点は差異として明記する（BoundFlowでは `jobs.request_id` が `customer_requests.id` を指すことで、どのRunに対するattemptかを間接的に紐づけている、と推測される — この外部キー的関係を明示するFK制約は確認できていない）。
- **Approval**: `ApprovalGate`（proto）＋ `jobs.approval_id`/`approval_justification`/`approval_opened_at`/`approval_timeout_at`/`approval_metadata` カラム＋`audit_events`上の承認記録、の組が対応する。「decision（approved/rejected/timed_out）・actor・opened_at・decided_at」という監査ログの型（`docs/observability.md`より）は、TACTのApproval Receiptの型設計にそのまま参考になる。
- **HumanInteraction**: `ApprovalGate`（承認/拒否）と `InputGate`（自由入力待ち）が明確に別のgate typeとしてproto上分離されている点は、TACTのHumanInteractionを「承認待ち」と「情報待ち」に分ける際の直接的な先例になる。
- **Capability / Provider**: `agent_state`（workflow内のagentごとのruntime_policy/lifecycle_policy）＋SDKの `anthropic_client.py`/`langchain_client.py` が対応する。ただしTACTが要求する「provider中立性（vendor固有IDがdomain型に漏れない）」ほど厳格ではなく、SDK coreに `anthropic` 依存が直接入っている点は差異として明記する。
- **Policy / Permission**: `RuntimePolicy`（実行中のハード制約）と `LifecyclePolicy`（事後評価による自動アクション）の2層分離は、TACTが目指す「Policy/Permission/ApprovalはExecution Layerで決定的に強制し、LLM判断に委ねない」という原則と方向性は一致する。ただしBoundFlowの `LifecyclePolicy` はworkflowのversion rollbackや自動pauseまで自律的に行い得る点で、TACTの「Optimizer/BrainはWorkflowの実行順序・Agent選択そのものを直接書き換える権限を持たない」というルールより権限が強い。ここは模倣せず差異として報告する。
- **Audit**: `audit_events` テーブルはTACTのAudit要件（決定的・追跡可能・actor付き）にほぼそのまま対応する概念。
- **Context**: `jobs.context`（JSONB、`Next()` によるoperation間の引き継ぎ用）が対応するが、これは単なる引き回し用blobであり、TACTが想定するような「READ権限で保護されたContext」ではない点は明記する。
- **Conversation**: 対応するentityは見つからなかった。BoundFlowにはinteraction（対話）に相当する独立entityがなく、`customer_requests`（Run相当）がその役割の一部（誰が何をリクエストしたかの記録）を代替しているように見えるが、これはTACTのConversationとは性質が異なる（BoundFlowはinteractiveな対話UIを前提とした設計ではない）。無理に対応付けしない。
- **Artifact**: 対応するentityは見つからなかった。`result` JSONBは汎用payloadであり、Artifactのような独立したlifecycleを持つentityではない。

# Reusable Code

TACT本体はTypeScript / Next.js / Supabase構成（`package.json`で確認）である一方、BoundFlowのbackendはGo、SDKはPythonであり、**ソースコードをそのまま持ち込める言語的整合性がない**。

- `internal/storage/postgres/job.go`（claim/lease/retry SQL）: License上は可（Apache-2.0）。dependency: Go + pgx等（未確認）。TACTへそのまま持ち込み: 不可（言語不一致）。adaptation required: SQL/ロジックの設計思想（claim-before-execute + lease + attempts上限のSQL側強制）をTypeScript/Supabase向けに書き直す必要がある。security concern: 特になし（設計思想自体は健全）。
- `proto/boundflow/v1/operation.proto`: License上は可（Apache-2.0）。dependency: protobuf/gRPC。TACTへそのまま持ち込み: 不可（TACTはgRPCを採用していない）。adaptation required: message定義をTypeScript型定義に翻訳する形でのみ参考になる。security concern: なし。
- Python SDK（`sdk/python/boundflow/*.py`）: License上は可（MIT）。dependency: grpcio/pydantic/anthropic等。TACTへそのまま持ち込み: 不可（言語不一致、かつTACTはgRPCサーバーを持たない）。adaptation required: 大規模な書き直しが必要なため、コードそのものの移植は推奨しない。

結論として、コードの直接的な再利用候補は **None**（言語・runtime不一致のため。ライセンス上は問題ないが、実利がない）。

# Reusable Schema

- **State enum群**（`job_status` / `customer_request_status` / `lifecycle_state` / `workflow_state` / `OperationStatus`）: License上可（Apache-2.0のprotoおよびSQL migrations）。TACTへの直接持ち込みは不可（TypeScript型・DB schemaへの翻訳が必要）だが、**「Work/Task/Run/実行slotのstateを1つのenumに混ぜず、entityの階層ごとに別のstate enumを持つ」という設計方針**は、TACTがREADY/RUNNING/WAITING/SUCCEEDED/FAILED/CANCELLEDをどのentity（Task? Run?）に持たせるか設計する際の直接参考になる。
- **`audit_events` テーブル定義**（`tenant_group_id`, `workflow_id`, `request_id`, `event_type`, `actor`, `occurred_at`, `details jsonb`）: License上可。カラム名をConversation/Work/Task/Run idに置き換えるだけで、TACTのAudit Receiptスキーマの叩き台としてほぼそのまま応用できる（ただしSQLそのものはPostgres/Supabase向けに書き直しが必要）。
- **`ApprovalGate` / `InputGate` message型**（`on_approve`/`on_reject`/`timeout_seconds`/`approval_id`/`justification`/`metadata`、および `on_answer`/`on_timeout`/`prompt`）: License上可。TACTのApproval/HumanInteractionのTypeScript型設計における参考スキーマとして有用。

# Reusable Pattern

- **claim-before-execute + lease + bounded attempts**: `AcquireJob`（owner/lease_expires_at更新によるclaim）→ 失敗時 `RequeueJob`（同一job行のattempts+1、上限はSQLのWHERE句で強制）→ 上限到達で恒久失敗、という一連の流れは、TACTが目指す「Work lifecycleをHTTP request lifetimeから切り離す」durable executionの設計において直接参考になる具体的な実装パターン。**retryは同一Run（同一`request_id`）に対するattempt増分であり、新しいRunを作らない**、という設計判断そのものが、TACTのRun/attempt設計を検討する上で重要な実例となる。
- **gate-as-return-value（承認は関数の戻り値として表現され、control planeが強制する）**: operation関数が `AwaitApproval(...)` を返すだけで、実際に「承認が下りるまで次のstepを実行しない」という強制はagentのコードではなくcontrol plane側が担う、という設計。README中の "nothing irreversible runs until the branch it's gated behind does." というコメントは、TACTの「protected writeはApproval付与前に絶対に実行してはならない」という原則と方向性が一致する、具体的な実装先例。
- **2層Policy（Runtime Policy = 実行中のハード制約 / Lifecycle Policy = 事後評価による適応的制御）**: 決定的な実行時制約と、集計metricsに基づく事後的・適応的な制御を明確に分離する設計は、TACTのPolicy/Permission設計における参考パターンになる。ただしBoundFlowのLifecycle Policyがversion rollbackまで自動で行う点はTACTのOptimizer/Brainの権限範囲とは異なるため、パターンとしては参考にしつつ権限範囲はTACT側のルールに従うべき。

# Reusable UX

`docs/console.md` というconsole UIに関するドキュメントの存在をディレクトリ一覧から確認したが、内容の詳細な取得・検証は行っていない（未確認）。API/CLIレベルでは `list_workflows()`・`get_request_info(request_id)`・`list_workflow_runs(id)`・`resolve_interrupted_workflow(id, request_id)` といったstatus/history/recovery系の操作が `docs/api-reference.md` に存在することを確認したが、実際のUI（画面設計・エラー表示・resume UX）そのものは確認できていない。

結論として、確度をもって報告できるReusable UXは **None**（console UIの中身は未検証のため、断定的な記載を避ける）。

# Risks

- **License**: Backend（Apache-2.0）とSDK（MIT）が併存。両方とも許諾範囲は広いが、コピーする場合は元のcopyright/NOTICE表記の保持が必要（Apache-2.0側）。
- **Security**: pre-1.0・公式に "hasn't yet been run in production with external users" と自己申告。第三者による独立監査の有無は未確認。
- **Provider lock-in**: Python SDK coreの依存関係に `anthropic>=0.40` が直接含まれる（`pyproject.toml`）。設計思想としてはprovider中立を志向しているが、reference実装レベルでは単一providerへの実装依存が存在する。
- **Runtime lock-in**: Go + Postgres + gRPC、かつ `server`/`scheduler`/`worker` の3プロセス構成という運用コストが発生する構成。TACTのNext.js/Supabase構成とは前提が異なり、実行基盤としての採用は想定しない。
- **Architecture mismatch**: BoundFlowにはTACTのConversation entityに相当するものが存在しない。また「Work」に相当する概念が独立entity化されておらず、`workflows`（≒Task）に実行状態管理まで同居している。
- **Agent-centric bias**: `agent_state` が `(workflow_id, agent_name)` で管理されるなど、中心はWorkflow/Agentであり、TACTが明示する「中心はAgentではなくWork」という設計思想とは逆方向のバイアスを持つ。パターン単位で参考にするに留め、entity設計をそのまま輸入すべきではない。
- **Overengineering**: workflowレベル・request/Runレベル・job（実行slot）レベル・operationレベル（proto）と、4層それぞれに別のstate enumが存在する構成は、BoundFlowの規模（pre-1.0、6 stars）にしては複雑度が高い。TACTが同等の複雑さを今すぐ必要とするかは別途判断が必要。
- **Scaling concern**: `scheduler_partition_id` によるpartition based pollingという設計はあるが、実運用実績（外部ユーザーでの本番稼働）はまだ無いと自己申告されており、スケール実績としては未検証。
- **Persistence mismatch**: 生Postgres + 手書きSQL migrationsという構成であり、SupabaseのRLS等の機能を前提とした設計ではない（少なくとも確認したmigrationsにRLSに相当する記述は見当たらない）。TACTへの適用にはSupabase流儀への翻訳が必要。
- **Multi-tenant concern**: `tenant_id`/`tenant_group_id` カラムは存在するが、row-level isolationの強制方法（アプリケーション層か、DB層か）は確認できていない（未確認）。
- **Secret handling**: "backendはinference keyに触れない"という設計原則は明言されているが、worker側でのkey保管・rotationの実装コードそのものは確認していない（未確認）。

# Classification

- **State enum設計方針（entity階層ごとに別enumを持つこと）**: ADAPT
- **`audit_events` schema**: ADAPT
- **`ApprovalGate`/`InputGate` schema**: ADAPT
- **claim-before-execute + lease + bounded attempts pattern**: ADAPT（概念のみ。SQL/コードはそのまま使えない）
- **gate-as-return-value（承認は戻り値、強制はcontrol plane側）pattern**: REFERENCE_ONLY（TACTの既存Approval設計と整合するかは別途TACT側で判断が必要なため、概念の参考情報として位置づける）
- **2層Policy（Runtime Policy / Lifecycle Policy）pattern**: REFERENCE_ONLY（Lifecycle Policyの自律的version rollback権限はTACTのOptimizer/Brainルールと衝突するため、そのままの権限設計は不可）
- **ソースコード本体（Go backend / Python SDK）**: REJECT（言語・runtime不一致のため実利なし。ライセンス上の障害はない）
- **Workflow/Agent中心のentity設計**: REJECT（TACTの「中心はWork」という原則と逆方向のため、entity設計としては輸入しない）
- **UX（console等）**: 未検証のため分類保留（判断材料不足）

# Recommendation

## Adopt

- `audit_events` に相当する監査ログschema（tenant/Work/Task/Run id + event_type + actor + occurred_at + details jsonbという最小構成）の設計思想。
- retryを「新しいRunを作る」のではなく「同一Runに対するattempt増分として扱い、上限を書き込み層（DB制約/SQL）で強制する」という設計判断の実例としての参考。
- 「承認は関数の戻り値として表現し、強制はagentコードではなく実行基盤側が担う」というgate-as-return-valueの考え方（TACTの「protected writeはApproval付与前に実行してはならない」という既存原則の裏付け・実装先例として）。
- claim-before-execute + lease renewalによるcrash recoveryパターンの概念（TACTのdurable execution設計時の比較対象として）。

## Do Not Adopt

- BoundFlowのWorkflow/Agent中心のentity構成（Conversation相当entityの不在、Work相当entityの未独立化）。
- Lifecycle Policyがworkflow versionを自律的にrollback／pauseできる権限設計（TACTのOptimizer/Brainの権限範囲を超える）。
- Go/Postgres/gRPCというruntime・実装コードそのもの（言語・stack不一致）。
- Python SDK coreの特定provider（Anthropic）への直接依存という実装方針（TACTのprovider中立性要件と相容れない）。

## Why

BoundFlowは、TACTが目指す方向性（durable execution・approval-gated protected write・audit receipt・HTTP request lifetimeからのWork lifecycle分離）のうちいくつかを独立に実装しており、それらのパターン（claim+lease+bounded attempts、gate-as-return-value、2層policy、階層別state enum）が実際に動く設計として存在することを裏付ける一次情報として価値がある。一方で、BoundFlow自体はWorkflow/Agent中心の設計であり、TACTが明示的に区別するConversation/Work/Task/Runという4層entity構造そのものの先例にはなっていない。またLifecycle PolicyのようにPolicy層が実行そのものを自律的に書き換える権限を持つ点は、TACTが明示的に禁じている設計（Optimizer/BrainがWorkflow/Agent選択を直接書き換えない）と逆方向であるため、パターン単位で選択的に参照すべきであり、アーキテクチャとして丸ごと輸入すべきではない。

## Suggested TACT Phase

`docs/architecture.md`のRoadmapにおける、Task/Run永続化・claim/lease schema設計・Approval gate実行semanticsを扱う将来のdurable execution関連Phase（現時点でPhase番号は未採番。CLAUDE.md「14. 現在地点」に記載のPhase94/95系列とは別系統であり、それらの完了後、TACT自身がRun/attempt永続化とcrash recoveryの実装に着手するタイミングで本ドキュメントを参照することを推奨する）。今回のセッションでコード変更は行っていない（doc-onlyのPrior Art調査）。
