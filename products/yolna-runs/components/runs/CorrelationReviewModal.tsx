"use client";

// =========================
// CorrelationReviewModal (SOR-77 CORRELATION-REVIEW-P1)
// =========================
//
// 絶対条件(SOR-77指示「No business logic in React」、SOR-54から続く
// 既存規律): permission/attention/correlationの「判定」はここに一切
// 無い。GET /api/tact/runs/execution/[executionId]/correlationが返す
// 既に確定したCorrelationReviewView(core/tact-runs-view)をそのまま
// 描画し、Confirm/Change/Keep UnassignedはすべてPATCH /api/tact/runs/
// execution/[executionId]/reclassify(既存SOR-46 API、tenant/state
// validation・optimistic concurrency・append-only historyはRPC側が担う)
// を呼ぶだけ。このcomponent自身はWorkのidentityやtenant所有権を一切
// 判定しない。

import { useCallback, useEffect, useState } from "react";
import type { CorrelationReviewView } from "@tact/runs-core/tact-runs-view";
import { CloseIcon } from "@/components/icons/RunsIcons";

interface CorrelationReviewModalProps {

  executionId: string;

  accessToken: string;

  onClose: () => void;

  // 成功後、呼び出し元(ActivityTable/RunsSection)が自分のlocal state
  // (該当rowのworkId/correlationStatus)をその場で更新できるようにする
  // ——絶対条件(reload preserves the correction state): サーバー側は
  // 既にDBへ永続化済みのため、この通知はUX即時性のためだけであり、
  // 無くてもreload後は正しい状態が返る。
  onCorrected: (result: { workId: string | null; correlationStatus: "CORRELATED" | "AMBIGUOUS" | "UNASSIGNED"; isHumanCorrected: true }) => void;

}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; view: CorrelationReviewView };

type SubmitState = { pending: false } | { pending: true; action: string };

function formatConfidence(confidence: number | null): string | null {

  if (confidence === null) {
    return null;
  }

  return `${Math.round(confidence * 100)}%`;

}

function formatTimestamp(iso: string): string {

  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }

}

export default function CorrelationReviewModal({
  executionId,
  accessToken,
  onClose,
  onCorrected,
}: CorrelationReviewModalProps) {

  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [submit, setSubmit] = useState<SubmitState>({ pending: false });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [changeWorkId, setChangeWorkId] = useState("");

  const fetchReview = useCallback(async () => {

    setLoad({ status: "loading" });

    try {

      const response = await fetch(`/api/tact/runs/execution/${encodeURIComponent(executionId)}/correlation`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await response.json().catch(() => null);

      if (!response.ok || !body?.success || !body.correlation) {
        setLoad({ status: "error", message: "このExecutionの相関情報を読み込めませんでした。" });
        return;
      }

      setLoad({ status: "ready", view: body.correlation as CorrelationReviewView });

    } catch {

      setLoad({ status: "error", message: "このExecutionの相関情報を読み込めませんでした。" });

    }

  }, [executionId, accessToken]);

  useEffect(() => {
    // RunsSection.tsxのConnectionsPanel由来パターンと同じ理由: effect
    // 本体で直接setStateへ繋がる呼び出しをせず、次のmicrotaskへ委ねる
    // (cascading synchronous render回避)。
    queueMicrotask(() => {
      void fetchReview();
    });
  }, [fetchReview]);

  const submitCorrection = useCallback(async (
    action: string,
    newWorkId: string | null,
    reasonCode: string,
    expectedPreviousWorkId: string | null
  ) => {

    setSubmit({ pending: true, action });
    setSubmitError(null);

    try {

      const response = await fetch(`/api/tact/runs/execution/${encodeURIComponent(executionId)}/reclassify`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ newWorkId, expectedPreviousWorkId, reasonCode }),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok || !body?.success || !body.correlation) {

        if (response.status === 409) {
          setSubmitError("他の変更と競合しました。最新の状態を読み込み直します。");
          await fetchReview();
        } else if (response.status === 404) {
          setSubmitError(body?.error === "target work not found" ? "指定されたWorkは見つかりませんでした。" : "Executionが見つかりませんでした。");
        } else {
          setSubmitError("保存に失敗しました。もう一度お試しください。");
        }

        return;

      }

      const correlation = body.correlation as { workId: string | null; correlationStatus: "CORRELATED" | "AMBIGUOUS" | "UNASSIGNED" };

      // 絶対条件(SOR-23、reload無しでも即座に正しい状態を表す): PATCH
      // reclassifyが成功した時点で、この結果は常にmanual_override
      // (Confirm/Change/Keep Unassignedのいずれも)——isHumanCorrectedは
      // 常にtrue。
      onCorrected({ workId: correlation.workId, correlationStatus: correlation.correlationStatus, isHumanCorrected: true });
      onClose();

    } catch {

      setSubmitError("保存に失敗しました。もう一度お試しください。");

    } finally {

      setSubmit({ pending: false });

    }

  }, [executionId, accessToken, fetchReview, onCorrected, onClose]);

  return (

    <div className="fixed inset-0 z-[80] flex items-center justify-center px-4 py-8">

      <div
        className="absolute inset-0 z-40 bg-[#112278]/40"
        onClick={submit.pending ? undefined : onClose}
        aria-hidden="true"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Work correlationの確認"
        // SOR-23 (OBS-UX-P1 Priority 6, carried forward from SOR-77 live
        // verification as a confirmed responsive/viewport gap): the panel
        // itself is now height-bounded to the viewport with its own
        // internal scroll, so a long candidates/History list (full audit
        // trail is never visually truncated — it just scrolls) never pushes
        // Confirm/Change/Keep Unassigned or the close button off-screen on
        // a short or narrow window. The header stays pinned; only the body
        // scrolls.
        className="relative z-[80] flex max-h-[85vh] w-full max-w-[480px] flex-col rounded-2xl bg-white p-6 shadow-[0_4px_16px_rgba(17,34,120,0.12)]"
      >

        <div className="flex shrink-0 items-start justify-between gap-4">
          <h2 className="text-[24px] font-medium leading-[32px] text-[#112278]">Workを確認</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submit.pending}
            aria-label="Work確認を閉じる"
            title="Work確認を閉じる"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[#626161] outline-none transition duration-150 ease-out hover:bg-[#F7F7F7] hover:text-[#171717] focus-visible:ring-2 focus-visible:ring-[#18B5A6] disabled:opacity-50"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="tact-scrollbar mt-4 min-h-0 flex-1 overflow-y-auto">

          {load.status === "loading" ? (

            <p className="text-[13px] leading-[18px] text-[#626161]">読み込んでいます...</p>

          ) : load.status === "error" ? (

            <p className="text-[13px] leading-[18px] text-[#C53F4B]">{load.message}</p>

          ) : (

            <div className="flex flex-col gap-4">

              {load.view.currentWorkId && (
                <div className="flex flex-col gap-1 text-[13px] leading-[18px] text-[#112278]">
                  <span className="text-[12px] font-medium text-[#626161]">現在のWork</span>
                  <span>{load.view.currentWorkTitle ?? load.view.currentWorkId}</span>
                </div>
              )}

              {load.view.isHumanCorrected && load.view.correction && (
                <p className="rounded-xl border border-[#D9D9D9] bg-[#F2F2F2]/60 px-3 py-2 text-[12px] leading-[16px] text-[#626161]">
                  {formatTimestamp(load.view.correction.correlatedAt)}に{load.view.correction.changedByActorId ?? "人間"}が訂正済みです
                  （理由: {load.view.correction.reasonCode}）。
                  以下は訂正の根拠となったsystem提案です。
                </p>
              )}

              <div className="flex flex-col gap-1 text-[13px] leading-[18px] text-[#626161]">
                <span className="text-[12px] font-medium text-[#626161]">
                  {load.view.isHumanCorrected ? "訂正前のsystem提案" : "system提案の根拠"}
                </span>
                {load.view.methodLabel && <span>根拠: {load.view.methodLabel}</span>}
                {formatConfidence(load.view.confidence) !== null && (
                  <span>Confidence: {formatConfidence(load.view.confidence)}</span>
                )}
              </div>

              {load.view.candidates.length > 0 ? (

                <div className="flex flex-col gap-2">
                  <h3 className="text-[13px] font-medium leading-[18px] text-[#112278]">候補Work</h3>
                  {load.view.candidates.map((candidate) => (
                    <div
                      key={candidate.workId}
                      className="flex items-center justify-between gap-3 rounded-xl border border-[#D9D9D9] px-3 py-2"
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className={`truncate text-[13px] ${candidate.actionable ? "text-[#112278]" : "text-[#8A8A8A]"}`}>
                          {candidate.title ?? candidate.workId}
                        </span>
                        {!candidate.actionable && (
                          <span className="text-[10px] leading-[14px] text-[#8A8A8A]">
                            {candidate.unavailableReason === "not_correlatable"
                              ? "このWorkは既に終了しているため選択できません"
                              : "現在選択できません"}
                          </span>
                        )}
                      </div>
                      {candidate.actionable ? (
                        <button
                          type="button"
                          disabled={submit.pending}
                          onClick={() => submitCorrection(
                            `confirm:${candidate.workId}`,
                            candidate.workId,
                            "human_confirmed_candidate",
                            load.view.currentWorkId
                          )}
                          className="h-9 shrink-0 rounded-[10px] bg-[#18B5A6] px-3 text-[13px] font-medium text-white transition duration-150 ease-out hover:bg-white hover:text-[#18B5A6] hover:border hover:border-[#18B5A6] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {submit.pending && submit.action === `confirm:${candidate.workId}` ? "保存中..." : "Confirm"}
                        </button>
                      ) : (
                        <span className="h-9 shrink-0 rounded-[10px] bg-[#F2F2F2] px-3 text-[13px] font-medium leading-9 text-[#8A8A8A]">
                          Confirm
                        </span>
                      )}
                    </div>
                  ))}
                </div>

              ) : (

                <p className="text-[13px] leading-[18px] text-[#626161]">system側の候補はありません。</p>

              )}

              <div className="flex flex-col gap-2">
                <h3 className="text-[13px] font-medium leading-[18px] text-[#112278]">別のWorkへ変更</h3>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={changeWorkId}
                    onChange={(event) => setChangeWorkId(event.target.value)}
                    placeholder="Work ID"
                    disabled={submit.pending}
                    className="h-9 min-w-0 flex-1 rounded-xl border border-[#D9D9D9] px-3 text-[13px] text-[#112278] outline-none focus:border-[#18B5A6] disabled:bg-[#F2F2F2] disabled:text-[#8A8A8A]"
                  />
                  <button
                    type="button"
                    disabled={submit.pending || changeWorkId.trim().length === 0}
                    onClick={() => submitCorrection(
                      "change",
                      changeWorkId.trim(),
                      "human_selected_different_work",
                      load.view.currentWorkId
                    )}
                    className="h-9 shrink-0 rounded-[10px] border border-[#112278] bg-white px-3 text-[13px] font-medium text-[#112278] transition duration-150 ease-out hover:bg-[#E6F2F2] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {submit.pending && submit.action === "change" ? "保存中..." : "Assign"}
                  </button>
                </div>
              </div>

              <button
                type="button"
                disabled={submit.pending}
                onClick={() => submitCorrection(
                  "keep_unassigned",
                  null,
                  "human_kept_unassigned",
                  load.view.currentWorkId
                )}
                className="h-9 w-fit rounded-[10px] px-3 text-[13px] font-medium text-[#626161] transition duration-150 ease-out hover:bg-[#E6F2F2] hover:text-[#112278] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submit.pending && submit.action === "keep_unassigned" ? "保存中..." : "Keep Unassigned"}
              </button>

              {load.view.history.length > 0 && (
                <div className="flex flex-col gap-2 border-t border-[#D9D9D9] pt-3">
                  <h3 className="text-[13px] font-medium leading-[18px] text-[#112278]">History</h3>
                  {load.view.history.map((entry, index) => (
                    <div key={index} className="flex flex-col gap-0.5 text-[12px] leading-[16px] text-[#626161]">
                      <span>
                        {formatTimestamp(entry.correlatedAt)} — {entry.methodLabel}
                        {entry.changedByActorId ? `（${entry.changedByActorId}）` : ""} → {entry.canonicalStatus}
                      </span>
                      <span className="text-[#8A8A8A]">{entry.reasonCode}</span>
                    </div>
                  ))}
                </div>
              )}

              {submitError && <p className="text-[13px] leading-[18px] text-[#C53F4B]">{submitError}</p>}

            </div>

          )}

        </div>

      </div>

    </div>

  );

}
