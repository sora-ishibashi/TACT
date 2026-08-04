"use client";

import { useState } from "react";

import Workspace from "./layout/Workspace";

type Message = {
  role: "user" | "tact";
  content: string;
};

export default function TactInterface() {

  const [messages, setMessages] =
    useState<Message[]>([]);

  const [workflow, setWorkflow] =
    useState<any>(null);

  const [result, setResult] =
    useState<any>(null);

  const [agentOutputs, setAgentOutputs] =
    useState<any>(null);

  const [thinking, setThinking] =
    useState<any>(null);

  function addMessage(
    role: "user" | "tact",
    content: string
  ) {

    setMessages((prev) => [
      ...prev,
      {
        role,
        content,
      },
    ]);

  }

  return (

    <Workspace

      messages={messages}

      workflow={workflow}

      result={result}

      agentOutputs={agentOutputs}

      thinking={thinking}

      addMessage={addMessage}

      setWorkflow={setWorkflow}

      setResult={setResult}

      setAgentOutputs={setAgentOutputs}

      setThinking={setThinking}

    />

  );

}