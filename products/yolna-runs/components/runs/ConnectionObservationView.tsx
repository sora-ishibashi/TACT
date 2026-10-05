"use client";

// =========================
// ConnectionObservationView (SOR-187)
// =========================
//
// Connection(接続)とObservation Surface(観測)を別概念のまま表示する
// (絶対条件、SOR-187指示「ConnectionとObservationを同じstateに丸めな
// い」)。classification/join判定は一切ここに無い——
// core/tact-runs-view/coverageManagement.tsが既に確定させたview model
// をそのまま描画するだけ。

import type { CoverageServiceDetailView } from "@tact/runs-core/tact-runs-view/coverageManagement";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";

function formatDateTime(value: string | null): string {
  return value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "確認できません";
}

function classificationTone(classification: CoverageServiceDetailView["classification"]): string {
  if (classification === "HEALTHY") return "bg-[#E6F2F2] text-[#18B5A6]";
  if (classification === "OUTAGE") return "bg-[#C53F4B]/10 text-[#C53F4B]";
  if (classification === "PARTIAL") return "bg-[#C53F4B]/10 text-[#C53F4B]";
  return "bg-[#F2F2F2] text-[#8A8A8A]";
}

export function ConnectionObservationView({ details, state, selectedSurfaceId }: {
  details: CoverageServiceDetailView[];
  state: PresentationStateKind | null;
  selectedSurfaceId: string | null;
}) {

  if (state) {
    return <PresentationState kind={state} />;
  }

  // SOR-187 review: successでsurfaceが0件(empty)と、surfaceは存在するが
  // まだ選択されていない(unselected)は別の事実——どちらも「detailが
  // 見つからない」ように見えるが混同しない。
  if (details.length === 0) {
    return <PresentationState kind="empty" />;
  }

  const detail = details.find((item) => item.surfaceId === selectedSurfaceId) ?? null;

  if (!detail) {
    return <p className="text-[13px] text-[#626161]">左の一覧から接続先を選択してください。</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">

      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-[16px] font-medium text-[#112278]">{detail.source}</h2>
        <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[10px] font-medium leading-[14px] ${classificationTone(detail.classification)}`}>{detail.classificationLabel}</span>
      </header>

      {detail.activeGap && (
        <p className="rounded-xl border border-[#C53F4B]/30 bg-[#C53F4B]/5 p-3 text-[13px] text-[#C53F4B]">
          一部の操作を観測できていない可能性があります。（検知: {formatDateTime(detail.activeGap.detectedAt)} / 理由: {detail.activeGap.reason}）
        </p>
      )}

      <section aria-labelledby="connection-heading" className="rounded-xl border border-[#D9D9D9] bg-white p-4">
        <h3 id="connection-heading" className="text-[13px] font-medium text-[#112278]">接続</h3>
        {detail.connection.joined ? (
          <dl className="mt-3 grid grid-cols-2 gap-3 text-[12px]">
            <div><dt className="text-[#8A8A8A]">サービス</dt><dd className="mt-0.5 text-[#112278]">{detail.connection.service}</dd></div>
            <div><dt className="text-[#8A8A8A]">プロバイダー</dt><dd className="mt-0.5 text-[#112278]">{detail.connection.provider}</dd></div>
            <div><dt className="text-[#8A8A8A]">接続状態</dt><dd className="mt-0.5 text-[#112278]">{detail.connection.statusLabel}</dd></div>
          </dl>
        ) : (
          <p className="mt-2 text-[13px] text-[#626161]">{detail.connection.unavailableMessage}</p>
        )}
      </section>

      <section aria-labelledby="observation-heading" className="rounded-xl border border-[#D9D9D9] bg-white p-4">
        <h3 id="observation-heading" className="text-[13px] font-medium text-[#112278]">観測</h3>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-[12px]">
          <div><dt className="text-[#8A8A8A]">観測元</dt><dd className="mt-0.5 text-[#112278]">{detail.source}</dd></div>
          <div><dt className="text-[#8A8A8A]">対象サービス</dt><dd className="mt-0.5 text-[#112278]">{detail.providerLabel}</dd></div>
          <div><dt className="text-[#8A8A8A]">観測状態</dt><dd className="mt-0.5 text-[#112278]">{detail.classificationLabel}</dd></div>
          <div><dt className="text-[#8A8A8A]">観測方法</dt><dd className="mt-0.5 text-[#112278]">{detail.observationModeLabel}</dd></div>
          <div><dt className="text-[#8A8A8A]">最終観測</dt><dd className="mt-0.5 text-[#112278]">{formatDateTime(detail.lastSeenAt)}</dd></div>
          <div><dt className="text-[#8A8A8A]">権限の事前確認</dt><dd className="mt-0.5 text-[#112278]">{detail.permissionPrecheckAvailable ? "可能" : "できません"}</dd></div>
          <div><dt className="text-[#8A8A8A]">識別情報の伝達</dt><dd className="mt-0.5 text-[#112278]">{detail.identityTransport ?? "確認できません"}</dd></div>
          <div><dt className="text-[#8A8A8A]">仕事の紐づけ情報の伝達</dt><dd className="mt-0.5 text-[#112278]">{detail.workContextTransport ?? "確認できません"}</dd></div>
        </dl>
        {detail.observableCapabilities.length > 0 && (
          <p className="mt-3 text-[12px] text-[#626161]">観測可能な範囲: {detail.observableCapabilities.join(", ")}</p>
        )}
      </section>

      <section aria-labelledby="capture-gap-heading" className="rounded-xl border border-[#D9D9D9] bg-white p-4">
        <h3 id="capture-gap-heading" className="text-[13px] font-medium text-[#112278]">観測欠損の履歴</h3>
        {detail.gaps.length === 0 ? (
          <p className="mt-2 text-[13px] text-[#626161]">観測欠損の記録はありません。</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-[12px] leading-[16px]">
              <thead className="border-b border-[#D9D9D9] text-[#626161]">
                <tr>
                  <th className="pb-2 pr-4 font-medium">検知時刻</th>
                  <th className="pb-2 pr-4 font-medium">対象期間</th>
                  <th className="pb-2 pr-4 font-medium">対象範囲</th>
                  <th className="pb-2 pr-4 font-medium">理由</th>
                  <th className="pb-2 pr-4 font-medium">確信度</th>
                  <th className="pb-2 pr-4 font-medium">状態</th>
                  <th className="pb-2 font-medium">解決時刻</th>
                </tr>
              </thead>
              <tbody>
                {detail.gaps.map((gap) => (
                  <tr key={gap.gapId} className="border-b border-[#D9D9D9]/70">
                    <td className="py-2 pr-4 text-[#112278]">{formatDateTime(gap.detectedAt)}</td>
                    <td className="py-2 pr-4 text-[#626161]">{gap.affectedFrom || gap.affectedTo ? `${formatDateTime(gap.affectedFrom)} 〜 ${formatDateTime(gap.affectedTo)}` : "不明"}</td>
                    <td className="py-2 pr-4 text-[#626161]">{gap.affectedScope ?? "不明"}</td>
                    <td className="py-2 pr-4 text-[#626161]">{gap.reason}</td>
                    <td className="py-2 pr-4 text-[#626161]">{gap.confidence}</td>
                    <td className="py-2 pr-4 text-[#626161]">{gap.isActive ? "未解決" : "解決済み"}</td>
                    <td className="py-2 text-[#626161]">{formatDateTime(gap.resolvedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

    </div>
  );

}
