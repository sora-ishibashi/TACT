"use client";

import WorkflowTimeline from "../workflow/WorkflowTimeline";

type Props = {
  logs?: any[];
};

export default function ActivityLog({
  logs,
}: Props) {

  return (

    <div className="flex h-full flex-col">

      {/* Header */}

      <div className="border-b border-gray-200 px-5 py-4">

        <h2 className="text-lg font-semibold">
          Activity Log
        </h2>

      </div>

      {/* Timeline */}

      <div className="flex-1 overflow-y-auto p-5">

        {logs && logs.length > 0 ? (

          <WorkflowTimeline
            logs={logs}
          />

        ) : (

          <div className="flex h-full items-center justify-center text-sm text-gray-400">

            実行ログはまだありません

          </div>

        )}

      </div>

    </div>

  );

}