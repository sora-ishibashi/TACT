"use client";

// =========================
// ResearchPanel (STEP202、STEP213でDirect Pushタブを追加)
// =========================
//
// TACT Research(POST /api/tact/research → runResearch())を、旧TACT
// UIの既存Turn/Conversation状態機械(TactInterface/InputBar/Workspace、
// runStatus・agentTimeline・conversationId永続化)とは完全に独立した、
// 自己完結の最小パネルとして接続する。
//
// STEP202絶対条件5(UI全面再設計禁止)・STEP202-Kより: 既存の
// InputBar.tsx/Workspace.tsxはconversationId・agentTimeline・
// runStatus等、Research(単発・ConversationId無し・Agent Timeline無し)
// とは無関係な複雑な状態機械と密結合している。ここへResearchを
// 無理に混ぜ込むと、既存のTurn実行フローを壊すリスクが高い。
// そのため、STEP202-K「必要最小限のUI state管理ファイル」として
// このファイル1つを新設し、TactInterface.tsxからは開閉トグルの
// 配線のみを追加する(絶対条件19「変更は最小限に」)。
//
// STEP213: Direct Push(POST /api/tact/core/push → recordKnowledge/
// Memory/Example)をこの同じパネル内の別タブとして追加した。新規の
// 独立コンポーネント・新規フローティングボタンを増やすのではなく、
// 「既存の入力・出力領域を優先して再利用する」(STEP213-C)方針に従い、
// 既にあるこのパネルの枠(ヘッダー・閉じるボタン・配置)をそのまま
// 使い、タブ切り替えで中身だけを差し替える。これにより、
// Research→Push→Researchという一連の確認(STEP213-E)を、パネルの
// 開閉なしに同じ場所で行える。
//
// 責務(STEP202-E/STEP213-G): 入力 → API呼び出し(1回) → 状態管理 →
// 結果表示、だけを行う。Search/LLM呼び出し・Requirement Decomposition・
// Knowledge Gap・Safety判定・Evidence選定・Evidence ID生成・Retry・
// 結果の再評価・Supabaseへの直接INSERTは一切行わない(すべて既存
// API/CoreCapability側の責務)。
//
// Evidence ID・snippetはAPIから返された値をそのまま表示するだけで、
// UI側で生成・変更・要約し直すことはしない。
//
// Phase46: Clarification UX(Option B)のための第3タブ「Orchestrate」を
// 同じ枠へ追加した。POST /api/tact/orchestrate(Phase33、無変更)→
// runOrchestration()を呼ぶ。Clarificationが返ってきた場合は、UI側が
// 保持するoriginalInputと回答を結合し(components/orchestrateClarification.ts、
// 絶対条件Rule2/Rule6: 新しいAPI schemaは作らず、既存のinput: stringの
// ままpayloadを組み立てる)、同じ/api/tact/orchestrateへ再送信するだけで
// Option Bを実現する(絶対条件Rule1/Rule3: Clarification専用の新しい
// 実行経路は作らない)。TactInterface.tsx(Legacy WorkflowのTurn/
// Conversation状態機械)には一切触れていない(STEP202の判断をそのまま
// 踏襲: 複雑な既存状態機械へ無理に混ぜ込まず、この独立パネルの中で
// 完結させる)。/api/tact/orchestrateは認証必須(Phase33)のため、
// TactInterface.tsxが既に使っているuseAuth().getAccessToken()
// (STEP145-G以来の既存パターン)をこのタブの呼び出しにのみ付与する
// (research/pushタブは従来どおり未認証のまま、無変更)。

import { useState } from "react";

import type {
  ResearchResult,
  ResearchEvidenceItem,
} from "@/core/tact-research/types";
import type { OrchestrationResult } from "@/core/tact-orchestrator/types";
import { useAuth } from "@/components/auth/AuthProvider";
import { buildClarificationResendInput } from "./orchestrateClarification";

type PanelTab = "research" | "push" | "orchestrate";

type PanelStatus = "idle" | "loading" | "success" | "failure";

// APIレベルのエラー(HTTP 400/500、ネットワーク失敗、JSON parse失敗等)。
// ResearchResult.success===falseというResearch内部の判別可能な失敗
// (STEP184〜)とは明確に区別する(STEP202-F)。
type ApiError = {
  message: string;
};

type Props = {
  onClose: () => void;
};

function ConfidenceBadge({
  confidence,
}: {
  confidence: ResearchEvidenceItem["confidence"];
}) {

  const colorClass =
    confidence === "high"
      ? "bg-green-100 text-green-700"
      : confidence === "medium"
        ? "bg-yellow-100 text-yellow-700"
        : "bg-gray-100 text-gray-600";

  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colorClass}`}
    >
      {confidence}
    </span>
  );
}

function EvidenceItemView({
  item,
}: {
  item: ResearchEvidenceItem;
}) {

  return (
    <li className="rounded-lg border border-gray-200 p-3 text-sm">

      <div className="flex items-start justify-between gap-2">

        <p className="font-medium text-gray-900">
          {item.claim}
        </p>

        <ConfidenceBadge confidence={item.confidence} />

      </div>

      {item.snippet && (
        <p className="mt-1 text-xs text-gray-500">
          {item.snippet}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">

        {item.source && (
          <a
            href={item.source}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline"
          >
            {item.source}
          </a>
        )}

        {/* STEP202-D: Evidence IDは通常表示の邪魔にならないよう
            <details>で折りたたむ。APIが返したidをそのまま表示するだけ
            (UI側で生成・変更しない)。 */}
        <details className="text-gray-400">
          <summary className="cursor-pointer select-none">
            evidence id
          </summary>
          <code className="break-all">{item.id}</code>
        </details>

      </div>

    </li>
  );

}

// STEP213: Direct Pushの3種類。UI側では自動分類しない
// (STEP212絶対条件、STEP213-D)。
type PushType = "knowledge" | "memory" | "example";

const PUSH_TYPES: readonly PushType[] = ["knowledge", "memory", "example"];

type PushResultState = {
  success: boolean;
  type?: PushType;
  itemId?: string;
  message?: string;
};

export default function ResearchPanel({
  onClose,
}: Props) {

  // Phase46: /api/tact/orchestrateは認証必須のため、Orchestrateタブの
  // 呼び出しにのみ使う(research/pushタブは従来どおり未認証のまま)。
  const { getAccessToken } = useAuth();

  const [tab, setTab] =
    useState<PanelTab>("research");

  const [query, setQuery] =
    useState("");

  const [status, setStatus] =
    useState<PanelStatus>("idle");

  const [result, setResult] =
    useState<ResearchResult | null>(null);

  const [apiError, setApiError] =
    useState<ApiError | null>(null);

  // STEP213: Direct Push用のstate。Research側のstate
  // (query/status/result/apiError)とは完全に分離する
  // (タブを切り替えても互いの入力・結果を消さないため)。
  const [pushContent, setPushContent] =
    useState("");

  const [pushType, setPushType] =
    useState<PushType>("knowledge");

  const [pushStatus, setPushStatus] =
    useState<PanelStatus>("idle");

  const [pushResult, setPushResult] =
    useState<PushResultState | null>(null);

  // Phase46: Orchestrate tab用のstate。research/pushタブのstateとは
  // 完全に分離する(タブを切り替えても互いの入力・結果を消さないため、
  // 既存2タブと同じ方針)。
  const [orchestrateInput, setOrchestrateInput] =
    useState("");

  const [orchestrateStatus, setOrchestrateStatus] =
    useState<PanelStatus>("idle");

  const [orchestrateResult, setOrchestrateResult] =
    useState<OrchestrationResult | null>(null);

  const [orchestrateApiError, setOrchestrateApiError] =
    useState<ApiError | null>(null);

  // Phase46 Rule2: Clarification発生時、元のユーザー入力(originalInput)
  // をここへ保持する。二重Clarification(絶対条件セクション6)が発生
  // した場合も、常に最初のoriginalInputを保持し続ける(結合済みの
  // 再送信文字列で上書きしない)ことで、何度Clarificationが往復しても
  // 元の依頼が失われないようにする。
  const [pendingClarification, setPendingClarification] =
    useState<{ originalInput: string; question: string } | null>(null);

  const [clarificationAnswer, setClarificationAnswer] =
    useState("");

  async function handlePushSubmit() {

    // STEP212 Case H相当: 空入力ではAPIを呼び出さない。
    if (!pushContent.trim()) {
      return;
    }

    setPushStatus("loading");
    setPushResult(null);

    try {

      // STEP213-G: UI側でSupabaseへ直接INSERTしない。既存の
      // Direct Push API(STEP212、無変更)を1回だけ呼び出す。
      const response = await fetch("/api/tact/core/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: pushContent, type: pushType }),
      });

      const body = await response.json();

      if (!response.ok || !body.success) {

        setPushResult({
          success: false,
          message:
            typeof body.error === "string"
              ? body.error
              : `Pushに失敗しました(HTTP ${response.status})`,
        });

        setPushStatus("failure");

        return;

      }

      setPushResult({
        success: true,
        type: body.type,
        itemId: body.item?.id,
      });

      setPushStatus("success");

      // STEP212で保存されたcontentはそのまま(削除・変更しない)。
      // 入力欄だけクリアして、続けて別の内容をPushしやすくする。
      setPushContent("");

    } catch (error) {

      console.error(
        "TACT Core Push API call failed:",
        error
      );

      setPushResult({
        success: false,
        message: "TACT Coreとの通信に失敗しました",
      });

      setPushStatus("failure");

    }

  }

  async function handleSubmit() {

    // STEP202-L Case B: 空入力ではAPIを呼び出さない。
    if (!query.trim()) {
      return;
    }

    setStatus("loading");
    setResult(null);
    setApiError(null);

    try {

      // STEP202-B: 既存Research API(STEP201で作成、無変更)を
      // 1回だけ呼び出す。UI側でSearch/LLMを直接呼ばない。
      const response = await fetch("/api/tact/research", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      });

      const body = await response.json();

      if (!response.ok) {

        // STEP202-F: HTTP 400/500はAPIレベルのエラーとして扱う
        // (ResearchResult.success===falseとは区別する)。
        setApiError({
          message:
            typeof body.error === "string"
              ? body.error
              : `リクエストに失敗しました(HTTP ${response.status})`,
        });

        setStatus("failure");

        return;

      }

      // HTTP 200。body自体がResearchResult(success/answer/evidence/
      // metadata/errorMessage)。加工せずそのまま保持する(STEP202-G)。
      const researchResult = body as ResearchResult;

      setResult(researchResult);

      setStatus(
        researchResult.success ? "success" : "failure"
      );

    } catch (error) {

      console.error(
        "TACT Research API call failed:",
        error
      );

      setApiError({
        message: "TACT Researchとの通信に失敗しました",
      });

      setStatus("failure");

    }

  }

  // Phase46 Rule1/Rule3: Clarification専用の実行経路は作らず、既存の
  // /api/tact/orchestrate(Phase33、無変更)を毎回同じ形で呼ぶだけの
  // 単一の送信関数。初回送信・Clarification回答後の再送信のどちらも
  // ここを通る(絶対条件Rule7: 新しいstate machineを作らない)。
  //
  // originalInputForClarification: 万一この呼び出しの結果が再び
  // Clarificationだった場合(二重Clarification)に、pendingClarification
  // へ保持すべき「元の依頼」。初回送信時は今回の入力そのもの、
  // 回答再送信時は直前のpendingClarification.originalInputを
  // そのまま引き継ぐ(呼び出し元が渡す)。
  async function submitOrchestrate(
    input: string,
    originalInputForClarification: string
  ) {

    setOrchestrateStatus("loading");
    setOrchestrateApiError(null);

    try {

      const accessToken = getAccessToken();

      // Phase46: /api/tact/orchestrateは認証必須(Phase33絶対条件2)。
      // 既存のTactInterface.tsxと同じ、Authorization: Bearerヘッダーを
      // 付与するパターンをそのまま再利用する(新しい認証方式は作らない)。
      const response = await fetch("/api/tact/orchestrate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken
            ? { Authorization: `Bearer ${accessToken}` }
            : {}),
        },
        body: JSON.stringify({ input }),
      });

      const body = await response.json();

      if (!response.ok) {

        // Phase46 Section7: 通常のAPIエラーUIをそのまま使う。
        // Clarification待ち状態(pendingClarification)はここでは
        // クリアしない(絶対条件: エラー時もoriginalInputを失わず、
        // ユーザーが同じ回答で再試行できるようにするため)。
        setOrchestrateApiError({
          message:
            typeof body.error === "string"
              ? body.error
              : `リクエストに失敗しました(HTTP ${response.status})`,
        });

        setOrchestrateStatus("failure");

        return;

      }

      const orchestrationResult = body as OrchestrationResult;

      if (orchestrationResult.clarification) {

        // Phase46 Section6: 二重Clarificationが発生した場合も、新しい
        // 高度な機構(ループ防止等)は作らず、既存のOrchestration挙動
        // (detectAmbiguity()の判定結果)をそのまま尊重して次の質問を
        // 表示するだけに留める。
        setPendingClarification({
          originalInput: originalInputForClarification,
          question: orchestrationResult.clarification.question,
        });

        setClarificationAnswer("");
        setOrchestrateResult(null);
        setOrchestrateStatus("idle");

        return;

      }

      // Phase46 Section5: Clarification専用の結果画面は作らず、通常の
      // Orchestration結果表示(このタブの既存result表示)をそのまま使う。
      setPendingClarification(null);
      setOrchestrateResult(orchestrationResult);
      setOrchestrateStatus("success");

    } catch (error) {

      console.error(
        "TACT Orchestrate API call failed:",
        error
      );

      setOrchestrateApiError({
        message: "TACT Orchestratorとの通信に失敗しました",
      });

      setOrchestrateStatus("failure");

    }

  }

  async function handleOrchestrateSubmit() {

    if (!orchestrateInput.trim()) {
      return;
    }

    await submitOrchestrate(orchestrateInput, orchestrateInput);

  }

  // Phase46 Rule2: 元入力(pendingClarification.originalInput)と
  // Clarification回答を結合し(components/orchestrateClarification.ts、
  // 新しいAPI schemaは作らない)、既存の/api/tact/orchestrateへ
  // 同じ形(input: stringのみ)で再送信する。
  async function handleClarificationAnswerSubmit() {

    if (!pendingClarification || !clarificationAnswer.trim()) {
      return;
    }

    const resendInput = buildClarificationResendInput(
      pendingClarification.originalInput,
      pendingClarification.question,
      clarificationAnswer
    );

    await submitOrchestrate(
      resendInput,
      pendingClarification.originalInput
    );

  }

  return (

    <div className="fixed bottom-24 right-6 z-40 flex max-h-[70vh] w-[420px] flex-col rounded-xl border border-gray-200 bg-white shadow-xl">

      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">

        <h3 className="text-sm font-semibold text-gray-900">
          TACT Dev Panel
        </h3>

        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700"
          aria-label="パネルを閉じる"
        >
          ×
        </button>

      </div>

      {/* STEP213: Research / Direct Pushのタブ切り替え。
          パネルの枠(ヘッダー・配置)は共有し、中身だけを切り替える。 */}
      <div className="flex border-b border-gray-200 px-4">

        <button
          type="button"
          onClick={() => setTab("research")}
          className={`border-b-2 px-2 py-2 text-xs font-medium ${
            tab === "research"
              ? "border-black text-gray-900"
              : "border-transparent text-gray-400 hover:text-gray-600"
          }`}
        >
          Research
        </button>

        <button
          type="button"
          onClick={() => setTab("push")}
          className={`border-b-2 px-2 py-2 text-xs font-medium ${
            tab === "push"
              ? "border-black text-gray-900"
              : "border-transparent text-gray-400 hover:text-gray-600"
          }`}
        >
          Direct Push
        </button>

        {/* Phase46: Clarification UX(Option B)確認用の第3タブ。 */}
        <button
          type="button"
          onClick={() => setTab("orchestrate")}
          className={`border-b-2 px-2 py-2 text-xs font-medium ${
            tab === "orchestrate"
              ? "border-black text-gray-900"
              : "border-transparent text-gray-400 hover:text-gray-600"
          }`}
        >
          Orchestrate
        </button>

      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">

        {tab === "research" && (
        <>

        <div className="flex gap-2">

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleSubmit();
              }
            }}
            type="text"
            placeholder="調べたいことを入力してください..."
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none placeholder:text-gray-400"
          />

          <button
            type="button"
            onClick={handleSubmit}
            disabled={status === "loading"}
            className="shrink-0 rounded-lg bg-black px-3 py-2 text-sm text-white transition hover:bg-gray-800 disabled:opacity-50"
          >
            {status === "loading" ? "調査中..." : "調査"}
          </button>

        </div>

        {/* loading状態(STEP202-C) */}
        {status === "loading" && (
          <p className="mt-3 text-sm text-gray-500">
            調査中です...
          </p>
        )}

        {/* APIレベルの失敗(STEP202-F) */}
        {status === "failure" && apiError && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {apiError.message}
          </p>
        )}

        {/* Research内部のfailure(ResearchResult.success===false) */}
        {status === "failure" && !apiError && result && (
          <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            <p>Researchが完了しませんでした。</p>
            {result.errorMessage && (
              <p className="mt-1 text-xs text-red-600">
                {result.errorMessage}
              </p>
            )}
          </div>
        )}

        {/* success状態(STEP202-C/D、STEP213でmetadata表示を追加) */}
        {status === "success" && result && (

          <div className="mt-3 space-y-3">

            {/* STEP213-C: executionMode等、APIレスポンスから確認可能な
                metadataをそのまま表示する(加工・推測しない)。 */}
            <div className="flex flex-wrap gap-2 text-[10px] text-gray-400">
              <span className="rounded bg-gray-100 px-2 py-0.5">
                mode: {result.metadata.executionMode}
              </span>
              <span className="rounded bg-gray-100 px-2 py-0.5">
                llmAttempts: {result.metadata.llmAttempts}
              </span>
              <span className="rounded bg-gray-100 px-2 py-0.5">
                usedKnowledge: {result.metadata.usedKnowledgeCount}
              </span>
              <span className="rounded bg-gray-100 px-2 py-0.5">
                usedMemory: {result.metadata.usedMemoryCount}
              </span>
              <span className="rounded bg-gray-100 px-2 py-0.5">
                usedExample: {result.metadata.usedExampleCount}
              </span>
            </div>

            <p className="whitespace-pre-wrap text-sm text-gray-900">
              {result.answer}
            </p>

            {result.evidence.length > 0 && (

              <div>

                <p className="mb-1 text-xs font-medium text-gray-500">
                  根拠(Evidence)
                </p>

                <ul className="space-y-2">
                  {result.evidence.map((item) => (
                    <EvidenceItemView
                      key={item.id}
                      item={item}
                    />
                  ))}
                </ul>

              </div>

            )}

          </div>

        )}

        </>
        )}

        {tab === "push" && (
        <>

        {/* STEP213-D: Direct Push入口。content/typeのみを入力する
            (STEP212と同じ最小契約、自動分類はしない)。 */}
        <div className="space-y-2">

          <textarea
            value={pushContent}
            onChange={(e) => setPushContent(e.target.value)}
            placeholder="TACTへ直接教えたい内容を入力してください..."
            rows={3}
            className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none placeholder:text-gray-400"
          />

          <div className="flex items-center gap-2">

            <div className="flex gap-1">
              {PUSH_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setPushType(t)}
                  className={`rounded-full px-3 py-1 text-xs ${
                    pushType === t
                      ? "bg-black text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={handlePushSubmit}
              disabled={pushStatus === "loading"}
              className="ml-auto shrink-0 rounded-lg bg-black px-3 py-2 text-sm text-white transition hover:bg-gray-800 disabled:opacity-50"
            >
              {pushStatus === "loading" ? "保存中..." : "Push"}
            </button>

          </div>

        </div>

        {pushStatus === "loading" && (
          <p className="mt-3 text-sm text-gray-500">
            保存中です...
          </p>
        )}

        {pushStatus === "failure" && pushResult && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {pushResult.message}
          </p>
        )}

        {pushStatus === "success" && pushResult && (
          <div className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
            <p>
              保存しました(type: {pushResult.type})
            </p>
            {pushResult.itemId && (
              <p className="mt-1 text-xs text-green-700 break-all">
                id: {pushResult.itemId}
              </p>
            )}
          </div>
        )}

        </>
        )}

        {tab === "orchestrate" && (
        <>

        {/* Phase46: Clarificationが発生していない間は通常の入力欄。 */}
        {!pendingClarification && (

          <div className="flex gap-2">

            <input
              value={orchestrateInput}
              onChange={(e) => setOrchestrateInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleOrchestrateSubmit();
                }
              }}
              type="text"
              placeholder="TACTへ依頼したいことを入力してください..."
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none placeholder:text-gray-400"
            />

            <button
              type="button"
              onClick={handleOrchestrateSubmit}
              disabled={orchestrateStatus === "loading"}
              className="shrink-0 rounded-lg bg-black px-3 py-2 text-sm text-white transition hover:bg-gray-800 disabled:opacity-50"
            >
              {orchestrateStatus === "loading" ? "実行中..." : "実行"}
            </button>

          </div>

        )}

        {/* Phase46 Section4/8: Clarification発生時は、元の依頼・
            TACTからの確認質問・回答入力欄を表示する。元の質問(通常の
            入力欄)は隠すが、pendingClarification.originalInputとして
            state上には保持され続けているため消えていない。 */}
        {pendingClarification && (

          <div className="space-y-2">

            <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
              <p className="text-xs text-gray-400">元の依頼</p>
              <p className="whitespace-pre-wrap">{pendingClarification.originalInput}</p>
            </div>

            <div className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900">
              <p className="text-xs text-blue-500">TACTからの確認</p>
              <p>{pendingClarification.question}</p>
            </div>

            <div className="flex gap-2">

              <input
                value={clarificationAnswer}
                onChange={(e) => setClarificationAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleClarificationAnswerSubmit();
                  }
                }}
                type="text"
                placeholder="回答を入力してください..."
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none placeholder:text-gray-400"
              />

              <button
                type="button"
                onClick={handleClarificationAnswerSubmit}
                disabled={orchestrateStatus === "loading"}
                className="shrink-0 rounded-lg bg-black px-3 py-2 text-sm text-white transition hover:bg-gray-800 disabled:opacity-50"
              >
                {orchestrateStatus === "loading" ? "送信中..." : "回答する"}
              </button>

            </div>

          </div>

        )}

        {orchestrateStatus === "loading" && (
          <p className="mt-3 text-sm text-gray-500">
            実行中です...
          </p>
        )}

        {orchestrateStatus === "failure" && orchestrateApiError && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {orchestrateApiError.message}
          </p>
        )}

        {/* Phase46 Section5: Clarification専用の結果画面は作らず、
            通常のOrchestration結果(最終回答)をそのまま表示するだけ。 */}
        {orchestrateStatus === "success" && orchestrateResult && (

          <div className="mt-3 space-y-3">

            <div className="flex flex-wrap gap-2 text-[10px] text-gray-400">
              <span className="rounded bg-gray-100 px-2 py-0.5">
                mode: {orchestrateResult.metadata.executionMode}
              </span>
            </div>

            <p className="whitespace-pre-wrap text-sm text-gray-900">
              {orchestrateResult.answer}
            </p>

          </div>

        )}

        </>
        )}

      </div>

    </div>

  );

}
