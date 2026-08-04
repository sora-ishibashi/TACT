"use client";

type Log = {
  agent: string;
  message: string;
  timestamp: number;
};

type Props = {
  logs: Log[];
};

const icons: Record<string, string> = {
  planner: "🧠",
  researcher: "🔍",
  designer: "🎨",
  engineer: "💻",
  stakeholder: "👥",
  reviewer: "✅",
  writer: "✍️",
};

export default function WorkflowTimeline({
  logs,
}: Props) {

  if (!logs.length) return null;

  return (

    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">

      <h2 className="mb-6 text-xl font-bold">
        Workflow Timeline
      </h2>

      <div className="space-y-6">

        {logs.map((log, index) => (

          <div
            key={index}
            className="flex items-start gap-4"
          >

            {/* アイコン */}

            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 text-xl">

              {icons[log.agent] ?? "🤖"}

            </div>

            {/* 縦線 */}

            <div className="flex flex-col items-center">

              <div className="h-12 w-px bg-gray-300" />

            </div>

            {/* 内容 */}

            <div className="flex-1">

              <div className="flex items-center gap-3">

                <span className="font-semibold capitalize">
                  {log.agent}
                </span>

                <span className="rounded-full bg-green-100 px-2 py-1 text-xs text-green-700">

                  {log.message}

                </span>

              </div>

              <p className="mt-2 text-sm text-gray-500">

                {new Date(
                  log.timestamp
                ).toLocaleTimeString()}

              </p>

            </div>

          </div>

        ))}

      </div>

    </div>

  );

}