"use client";

import LeftPanel from "./LeftPanel";
import RightPanel from "./RightPanel";
import Sidebar from "./Sidebar";

type Props = {
  messages: any[];

  workflow: any;

  result: any;

  agentOutputs: any;

  thinking: any;

  addMessage: any;

  setWorkflow: any;

  setResult: any;

  setAgentOutputs: any;

  setThinking: any;
};

export default function Workspace({
  messages,
  workflow,
  result,
  agentOutputs,
  thinking,
  addMessage,
  setWorkflow,
  setResult,
  setAgentOutputs,
  setThinking,
}: Props) {

  return (

    <div
      className="
        flex
        h-full
        w-full
        overflow-hidden
        bg-gray-50
      "
    >

      {/* Sidebar */}

      <div
        className="
          h-full
          shrink-0
        "
      >

        <Sidebar />

      </div>


      {/* Main Conversation */}

      <main
        className="
          min-w-0
          flex-1
          bg-white
        "
      >

        <LeftPanel
          messages={messages}
          workflow={workflow}
          addMessage={addMessage}
          setWorkflow={setWorkflow}
          setResult={setResult}
          setAgentOutputs={setAgentOutputs}
          setThinking={setThinking}
        />

      </main>


      {/* AI Team + Output */}

      <aside
        className="
          h-full
          w-[560px]
          shrink-0
          border-l
          border-gray-200
          bg-gray-50
        "
      >

        <RightPanel
          workflow={workflow}
          result={result}
          agentOutputs={agentOutputs}
          thinking={thinking}
        />

      </aside>

    </div>

  );

}