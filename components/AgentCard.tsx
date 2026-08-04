"use client";

import { useState } from "react";

type Props = {
  name: string;
  provider: string;
  task: string;
  output: any;
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

const providerColor: Record<string, string> = {
  openai: "bg-green-100 text-green-700",
  claude: "bg-orange-100 text-orange-700",
  gemini: "bg-blue-100 text-blue-700",
  grok: "bg-purple-100 text-purple-700",
};

export default function AgentCard({
  name,
  provider,
  task,
  output,
}: Props) {

  const [open, setOpen] =
    useState(false);

  return (

    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm">

      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between p-5 text-left transition hover:bg-gray-50"
      >

        <div className="flex items-center gap-4">

          <span className="text-2xl">
            {icons[name] ?? "🤖"}
          </span>

          <div>

            <div className="flex items-center gap-2">

              <span className="text-lg font-semibold capitalize">
                {name}
              </span>

              <span
                className={`rounded-full px-2 py-1 text-xs font-medium ${
                  providerColor[provider] ??
                  "bg-gray-100 text-gray-600"
                }`}
              >
                {provider}
              </span>

            </div>

            <p className="mt-1 text-sm text-gray-500">
              {task}
            </p>

          </div>

        </div>

        <span className="text-gray-400">
          {open ? "▲" : "▼"}
        </span>

      </button>

      {open && (

        <div className="border-t border-gray-100 bg-gray-50 p-5">

          <div className="space-y-4">

            {name === "planner" && (

              <>

                <div>

                  <p className="text-xs font-semibold text-gray-500">
                    GOAL
                  </p>

                  <p className="mt-1">
                    {output.goal}
                  </p>

                </div>

                <div>

                  <p className="text-xs font-semibold text-gray-500">
                    REASON
                  </p>

                  <p className="mt-1">
                    {output.reason}
                  </p>

                </div>

                <div>

                  <p className="text-xs font-semibold text-gray-500">
                    PLAN
                  </p>

                  <ul className="mt-2 space-y-2">

                    {output.plan?.map(
                      (
                        step: any,
                        index: number
                      ) => (

                        <li
                          key={index}
                          className="rounded-lg bg-white p-3"
                        >
                          <span className="font-medium capitalize">
                            {step.agent}
                          </span>

                          {" → "}

                          {step.task}

                        </li>

                      )
                    )}

                  </ul>

                </div>

              </>

            )}

            {name !== "planner" && (

              <div className="space-y-3">

                {Object.entries(output).map(
                  ([key, value]) => (

                    <div key={key}>

                      <p className="text-xs font-semibold uppercase text-gray-500">
                        {key}
                      </p>

                      <div className="mt-1 whitespace-pre-wrap text-sm text-gray-700">

                        {typeof value === "object"
                          ? JSON.stringify(value, null, 2)
                          : String(value)}

                      </div>

                    </div>

                  )
                )}

              </div>

            )}

          </div>

        </div>

      )}

    </div>

  );

}