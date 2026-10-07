"use client";

// =========================
// Runs UI — shared badges/labels (SOR-54)
// =========================
//
// Runsの状態体系に合わせ、成功=Mint、warning=#B7791F、hard failure=
// #C53F4B、Sub text=#626161、Disabled=#8A8A8A背景#F2F2F2を使用。
// 状態は色だけで表現しない——必ず
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
import { StatusIndicator } from "./StatusIndicator";

type BadgeTone = "success" | "error" | "warning" | "neutral" | "muted";

const TONE_STYLES: Record<BadgeTone, string> = {
  success: "bg-runs-success-surface text-runs-success",
  error: "bg-runs-danger-surface text-runs-danger",
  warning: "bg-runs-warning-surface text-runs-warning",
  neutral: "bg-runs-selected text-runs-text",
  muted: "bg-runs-hover text-runs-text-secondary",
};

export function Badge({ label, tone }: { label: string; tone: BadgeTone }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium leading-4 ${TONE_STYLES[tone]}`}
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

export function ResultBadge({ status }: { status: ExecutionStatus }) {
  return <StatusIndicator status={status} className="text-xs font-medium" />;
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
        className="runs-focus rounded-sm text-sm font-medium text-runs-interactive underline-offset-2 transition-colors duration-150 hover:text-runs-interactive-hover hover:underline motion-reduce:transition-none"
      >
        {displayLabel}
      </button>
    ) : (
      <span className="text-sm font-medium text-runs-text">{displayLabel}</span>
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
          className="runs-focus rounded-sm text-xs text-runs-text-secondary underline-offset-2 transition-colors duration-150 hover:text-runs-text hover:underline motion-reduce:transition-none"
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
        className="runs-focus rounded-sm text-sm font-medium text-runs-interactive underline-offset-2 transition-colors duration-150 hover:text-runs-interactive-hover hover:underline motion-reduce:transition-none"
      >
        確認
      </button>
    </span>
  );

}
