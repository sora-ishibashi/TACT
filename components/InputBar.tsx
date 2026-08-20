"use client";

import { useEffect, useRef, useState } from "react";

import type { WorkflowEvent } from "@/core/context/types";

import { useAuth } from "@/components/auth/AuthProvider";

// STEP32: ファイル添付1件分のクライアント側状態。
// "ready"になったもの(fileName/mimeType/extractedText)だけが
// core/conversation/types.tsのConversationAttachmentとして
// 送信対象になる。
type AttachedFile = {
  id: string;
  fileName: string;
  mimeType: string;
  extractedText: string;
  status: "uploading" | "ready" | "error";
  error?: string;
};

const ACCEPTED_FILE_EXTENSIONS =
  ".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.webp";

// STEP17: /api/tact/conversation/streamが送るSSEイベントの形。
// 各イベントのdata部分はこのいずれかの形になる。
type StreamEvent =
  | { type: "connected"; conversationId: string }
  | { type: "agentEvent"; event: WorkflowEvent }
  | {
      type: "result";
      success: true;
      conversation: { id: string };
      message?: { content: string };
      currentOutput: unknown;
      workflowRun?: { outputs: unknown };
    }
  | {
      type: "error";
      error: string;
      conversationId?: string;
    };


type Props = {
  addMessage: (
    role: "user" | "tact",
    content: string
  ) => void;

  setWorkflow: (
    workflow: any
  ) => void;

  setResult: (
    result: any
  ) => void;

  setAgentOutputs: (
    outputs: any
  ) => void;

  setThinking: (
    thinking: any
  ) => void;

  conversationId: string | null;

  setConversationId: (
    id: string | null
  ) => void;

  // STEP14: Turnの送信開始/成功/失敗をTactInterfaceへ通知する。
  // 状態(running/completed/idle)の管理自体はTactInterface側の
  // 責務とし、InputBarはライフサイクルの発生タイミングを
  // 伝えるだけに留める。
  onProcessingChange?: (
    status: "running" | "completed" | "error"
  ) => void;

  // STEP17: /api/tact/conversation/streamが実際に発火する
  // Agent開始/完了/失敗イベントをそのままTactInterfaceへ中継する。
  // イベントの生成・解釈はここでは行わない。
  onAgentEvent?: (
    event: WorkflowEvent
  ) => void;

  // STEP24: 空状態の提案ボタンから渡される叩き台の文章。
  // 変化したタイミングで入力欄へ反映するだけで、自動送信はしない。
  prefill?: string | null;

  // STEP30: 実際にWorkflowが正常完了したTurn(workflowRunが存在する
  // =Advisorではなく、失敗でもない)でのみ呼ばれる。βアンケートの
  // 表示条件(3つの独立した成果物)の判定はTactInterface側の責務とし、
  // ここではイベント発生を伝えるだけに留める。
  onArtifactCompleted?: (conversationId: string) => void;
};


export default function InputBar({

  addMessage,

  setWorkflow,

  setResult,

  setAgentOutputs,

  setThinking,

  conversationId,

  setConversationId,

  onProcessingChange,

  onAgentEvent,

  prefill,

  onArtifactCompleted,

}: Props) {


  // STEP132: ログイン済みならAuthorization: Bearerヘッダーを
  // Workflow APIへ添付するために使う。未ログイン時はnullのまま
  // (従来どおり認証ヘッダーなしでリクエストする)。
  const { getAccessToken } = useAuth();

  const [input, setInput] =
    useState("");


  const [loading, setLoading] =
    useState(false);


  const [mode, setMode] =
    useState<
      "quick" | "think" | "deep"
    >("think");


  // STEP32: 添付ファイル(このTurnで送信予定のもの)。
  const [attachedFiles, setAttachedFiles] =
    useState<AttachedFile[]>([]);


  const inputRef =
    useRef<HTMLInputElement | null>(null);

  const fileInputRef =
    useRef<HTMLInputElement | null>(null);


  // STEP24: prefillが(新しい値へ)変化した時だけ、入力欄へ反映する。
  // useEffect内でsetStateを呼ぶと余分な再レンダリングが発生し、
  // また(このプロジェクトのReact Compiler向けlintルールにより)
  // レンダー中のref参照・更新も禁止されているため、Reactが公式に
  // 推奨する「レンダー中にstateで前回値を追跡し、状態を同期する」
  // パターンを使う。送信は行わない。
  const [appliedPrefill, setAppliedPrefill] =
    useState<string | null | undefined>(undefined);

  if (
    prefill &&
    prefill !== appliedPrefill
  ) {

    setAppliedPrefill(prefill);

    setInput(prefill);

  }

  // フォーカスはDOM操作(副作用)のため、こちらはuseEffectのままでよい
  // (setStateを呼ばない)。
  useEffect(() => {

    if (!prefill) return;

    inputRef.current?.focus();

  }, [prefill]);



  // STEP32: 選択された各ファイルを、即座に/api/tact/attachmentsへ
  // アップロードしてテキストを抽出する(送信ボタン押下時ではなく、
  // 選択直後に行う)。複数ファイル選択に対応するため、1ファイルずつ
  // 独立した状態(uploading/ready/error)で管理する。
  async function handleFilesSelected(
    files: FileList | null
  ) {

    if (!files || files.length === 0) return;

    const newEntries: AttachedFile[] = Array.from(files).map(
      (file) => ({
        id: crypto.randomUUID(),
        fileName: file.name,
        mimeType: file.type,
        extractedText: "",
        status: "uploading" as const,
      })
    );

    setAttachedFiles((prev) => [...prev, ...newEntries]);

    Array.from(files).forEach((file, index) => {

      const entryId = newEntries[index].id;

      (async () => {

        try {

          const formData = new FormData();
          formData.append("file", file);

          const response = await fetch(
            "/api/tact/attachments",
            {
              method: "POST",
              body: formData,
            }
          );

          const data = await response.json();

          if (!response.ok || !data.success) {

            setAttachedFiles((prev) =>
              prev.map((f) =>
                f.id === entryId
                  ? {
                      ...f,
                      status: "error",
                      error:
                        data.error ??
                        "ファイルの読み込みに失敗しました",
                    }
                  : f
              )
            );

            return;

          }

          setAttachedFiles((prev) =>
            prev.map((f) =>
              f.id === entryId
                ? {
                    ...f,
                    status: "ready",
                    mimeType: data.mimeType,
                    extractedText: data.extractedText,
                  }
                : f
            )
          );

        } catch (error) {

          console.error(error);

          setAttachedFiles((prev) =>
            prev.map((f) =>
              f.id === entryId
                ? {
                    ...f,
                    status: "error",
                    error: "ファイルの読み込みに失敗しました",
                  }
                : f
            )
          );

        }

      })();

    });

  }

  function removeAttachedFile(id: string) {

    setAttachedFiles((prev) =>
      prev.filter((f) => f.id !== id)
    );

  }


  async function handleSubmit() {


    if (!input.trim()) return;


    const userMessage =
      input;


    addMessage(
      "user",
      userMessage
    );


    setInput("");


    setLoading(true);


    onProcessingChange?.(
      "running"
    );


    setWorkflow({

      status: {},

      logs: [],

      events: [],

    });



    // STEP32: アップロード済み(status==="ready")の添付ファイルのみを
    // 送信対象とする。uploading中/errorのものは送らない
    // (uploading中のまま送信された場合、以降のTurnで再度添付し直す
    // 必要があるが、これはUIの制約として許容する)。
    const readyAttachments = attachedFiles
      .filter((f) => f.status === "ready")
      .map((f) => ({
        fileName: f.fileName,
        mimeType: f.mimeType,
        extractedText: f.extractedText,
      }));


    try {


      // STEP17: /api/tact/conversation(既存の単発POST)ではなく、
      // /api/tact/conversation/stream(新設)を使う。Workflowの実行
      // ロジック・Conversation保存処理は既存と同一で、実際のAgent
      // イベントをリアルタイムに受け取れる点だけが異なる。
      //
      // STEP132: ログイン済みの場合のみAuthorization: Bearerヘッダーを
      // 付与する。未ログイン時はヘッダー自体を付けず、従来どおり
      // 未認証としてWorkflowを実行する(拒否しない、STEP131の方針を
      // 維持)。
      const accessToken =
        getAccessToken();

      const response =
        await fetch(
          "/api/tact/conversation/stream",
          {

            method: "POST",

            headers: {

              "Content-Type":
                "application/json",

              ...(accessToken
                ? {
                    Authorization:
                      `Bearer ${accessToken}`,
                  }
                : {}),

            },

            body: JSON.stringify({

              conversationId:
                conversationId ?? undefined,

              message:
                userMessage,

              mode,

              attachments:
                readyAttachments.length > 0
                  ? readyAttachments
                  : undefined,

            }),

          }
        );


      const reader =
        response.body?.getReader();

      if (!reader) {

        throw new Error(
          "ストリームを読み取れませんでした"
        );

      }


      const decoder =
        new TextDecoder();

      let buffer = "";

      let finalData:
        | Extract<StreamEvent, { type: "result" }>
        | null = null;

      let streamError: string | null = null;


      while (true) {

        const { done, value } =
          await reader.read();

        if (done) break;

        buffer +=
          decoder.decode(
            value,
            { stream: true }
          );


        // SSE形式(`data: {...}\n\n`)を1イベントずつ切り出す。
        const chunks =
          buffer.split("\n\n");

        buffer =
          chunks.pop() ?? "";


        for (const chunk of chunks) {

          if (
            !chunk.startsWith("data:")
          ) {
            continue;
          }

          const jsonText =
            chunk
              .slice(5)
              .trim();

          if (!jsonText) continue;

          let payload: StreamEvent;

          try {
            payload =
              JSON.parse(
                jsonText
              ) as StreamEvent;
          } catch {
            continue;
          }

          if (
            payload.type === "agentEvent"
          ) {

            onAgentEvent?.(
              payload.event
            );

          } else if (
            payload.type === "result"
          ) {

            finalData = payload;

          } else if (
            payload.type === "error"
          ) {

            streamError =
              payload.error ??
                "Unknown error";

          }

        }

      }


      if (streamError) {

        throw new Error(
          streamError
        );

      }

      if (!finalData) {

        throw new Error(
          "結果を取得できませんでした"
        );

      }


      // 同一Conversationを以降のTurnでも使い続ける
      setConversationId(
        finalData.conversation.id
      );


      // currentOutput = 現在の最新成果物
      setResult(
        finalData.currentOutput
      );


      // STEP29: Advisorが応答したTurn(workflowRunがnull)では
      // Workflowが実行されていないため、agentOutputsを更新しない。
      // ここでnullを設定してしまうと、直前の実際のWorkflow実行結果
      // (TeamStatusの「実行したAgent」表示)が、成果物についての
      // 質問をしただけで消えてしまう不整合が生じるため。
      if (finalData.workflowRun) {

        setAgentOutputs(
          finalData.workflowRun.outputs
        );

        // STEP30: 実際にWorkflowが正常完了したTurnでのみ通知する
        // (AdvisorのターンはfinalData.workflowRunがnullのため、
        // ここには到達しない。失敗したTurnはstreamError経由で
        // throwされ、この行より前でエラー処理へ抜けるためこれも
        // 到達しない)。
        onArtifactCompleted?.(
          finalData.conversation.id
        );

      }


      if (finalData.message?.content) {

        addMessage(
          "tact",
          finalData.message.content
        );

      }


      onProcessingChange?.(
        "completed"
      );


      // STEP32: 送信に成功した添付ファイルはクリアする
      // (次のTurnへ引き継ぐ必要がある内容は、既にEvidence化されて
      // seedEvidence/Evidenceスナップショット経由で永続化されるため、
      // クライアント側で保持し続ける必要はない)。
      setAttachedFiles([]);


    } catch(error){


      console.error(
        error
      );


      addMessage(

        "tact",

        "TACTとの通信に失敗しました"

      );


      onProcessingChange?.(
        "error"
      );


    } finally {


      setLoading(false);


    }


  }



  return (

<div className="border-t border-gray-200 bg-white px-4 py-2">


      <div className="mx-auto max-w-4xl">



        {/* Mode Selector */}


<div className="mb-2 flex gap-2">

          {[
            "quick",
            "think",
            "deep",
          ].map((m)=>(


            <button

              key={m}

              onClick={()=>setMode(
                m as
                | "quick"
                | "think"
                | "deep"
              )}

              className={`
rounded-full px-3 py-1.5 text-xs
                ${
                  mode === m
                    ? "bg-black text-white"
                    : "bg-gray-100 hover:bg-gray-200"
                }
              `}

            >

              {m.toUpperCase()}


            </button>


          ))}


        </div>



        {/* STEP32: 添付ファイル一覧 */}

        {attachedFiles.length > 0 && (

          <div className="mb-2 flex flex-wrap gap-2">

            {attachedFiles.map((f) => (

              <div
                key={f.id}
                className={`
                  flex items-center gap-2 rounded-full border px-3 py-1 text-xs
                  ${
                    f.status === "error"
                      ? "border-red-300 bg-red-50 text-red-700"
                      : "border-gray-300 bg-gray-50 text-gray-700"
                  }
                `}
              >

                <span className="max-w-[160px] truncate">
                  {f.fileName}
                </span>

                {f.status === "uploading" && (
                  <span className="text-gray-400">読み込み中...</span>
                )}

                {f.status === "error" && (
                  <span title={f.error}>読み込み失敗</span>
                )}

                <button
                  type="button"
                  onClick={() => removeAttachedFile(f.id)}
                  className="text-gray-400 hover:text-gray-700"
                  aria-label={`${f.fileName}を削除`}
                >
                  ×
                </button>

              </div>

            ))}

          </div>

        )}


        {/* Input */}


        <div className="flex items-center gap-4 rounded-xl border border-gray-300 bg-white px-4 py-2 shadow-sm">



          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_FILE_EXTENSIONS}
            className="hidden"
            onChange={(e) => {
              handleFilesSelected(e.target.files);
              e.target.value = "";
            }}
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-100"
          >
            ファイルを追加
          </button>


          <input


            ref={inputRef}


            value={input}


            onChange={(e)=>
              setInput(
                e.target.value
              )
            }


            onKeyDown={(e)=>{

              if(
                e.key === "Enter"
              ){

                handleSubmit();

              }

            }}


            type="text"


            placeholder="やりたいことを入力してください..."


            className="flex-1 bg-transparent text-gray-900 outline-none placeholder:text-gray-400"


          />




          <button


            onClick={
              handleSubmit
            }


            disabled={
              loading
            }


            className="rounded-lg bg-black px-4 py-2 text-white transition hover:bg-gray-800 disabled:opacity-50"


          >


            {loading

              ? "実行中..."

              : "送信"

            }


          </button>



        </div>


      </div>


    </div>

  );

}
