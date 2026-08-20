"use client";

import Conversation from "../Conversation";
import InputBar from "../InputBar";
import type { WorkflowEvent } from "@/core/context/types";

type Props = {
  messages: any[];

  workflow: any;

  addMessage: any;

  setWorkflow: any;

  setResult: any;

  setAgentOutputs: any;

  setThinking: any;

  conversationId: string | null;

  setConversationId: (id: string | null) => void;

  runStatus: "idle" | "running" | "completed" | "error";

  onProcessingChange: (
    status: "running" | "completed" | "error"
  ) => void;

  onAgentEvent: (event: WorkflowEvent) => void;

  // STEP24: 空状態の提案ボタン(Conversation)から入力欄(InputBar)へ
  // 叩き台の文章を渡すための最小限の橋渡し。
  suggestedInput?: string | null;

  onSuggestionSelect?: (text: string) => void;

  // STEP30: Workflowが正常完了したTurnをTactInterfaceへ中継する
  // (βアンケートの表示条件判定に使う)。
  onArtifactCompleted?: (conversationId: string) => void;
};

export default function LeftPanel({
  messages,
  addMessage,
  setWorkflow,
  setResult,
  setAgentOutputs,
  setThinking,
  conversationId,
  setConversationId,
  runStatus,
  onProcessingChange,
  onAgentEvent,
  suggestedInput,
  onSuggestionSelect,
  onArtifactCompleted,
}: Props) {

  return (

    <div className="flex h-full w-full flex-col bg-white">

      {/* Conversation */}

      <div className="min-h-0 flex-1 overflow-y-auto">

        <Conversation
          messages={messages}
          runStatus={runStatus}
          onSuggestionSelect={onSuggestionSelect}
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
          conversationId={conversationId}
          setConversationId={setConversationId}
          onProcessingChange={onProcessingChange}
          onAgentEvent={onAgentEvent}
          prefill={suggestedInput}
          onArtifactCompleted={onArtifactCompleted}
        />

      </div>

    </div>

  );

}
