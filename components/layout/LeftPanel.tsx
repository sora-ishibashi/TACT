"use client";

import Conversation from "../Conversation";
import InputBar from "../InputBar";

type Props = {
  messages: any[];

  workflow: any;

  addMessage: any;

  setWorkflow: any;

  setResult: any;

  setAgentOutputs: any;

  setThinking: any;
};

export default function LeftPanel({
  messages,
  workflow,
  addMessage,
  setWorkflow,
  setResult,
  setAgentOutputs,
  setThinking,
}: Props) {

  return (

    <div className="flex h-full w-full flex-col bg-white">

      {/* Conversation */}

      <div className="min-h-0 flex-1 overflow-y-auto">

        <Conversation
          messages={messages}
          workflow={workflow}
        />

      </div>

      {/* Input */}

      <div className="shrink-0 border-t border-gray-200 bg-white px-4 py-3">

        <InputBar
          addMessage={addMessage}
          setWorkflow={setWorkflow}
          setResult={setResult}
          setAgentOutputs={setAgentOutputs}
          setThinking={setThinking}
        />

      </div>

    </div>

  );

}