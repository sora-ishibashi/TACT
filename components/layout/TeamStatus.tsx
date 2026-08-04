"use client";

import AgentStatusList from "../workspace/AgentStatusList";

type Props = {
  status?: Record<string, string>;
};

export default function TeamStatus({
  status,
}: Props) {

  const agents = Object.keys(status ?? {});

  const completed =
    agents.filter(
      (agent) =>
        status?.[agent] === "completed"
    ).length;

  const progress =
    agents.length === 0
      ? 0
      : Math.round(
          (completed / agents.length) * 100
        );

  return (

    <div>

      <h2 className="mb-3 text-sm font-semibold text-gray-700">
        AI Team
      </h2>

      <AgentStatusList
        status={status}
      />

      {/* Progress */}

      <div className="mt-5">

        <div className="mb-2 flex items-center justify-between">

          <span className="text-xs text-gray-500">
            Progress
          </span>

          <span className="text-xs font-medium text-gray-700">
            {progress}%
          </span>

        </div>

        <div
          className="
            h-2
            overflow-hidden
            rounded-full
            bg-gray-200
          "
        >

          <div
            className="
              h-full
              rounded-full
              bg-black
              transition-all
              duration-500
            "
            style={{
              width: `${progress}%`,
            }}
          />

        </div>

      </div>

    </div>

  );

}