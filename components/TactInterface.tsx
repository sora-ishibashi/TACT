"use client";

import { useEffect, useRef, useState } from "react";

import Header from "./Header";
import Workspace from "./layout/Workspace";
import ConversationList from "./ConversationList";
import BetaFeedbackCard from "./beta/BetaFeedbackCard";
import { useAuth } from "@/components/auth/AuthProvider";
import type { WorkflowEvent } from "@/core/context/types";
import { diffSections } from "@/core/conversation/mergeWriterOutput";
import {
  loadCompletedConversationIds,
  saveCompletedConversationIds,
  loadSurveyDone,
  saveSurveyDone,
} from "./beta/betaSurveyState";

// STEP30: βアンケートの表示トリガーとなる「独立した成果物」の件数。
const BETA_SURVEY_ARTIFACT_THRESHOLD = 3;

type Message = {
  role: "user" | "tact";
  content: string;
};

// STEP14: Turn実行中〜完了までのUI状態。
// 非ストリーミング構成のため、Agentごとの詳細進捗は表現せず、
// 「実行中/完了/待機」の3状態のみを扱う。
//
// STEP21: エラー発生時に即座にidleへ戻すと、直前まで表示されていた
// Agent実行状況が消え、「何が起きたか分からない」状態になっていた。
// runStatusに"error"を追加し、一定時間だけ失敗状態を明示してから
// idleへ戻すようにする。
type RunStatus = "idle" | "running" | "completed" | "error";

// STEP17: Turn内部で実際に発生したAgentイベントの、
// Agentごとの最新状態。runStatus(Turn全体の状態)とは責務を分け、
// こちらは「今どのAgentがどんな状態か」だけを表す。
type AgentTimelineEntry = {
  agent: string;
  status: "running" | "completed" | "failed";
};

// completed表示を維持する時間(ms)。
// この間だけ「処理が完了した」ことが分かる状態を残し、
// その後はidleへ戻す。
const COMPLETED_DISPLAY_MS = 2000;

// STEP21: error表示を維持する時間(ms)。
// completedより長めに確保し、「何が起きたか分からないまま消える」
// ことを避ける。
const ERROR_DISPLAY_MS = 4000;

export default function TactInterface() {

  // STEP145-G: GET /api/tact/conversationはサーバー側でuserIdによる
  // 所有者チェックを行うようになったため、ログイン済みの場合は
  // Authorization: Bearerヘッダーを付与する(未ログイン時は従来どおり)。
  const { getAccessToken } = useAuth();

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

  // Conversation層との連携用。
  // 同一conversationIdを使い続けることで、
  // currentTask / currentOutput を維持したまま
  // 会話を継続できる。
  const [conversationId, setConversationId] =
    useState<string | null>(null);

  // Conversation一覧オーバーレイの開閉状態(STEP9)。
  const [showConversationList, setShowConversationList] =
    useState(false);

  // STEP24: 空状態の提案ボタン(Conversation)から入力欄(InputBar)へ
  // 叩き台の文章を渡すためだけの表示専用state。自動送信はしない。
  const [suggestedInput, setSuggestedInput] =
    useState<string | null>(null);

  // STEP30: 「3つの独立した成果物」の判定用state。
  // 新しいconversationIdが初めて成功した成果物生成に到達した
  // 時だけ1件追加する(同一conversationIdの部分更新・全体書き直しは
  // 追加しない)。認証機構が未導入のため、ブラウザ内(localStorage)
  // だけで完結させ、サーバー側での集計は行わない。
  // 描画に使わない値(件数の判定にしか使わない)ため、
  // useStateではなくuseRefで保持する。
  const completedConversationIdsRef =
    useRef<Set<string>>(loadCompletedConversationIds());

  // 一度アンケートを閉じた/送信したら、同じブラウザでは
  // 二度と表示しない。
  const [surveyDone, setSurveyDone] =
    useState<boolean>(() => loadSurveyDone());

  const [showBetaSurvey, setShowBetaSurvey] =
    useState(false);

  // STEP14: Turn実行状態。
  const [runStatus, setRunStatus] =
    useState<RunStatus>("idle");

  // STEP17: 今回のTurnで実際に発生したAgentイベントの一覧
  // (開始順)。実際のWorkflowイベントのみから構築し、
  // 固定のAgent順序をハードコードしない。
  const [agentTimeline, setAgentTimeline] =
    useState<AgentTimelineEntry[]>([]);

  // STEP17: 直前のTurn完了時点のresultと、今回のTurn完了時点の
  // resultをクライアント側で比較し、実際に変更・追加された章の
  // 見出し一覧を保持する。DB/APIには一切影響しない、表示専用の
  // 派生state。
  const [changedHeadings, setChangedHeadings] =
    useState<string[]>([]);

  // 直近のresult(前回Turn完了時点のスナップショット)。
  // Conversation切替・新規作成時はリセットする(無関係な
  // Conversation同士を誤って比較しないため)。
  const previousResultRef =
    useRef<unknown>(null);

  // true の間にresultが変化した場合のみ、それを
  // 「Turn完了によるresult更新」とみなして差分計算を行う。
  // (Conversation切替・復元によるsetResultでは差分計算をしない)
  const pendingTurnRef =
    useRef(false);

  // completed -> idleへ戻すためのタイマー。
  // Turn Aのcompletedタイマーが、直後に始まったTurn Bの
  // running状態を後から上書きしてしまわないよう、
  // 新しいTurn開始時・Conversation切替時には必ずクリアする。
  const completedTimerRef =
    useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearCompletedTimer() {

    if (completedTimerRef.current) {

      clearTimeout(completedTimerRef.current);

      completedTimerRef.current = null;

    }

  }

  useEffect(() => {

    return () => {
      clearCompletedTimer();
    };

  }, []);

  // STEP17: resultが変化するたびに、pendingTurnRefが立っている
  // (=直前にTurnがrunning状態になった)場合のみ、その直前の
  // resultとの差分を計算してchangedHeadingsへ反映する。
  // Conversation切替・復元・新規作成時はpendingTurnRefが立って
  // いないため、ここでは何もしない
  // (changedHeadingsのクリアは各ハンドラ側で明示的に行う)。
  useEffect(() => {

    if (pendingTurnRef.current) {

      pendingTurnRef.current = false;

      if (previousResultRef.current && result) {

        const diff = diffSections(
          previousResultRef.current,
          result
        );

        setChangedHeadings([
          ...diff.changedHeadings,
          ...diff.addedHeadings,
        ]);

      } else {

        // 新規Conversation(直前のresultが存在しない)場合は
        // ハイライト対象なし。
        setChangedHeadings([]);

      }

    }

    previousResultRef.current = result;

  }, [result]);

  function handleProcessingChange(
    status: "running" | "completed" | "error"
  ) {

    // 新しい状態遷移が始まる時点で、
    // 前のTurnのcompleted->idleタイマーは必ず無効化する。
    clearCompletedTimer();

    if (status === "running") {

      setRunStatus("running");

      // 新しいTurnの開始時点で、前のTurnのAgentイベント履歴を
      // クリアする(前回の実行中表示が新しいTurnに混ざらないため)。
      setAgentTimeline([]);

      // このTurnの結果でresultが更新されたら差分計算を行う、
      // という予約を立てる。
      pendingTurnRef.current = true;

    } else if (status === "completed") {

      setRunStatus("completed");

      completedTimerRef.current = setTimeout(() => {

        setRunStatus("idle");

        completedTimerRef.current = null;

      }, COMPLETED_DISPLAY_MS);

    } else {

      // STEP21: error発生時も、runningのまま残さないのは従来どおりだが、
      // 即座にidleへ戻すのではなく、一定時間"error"状態を明示する。
      // これにより、直前まで表示されていたAgent実行状況(agentTimeline、
      // 失敗したAgentの✕表示を含む)がそのまま見え続ける。
      setRunStatus("error");

      completedTimerRef.current = setTimeout(() => {

        setRunStatus("idle");

        completedTimerRef.current = null;

      }, ERROR_DISPLAY_MS);

    }

  }

  // STEP17: /api/tact/conversation/streamから中継された、
  // 実際のAgent開始/完了/失敗イベントをそのまま反映する。
  // ここでは架空の進捗や固定順序を作らず、実際に届いたイベント
  // だけをagent単位で最新状態に更新する。
  function handleAgentEvent(
    event: WorkflowEvent
  ) {

    const status: AgentTimelineEntry["status"] =
      event.type === "start"
        ? "running"
        : event.type === "complete"
          ? "completed"
          : "failed";

    setAgentTimeline((prev) => {

      const index =
        prev.findIndex(
          (entry) => entry.agent === event.agent
        );

      if (index === -1) {

        return [
          ...prev,
          { agent: event.agent, status },
        ];

      }

      const next = [...prev];

      next[index] = { agent: event.agent, status };

      return next;

    });

  }

  // STEP24: 提案ボタンが押された時、入力欄へ叩き台の文章を渡すだけ。
  // 送信は行わない(ユーザーが内容を確認・編集してから送信する)。
  function handleSuggestionSelect(text: string) {
    setSuggestedInput(text);
  }

  // STEP30: Workflowが正常完了したTurnごとに呼ばれる。
  // 「このconversationIdで成果物生成が成功したのは初めてか」だけを
  // 判定基準にする。部分更新・全体書き直しは同じconversationIdの
  // ままなので、ここでは重複カウントされない。
  function handleArtifactCompleted(
    completedConversationId: string
  ) {

    if (surveyDone) return;

    const ids = completedConversationIdsRef.current;

    if (ids.has(completedConversationId)) {
      // 既にこのconversationIdで成果物生成が成功済み
      // (=部分更新・全体書き直し等)なので、新規カウントしない。
      return;
    }

    ids.add(completedConversationId);

    saveCompletedConversationIds(ids);

    if (ids.size === BETA_SURVEY_ARTIFACT_THRESHOLD) {
      setShowBetaSurvey(true);
    }

  }

  // STEP30: アンケートを閉じた(送信せず✕を押した)場合も、
  // 送信した場合も、同じブラウザでは二度と表示しないようにする。
  function markSurveyDone() {

    setSurveyDone(true);
    saveSurveyDone();
    setShowBetaSurvey(false);

  }

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

  // 「＋ 新規Conversation」選択時。
  // conversationIdをnullへ戻し、表示stateをクリアするだけで、
  // 既存の「conversationIdなしPOST→新規作成」という
  // 既存フローがそのまま働く。

  function resetForNewConversation() {

    clearCompletedTimer();
    setRunStatus("idle");
    setAgentTimeline([]);

    // STEP17: 別のConversationに切り替えるため、直前のresultとの
    // 差分比較対象・ハイライト状態もリセットする。
    pendingTurnRef.current = false;
    previousResultRef.current = null;
    setChangedHeadings([]);

    setConversationId(null);
    setMessages([]);
    setResult(null);
    setAgentOutputs(null);
    setThinking(null);
    setWorkflow(null);

  }

  // 一覧から既存Conversationを選択した際の復元処理(STEP9)。
  // 既存のGET /api/tact/conversation(単体取得)をそのまま利用する。

  async function handleSelectConversation(
    id: string
  ) {

    clearCompletedTimer();
    setRunStatus("idle");
    setAgentTimeline([]);

    // STEP17: 復元先のConversationは今表示しているものと無関係な
    // 場合があるため、差分比較対象・ハイライト状態をリセットする。
    pendingTurnRef.current = false;
    previousResultRef.current = null;
    setChangedHeadings([]);

    try {

      const accessToken = getAccessToken();

      const response =
        await fetch(
          `/api/tact/conversation?conversationId=${id}`,
          {
            headers: accessToken
              ? { Authorization: `Bearer ${accessToken}` }
              : undefined,
          }
        );

      const data = await response.json();

      if (!data.success) {

        throw new Error(
          data.error ?? "Unknown error"
        );

      }

      const restoredMessages: Message[] = (
        data.conversation.messages ?? []
      ).map(
        (message: {
          role: "user" | "assistant";
          content: string;
        }) => ({
          role:
            message.role === "assistant"
              ? "tact"
              : "user",
          content: message.content,
        })
      );

      setConversationId(data.conversation.id);
      setMessages(restoredMessages);
      setResult(data.conversation.currentOutput);
      setAgentOutputs(null);
      setThinking(null);
      setWorkflow(null);

    } catch (error) {

      console.error(error);

      addMessage(
        "tact",
        "Conversationの復元に失敗しました"
      );

    }

  }

  return (

    <>

      <Header runStatus={runStatus} />

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

        conversationId={conversationId}

        setConversationId={setConversationId}

        onToggleConversationList={() =>
          setShowConversationList((prev) => !prev)
        }

        runStatus={runStatus}

        onProcessingChange={handleProcessingChange}

        agentTimeline={agentTimeline}

        onAgentEvent={handleAgentEvent}

        changedHeadings={changedHeadings}

        suggestedInput={suggestedInput}

        onSuggestionSelect={handleSuggestionSelect}

        onArtifactCompleted={handleArtifactCompleted}

      />

      {showConversationList && (

        <ConversationList
          onClose={() =>
            setShowConversationList(false)
          }
          onSelect={handleSelectConversation}
          onCreateNew={resetForNewConversation}
        />

      )}

      {/*
        STEP30: 3つ目の独立した成果物生成の直後にだけ表示する。
        backdropなしの固定位置カードのため、表示中もチャット・
        成果物の操作はそのまま続けられる。
      */}

      {showBetaSurvey && (

        <BetaFeedbackCard
          conversationId={conversationId}
          onClose={markSurveyDone}
          onSubmitted={markSurveyDone}
        />

      )}

    </>

  );

}
