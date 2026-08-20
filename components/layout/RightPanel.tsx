"use client";

import TeamStatus from "./TeamStatus";
import OutputViewer from "./OutputViewer";
import ThinkingPanel from "../thinking/ThinkingPanel";

type Props = {
  workflow: any;
  result: any;
  agentOutputs: any;
  thinking: any;
  runStatus: "idle" | "running" | "completed" | "error";
  agentTimeline: {
    agent: string;
    status: "running" | "completed" | "failed";
  }[];

  // STEP17: 変更箇所ハイライト対象の章見出し一覧。
  changedHeadings: string[];
};

export default function RightPanel({
  result,
  agentOutputs,
  thinking,
  runStatus,
  agentTimeline,
  changedHeadings,
}: Props) {

  return (

    <div className="flex h-full w-full flex-col bg-gray-50">


      {/* AI Team */}

      <div
        className="
          h-48
          shrink-0
          overflow-y-auto
          border-b
          border-gray-200
          bg-white
          p-3
        "
      >

        <TeamStatus
          runStatus={runStatus}
          agentOutputs={agentOutputs}
          agentTimeline={agentTimeline}
        />

      </div>



      {/* Thinking */}

      {thinking && (

        <div
          className="
            max-h-32
            shrink-0
            overflow-y-auto
            border-b
            border-gray-200
            bg-white
            p-3
          "
        >

          <ThinkingPanel
            agent={thinking.agent}
            message={thinking.message}
          />

        </div>

      )}



      {/* Output */}

      <div
        className="
          min-h-0
          flex-1
          overflow-y-auto
          p-3
        "
      >

        <OutputViewer
          result={result}
          runStatus={runStatus}
          changedHeadings={changedHeadings}
        />

      </div>


    </div>

  );

}
