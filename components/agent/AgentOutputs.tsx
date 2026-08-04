"use client";

import AgentCard from "../AgentCard";

type Props = {
  outputs: Record<string, any>;
};

const providers: Record<string, string> = {
  planner: "openai",
  researcher: "gemini",
  designer: "gemini",
  engineer: "claude",
  stakeholder: "openai",
  reviewer: "openai",
  writer: "claude",
};

const tasks: Record<string, string> = {
  planner: "実行計画を作成",
  researcher: "情報を調査",
  designer: "UIを設計",
  engineer: "実装を作成",
  stakeholder: "利用者視点を確認",
  reviewer: "品質をレビュー",
  writer: "最終成果物を作成",
};

export default function AgentOutputs({
  outputs,
}: Props) {

  if (!outputs) return null;

  const order = [
    "planner",
    "researcher",
    "designer",
    "engineer",
    "stakeholder",
    "reviewer",
    "writer",
  ];

  return (

    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">

      <h2 className="mb-6 text-xl font-bold">
        Agent Outputs
      </h2>

      <div className="space-y-4">

        {order.map((agent) => {

          if (!outputs[agent]) return null;

          return (

            <AgentCard
              key={agent}
              name={agent}
              provider={providers[agent]}
              task={tasks[agent]}
              output={outputs[agent]}
            />

          );

        })}

      </div>

    </div>

  );

}