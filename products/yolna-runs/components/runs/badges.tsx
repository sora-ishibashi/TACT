"use client";

// =========================
// Runs UI — shared badges/labels (SOR-54)
// =========================
//
// docs/ui-design-rules.md準拠: 定義済みcolor tokenのみ使用
// (Mint=#18B5A6 成功、Error/Warning=#C53F4B、Sub text=#626161、
// Disabled=#8A8A8A背景#F2F2F2)。状態は色だけで表現しない——必ず
// text labelを併記する(絶対条件、Design Rules Section7/13、SOR-54
// 指示section「Accessibility」)。

import type { CanonicalPermissionResult, CanonicalCorrelationResult } from "@tact/runs-core/tact-runs-view";
import { permissionResultLabel, attentionReasonLabel } from "@tact/runs-core/tact-runs-view";
// core/tact-execution/index.ts(barrel)を経由せず、軽量なleaf file
// から直接型を取る(core/tact-runs-view/index.tsと同じ理由、barrelは
// 重いserver-only dependency chainを引き込むため)。
import type { ExecutionStatus } from "@tact/runs-core/tact-execution/types";
import type { AttentionReason } from "@tact/runs-core/tact-execution/permission/attention";
import type { AttentionStatus } from "@tact/runs-core/tact-execution/permission/attentionStore";
import { japaneseProjection } from "@/lib/japaneseProjection";

type BadgeTone = "success" | "error" | "warning" | "neutral" | "muted";

const TONE_STYLES: Record<BadgeTone, string> = {
  success: "bg-[#E6F2F2] text-[#18B5A6]",
  error: "bg-[#C53F4B]/10 text-[#C53F4B]",
  warning: "bg-[#C53F4B]/10 text-[#C53F4B]",
  neutral: "bg-[#F2F2F2] text-[#112278]",
  muted: "bg-[#F2F2F2] text-[#8A8A8A]",
};

export function Badge({ label, tone }: { label: string; tone: BadgeTone }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[10px] font-medium leading-[14px] ${TONE_STYLES[tone]}`}
    >
      {label}
    </span>
  );
}

const PERMISSION_TONE: Record<CanonicalPermissionResult, BadgeTone> = {
  MATCH: "success",
  MISMATCH: "error",
  APPROVAL_REQUIRED: "warning",
  UNKNOWN: "muted",
};

export function PermissionBadge({ result }: { result: CanonicalPermissionResult }) {
  return <Badge label={japaneseProjection(result) === result ? permissionResultLabel(result) : japaneseProjection(result)} tone={PERMISSION_TONE[result]} />;
}

const RESULT_TONE: Partial<Record<ExecutionStatus, BadgeTone>> = {
  succeeded: "success",
  failed: "error",
};

const RESULT_LABELS: Record<ExecutionStatus, string> = {
  observed: "\u89b3\u6e2c\u6e08\u307f",
  running: "\u5b9f\u884c\u4e2d",
  succeeded: "\u5b8c\u4e86",
  failed: "\u5931\u6557",
  cancelled: "\u53d6\u308a\u6d88\u3057",
  unknown: "\u4e0d\u660e",
};

export function ResultBadge({ status }: { status: ExecutionStatus }) {
  return <Badge label={RESULT_LABELS[status]} tone={RESULT_TONE[status] ?? "muted"} />;
}

// SOR-178 / SEC-8D: permission_unknown/downstream_permission_conflict
// added additively — TypeScript's Record exhaustiveness check forces this
// map to stay in sync with AttentionReason.
const ATTENTION_REASON_TONE: Record<AttentionReason, BadgeTone> = {
  approval_required: "warning",
  permission_mismatch: "error",
  permission_unknown: "warning",
  downstream_permission_conflict: "error",
};

export function AttentionReasonBadge({ reason }: { reason: AttentionReason }) {
  return <Badge label={attentionReasonLabel(reason)} tone={ATTENTION_REASON_TONE[reason]} />;
}

// SOR-48: open(まだ対応が必要)/acknowledged(確認済み、未解決)/
// resolved(解決済み)を色だけでなく必ずlabelで区別する(Design Rules
// Section7/13、絶対条件、上記コメント参照と同じ規律)。
const ATTENTION_STATUS_LABELS: Record<AttentionStatus, string> = {
  open: "Open",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
};

const ATTENTION_STATUS_TONE: Record<AttentionStatus, BadgeTone> = {
  open: "warning",
  acknowledged: "neutral",
  resolved: "success",
};

export function AttentionStatusBadge({ status }: { status: AttentionStatus }) {
  return <Badge label={ATTENTION_STATUS_LABELS[status]} tone={ATTENTION_STATUS_TONE[status]} />;
}

// SOR-53/54: correlated(workId確定)はクリック可能なlinkとして、
// ambiguous/unassignedは(推測でWorkへ誘導しない)muted badgeとして表す。
//
// SOR-18(加算的prop): labelは「表示するtext」、workIdは「識別/遷移に
// 使うid」——この2つを分離する(Attentionの読み時joinがWork titleを
// 持つ場合、labelへtitleを渡して人間可読にできるようにするため)。
// label省略時は既存どおりworkIdをそのまま表示する(Activity側の既存
// 呼び出しは変更不要)。
//
// SOR-77(加算的prop、CORRELATION-REVIEW-P1): onReviewが渡された場合
// のみ、AMBIGUOUS/UNASSIGNEDのbadgeの隣に"Review"actionを出す
// (省略時は既存どおりmuted badgeのみ——Attention側の既存呼び出しは
// 変更不要)。判定・永続化ロジックはここに一切無い(呼び出し元の
// CorrelationReviewModalが担う)。
//
// SOR-77 live Staging verification UX gap fix: CORRELATEDになった行から
// Review導線が完全に消えていた(訂正後、prior system prediction/
// human correction trailを見返せない・再度Change/Keep Unassignedできない、
// というdefect)。isHumanCorrected===trueの場合のみ、Workへのlinkの隣に
// "History"を追加する——すべてのCORRELATED行に無条件で出すわけではない
// (絶対条件、SOR-77指示「2. すべてのCORRELATED行に無条件で出す必要は
// ない」)。auto-matched(人間が一度も触っていない)行は既存どおり
// Workへのlinkのみ。
export function WorkReference({
  workId,
  correlationStatus,
  onSelectWork,
  label,
  onReview,
  isHumanCorrected,
}: {
  workId: string | null;
  correlationStatus: CanonicalCorrelationResult;
  onSelectWork?: (workId: string) => void;
  label?: string;
  onReview?: () => void;
  isHumanCorrected?: boolean;
}) {

  if (workId && correlationStatus === "CORRELATED") {

    const displayLabel = label ?? workId;

    const workLink = onSelectWork ? (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onSelectWork(workId);
        }}
        className="text-[13px] font-medium text-[#172E95] underline-offset-2 transition duration-150 ease-out hover:underline"
      >
        {displayLabel}
      </button>
    ) : (
      <span className="text-[13px] font-medium text-[#112278]">{displayLabel}</span>
    );

    if (!isHumanCorrected || !onReview) {
      return workLink;
    }

    return (
      <span className="inline-flex items-center gap-2">
        {workLink}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onReview();
          }}
          className="text-[12px] text-[#626161] underline-offset-2 transition duration-150 ease-out hover:text-[#112278] hover:underline"
        >
          履歴
        </button>
      </span>
    );

  }

  const unresolvedLabel = japaneseProjection(correlationStatus);

  if (!onReview) {
    return <Badge label={unresolvedLabel} tone="muted" />;
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Badge label={unresolvedLabel} tone="muted" />
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onReview();
        }}
        className="text-[13px] font-medium text-[#172E95] underline-offset-2 transition duration-150 ease-out hover:underline"
      >
        確認
      </button>
    </span>
  );

}
