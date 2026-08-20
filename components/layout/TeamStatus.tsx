"use client";

// STEP14:
// 従来はworkflow.status(Agentごとのstatusマップ)を元に
// AgentStatusListと進捗%バーを表示していたが、Conversationフロー
// (非ストリーミング)ではworkflow.statusが常に空のまま更新されず、
// 「0%のまま固まる」「実行完了後も0%表示が残り続ける」という
// 誤解を招く状態になっていた。
//
// components/workspace/AgentStatusList.tsx はこの変更に伴い
// 呼び出し元がなくなるが、既存ファイルの削除は今回のスコープ外
// のため削除しない。
//
// STEP16-D:
// workflowRun.outputs(TactInterfaceのagentOutputs state)を利用し、
// 「今回のTurnで実際に実行されたAgent」だけを事実ベースで表示する。
//
// STEP17:
// running中は、/api/tact/conversation/streamが実際に発火した
// Agent開始/完了/失敗イベント(TactInterfaceのagentTimeline state)を
// そのまま反映してリアルタイム表示する。固定順序・架空の進捗率・
// 実行時間は一切表示しない。running以外(completed/idle)では、
// STEP16-Dの「実行したAgent」(workflowRun.outputsベースの事後表示)
// を維持する。

// STEP21: エラー発生時も一定時間状態を明示するため"error"を追加。
type RunStatus = "idle" | "running" | "completed" | "error";

type AgentTimelineEntry = {
  agent: string;
  status: "running" | "completed" | "failed";
};

type Props = {
  runStatus: RunStatus;
  agentOutputs?: unknown;
  agentTimeline?: AgentTimelineEntry[];
};

// 既知のAgent IDに対する表示名。
// ここに存在しないIDは、IDそのものを表示する(架空の名前を作らない)。
const AGENT_LABELS: Record<string, string> = {
  planner: "Planner",
  queryBuilder: "QueryBuilder",
  researcher: "Researcher",
  analyst: "Analyst",
  designer: "Designer",
  engineer: "Engineer",
  stakeholder: "Stakeholder",
  reviewer: "Reviewer",
  writer: "Writer",
};

function agentLabel(id: string): string {
  return AGENT_LABELS[id] ?? id;
}

function statusLabel(runStatus: RunStatus) {

  switch (runStatus) {

    case "running":
      return "TACTが作業しています...";

    case "completed":
      return "処理が完了しました";

    case "error":
      return "エラーが発生しました";

    default:
      return "待機中";

  }

}

function statusStyle(runStatus: RunStatus) {

  switch (runStatus) {

    case "running":
      return "border-blue-100 bg-blue-50 text-blue-600";

    case "completed":
      return "border-green-100 bg-green-50 text-green-600";

    case "error":
      return "border-red-100 bg-red-50 text-red-600";

    default:
      return "border-gray-100 bg-gray-50 text-gray-500";

  }

}

function agentEntryIcon(
  status: AgentTimelineEntry["status"]
) {

  if (status === "running") {
    return (
      <span
        className="
          inline-block
          h-2
          w-2
          animate-pulse
          rounded-full
          bg-blue-500
        "
      />
    );
  }

  if (status === "failed") {
    return (
      <span className="text-red-500">✕</span>
    );
  }

  return (
    <span className="text-green-600">✓</span>
  );

}

export default function TeamStatus({
  runStatus,
  agentOutputs,
  agentTimeline = [],
}: Props) {

  // workflowRun.outputsの実際のキーだけを実行済みAgentとして扱う。
  // 固定のAgent一覧を用意して常に表示する、といったことはしない。
  const executedAgents =
    agentOutputs &&
    typeof agentOutputs === "object" &&
    !Array.isArray(agentOutputs)
      ? Object.keys(agentOutputs as Record<string, unknown>)
      : [];

  return (

    <div>

      <h2 className="mb-3 text-sm font-semibold text-gray-700">
        AI Team
      </h2>

      <div
        className={`
          flex
          items-center
          gap-2
          rounded-lg
          border
          px-3
          py-2
          text-sm
          font-medium
          ${statusStyle(runStatus)}
        `}
      >

        {runStatus === "running" && (

          <span
            className="
              inline-block
              h-2
              w-2
              animate-pulse
              rounded-full
              bg-blue-500
            "
          />

        )}

        {runStatus === "error" && (
          <span className="text-red-500">✕</span>
        )}

        {statusLabel(runStatus)}

      </div>

      {/*
        STEP17: running中は、実際に発生したAgentイベントを
        そのまま列挙する(開始順)。イベントが届いていない段階
        (まだagentTimelineが空)では、上の状態表示のみとなる。

        STEP21: error発生直後も、running中と同じagentTimelineを
        そのまま表示し続ける。どのAgentまで進み、どこで失敗したか
        (✕アイコン)が、エラー表示が消えるまでの間そのまま見える
        ようにするため。
      */}

      {(runStatus === "running" || runStatus === "error") &&
        agentTimeline.length > 0 && (

        <div className="mt-3 space-y-1.5">

          {agentTimeline.map((entry) => (

            <div
              key={entry.agent}
              className="
                flex
                items-center
                gap-2
                rounded-lg
                border
                border-gray-100
                bg-white
                px-3
                py-1.5
                text-xs
                text-gray-700
              "
            >

              {agentEntryIcon(entry.status)}

              {agentLabel(entry.agent)}

            </div>

          ))}

        </div>

      )}

      {/*
        running中・error表示中は表示しない。実行中(または直後の
        エラー表示中)の今回Turnと、前回の実行結果(agentOutputsは
        今回Turn失敗時は更新されない)が混在して見えることを
        避けるため。
      */}

      {runStatus !== "running" &&
        runStatus !== "error" &&
        executedAgents.length > 0 && (

        <div className="mt-3 space-y-1.5">

          <p className="text-xs font-medium text-gray-500">
            実行したAgent
          </p>

          {executedAgents.map((id) => (

            <div
              key={id}
              className="
                flex
                items-center
                gap-2
                rounded-lg
                border
                border-gray-100
                bg-white
                px-3
                py-1.5
                text-xs
                text-gray-700
              "
            >

              <span className="text-green-600">
                ✓
              </span>

              {agentLabel(id)}

            </div>

          ))}

        </div>

      )}

    </div>

  );

}
