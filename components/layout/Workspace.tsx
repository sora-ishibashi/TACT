"use client";

import LeftPanel from "./LeftPanel";
import RightPanel from "./RightPanel";
import Sidebar from "./Sidebar";
import type { WorkflowEvent } from "@/core/context/types";

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

  conversationId: string | null;

  setConversationId: (id: string | null) => void;

  onToggleConversationList?: () => void;

  runStatus: "idle" | "running" | "completed" | "error";

  onProcessingChange: (
    status: "running" | "completed" | "error"
  ) => void;

  agentTimeline: {
    agent: string;
    status: "running" | "completed" | "failed";
  }[];

  onAgentEvent: (event: WorkflowEvent) => void;

  // STEP17: 直前のTurnから今回のTurnで実際に変更・追加された
  // 章見出し一覧(表示のハイライト専用、DB/APIには関与しない)。
  changedHeadings: string[];

  // STEP24: 空状態の提案ボタンから入力欄への橋渡し。
  suggestedInput?: string | null;

  onSuggestionSelect?: (text: string) => void;

  // STEP30: βアンケートの表示条件判定用。
  onArtifactCompleted?: (conversationId: string) => void;
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
  conversationId,
  setConversationId,
  onToggleConversationList,
  runStatus,
  onProcessingChange,
  agentTimeline,
  onAgentEvent,
  changedHeadings,
  suggestedInput,
  onSuggestionSelect,
  onArtifactCompleted,
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

        <Sidebar
          onToggleConversationList={onToggleConversationList}
        />

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
          conversationId={conversationId}
          setConversationId={setConversationId}
          runStatus={runStatus}
          onProcessingChange={onProcessingChange}
          onAgentEvent={onAgentEvent}
          suggestedInput={suggestedInput}
          onSuggestionSelect={onSuggestionSelect}
          onArtifactCompleted={onArtifactCompleted}
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
          runStatus={runStatus}
          agentTimeline={agentTimeline}
          changedHeadings={changedHeadings}
        />

      </aside>

    </div>

  );

}