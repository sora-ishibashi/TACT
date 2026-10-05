"use client";

// =========================
// PermissionManagementView (SOR-187)
// =========================
//
// Permission Detailを必ず3セクション(1. Runsに登録された権限 / 2.
// 接続先で観測された権限 / 3. 実際に行われた操作)に分離して表示する
// (絶対条件、SOR-187指示)。判定・比較ロジックは一切ここに無い——
// core/tact-runs-view/permissionManagement.tsが既に確定させたview
// modelをそのまま描画するだけ。

import type { PermissionScopeView } from "@tact/runs-core/tact-runs-view/permissionManagement";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import { PermissionBadge, ResultBadge } from "./badges";

function formatDateTime(value: string | null): string {
  return value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "確認できません";
}

export function PermissionManagementView({ scopes, state, selectedScopeKey, onSelectExecution, onSelectWork }: {
  scopes: PermissionScopeView[];
  state: PresentationStateKind | null;
  selectedScopeKey: string | null;
  onSelectExecution?: (executionId: string) => void;
  onSelectWork?: (workId: string) => void;
}) {

  if (state) {
    return <PresentationState kind={state} />;
  }

  const scope = scopes.find((item) => item.scopeKey === selectedScopeKey) ?? null;

  if (!scope) {
    return <p className="text-[13px] text-[#626161]">左の一覧からAIとサービスの組み合わせを選択してください。</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">

      <header>
        <h2 className="text-[16px] font-medium text-[#112278]">{scope.agentDisplayLabel} / {scope.serviceDisplayLabel}</h2>
        {scope.hasConflict && <p className="mt-1 text-[12px] font-medium text-[#C53F4B]">接続先の権限情報との衝突が検出されています。下記「接続先で観測された権限」を確認してください。</p>}
      </header>

      <section aria-labelledby="registered-rules-heading" className="rounded-xl border border-[#D9D9D9] bg-white p-4">
        <h3 id="registered-rules-heading" className="text-[13px] font-medium text-[#112278]">1. Runsに登録された権限</h3>
        {scope.registeredRules.length === 0 ? (
          <p className="mt-2 text-[13px] text-[#626161]">このAI・サービスに登録されたRuns権限ルールはありません。</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-[12px] leading-[16px]">
              <thead className="border-b border-[#D9D9D9] text-[#626161]">
                <tr>
                  <th className="pb-2 pr-4 font-medium">識別子</th>
                  <th className="pb-2 pr-4 font-medium">操作区分</th>
                  <th className="pb-2 pr-4 font-medium">対象種別</th>
                  <th className="pb-2 pr-4 font-medium">判定</th>
                  <th className="pb-2 pr-4 font-medium">有効</th>
                  <th className="pb-2 pr-4 font-medium">リビジョン</th>
                  <th className="pb-2 pr-4 font-medium">有効期間</th>
                  <th className="pb-2 font-medium">接続スコープ</th>
                </tr>
              </thead>
              <tbody>
                {scope.registeredRules.map((rule) => (
                  <tr key={rule.id} className="border-b border-[#D9D9D9]/70">
                    <td className="py-2 pr-4 text-[#112278]">{rule.identifier}</td>
                    <td className="py-2 pr-4 text-[#626161]">{rule.actionCategory ?? "未指定"}</td>
                    <td className="py-2 pr-4 text-[#626161]">{rule.resourceType ?? "未指定"}</td>
                    <td className="py-2 pr-4 text-[#112278]">{rule.decisionLabel}</td>
                    <td className="py-2 pr-4 text-[#626161]">{rule.enabled ? "有効" : "無効化済み"}</td>
                    <td className="py-2 pr-4 text-[#626161]">v{rule.revision}</td>
                    <td className="py-2 pr-4 text-[#626161]">
                      {rule.validFrom || rule.validUntil ? `${rule.validFrom ? formatDateTime(rule.validFrom) : "開始未指定"} 〜 ${rule.validUntil ? formatDateTime(rule.validUntil) : "終了未指定"}` : "常時"}
                    </td>
                    <td className="py-2 text-[#626161]">{rule.connectionId ?? "指定なし"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="downstream-evidence-heading" className="rounded-xl border border-[#D9D9D9] bg-white p-4">
        <h3 id="downstream-evidence-heading" className="text-[13px] font-medium text-[#112278]">2. 接続先で観測された権限</h3>
        {scope.downstreamEvidence.length === 0 ? (
          <p className="mt-2 text-[13px] text-[#626161]">接続先の権限情報を確認できません。</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-[12px] leading-[16px]">
              <thead className="border-b border-[#D9D9D9] text-[#626161]">
                <tr>
                  <th className="pb-2 pr-4 font-medium">接続先</th>
                  <th className="pb-2 pr-4 font-medium">観測された権限</th>
                  <th className="pb-2 pr-4 font-medium">正本性</th>
                  <th className="pb-2 pr-4 font-medium">信頼度</th>
                  <th className="pb-2 pr-4 font-medium">観測時刻</th>
                  <th className="pb-2 pr-4 font-medium">Runsとの関係</th>
                  <th className="pb-2 font-medium">関連する実行</th>
                </tr>
              </thead>
              <tbody>
                {scope.downstreamEvidence.map((evidence) => (
                  <tr key={evidence.evidenceId} className="border-b border-[#D9D9D9]/70">
                    <td className="py-2 pr-4 text-[#112278]">{evidence.provider}</td>
                    <td className="py-2 pr-4 text-[#626161]">{evidence.permissionStateLabel}</td>
                    <td className="py-2 pr-4 text-[#626161]">{evidence.authorityLevelLabel}</td>
                    <td className="py-2 pr-4 text-[#626161]">{evidence.trustLevelLabel}</td>
                    <td className="py-2 pr-4 text-[#626161]">{formatDateTime(evidence.observedAt)}</td>
                    <td className="py-2 pr-4">
                      <span className={evidence.relationToRuns === "CONFLICT" ? "font-medium text-[#C53F4B]" : "text-[#626161]"}>{evidence.relationToRunsLabel}</span>
                    </td>
                    <td className="py-2">
                      {onSelectExecution ? (
                        <button type="button" onClick={() => onSelectExecution(evidence.executionId)} className="text-[#172E95] underline-offset-2 hover:underline">詳細</button>
                      ) : evidence.executionId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="actual-actions-heading" className="rounded-xl border border-[#D9D9D9] bg-white p-4">
        <h3 id="actual-actions-heading" className="text-[13px] font-medium text-[#112278]">3. 実際に行われた操作</h3>
        {scope.actualActions.length === 0 ? (
          <p className="mt-2 text-[13px] text-[#626161]">このAI・サービスでの実行記録はまだありません。</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-[12px] leading-[16px]">
              <thead className="border-b border-[#D9D9D9] text-[#626161]">
                <tr>
                  <th className="pb-2 pr-4 font-medium">操作</th>
                  <th className="pb-2 pr-4 font-medium">対象</th>
                  <th className="pb-2 pr-4 font-medium">依頼元</th>
                  <th className="pb-2 pr-4 font-medium">結果</th>
                  <th className="pb-2 pr-4 font-medium">権限評価</th>
                  <th className="pb-2 pr-4 font-medium">観測時刻</th>
                  <th className="pb-2 font-medium">仕事</th>
                </tr>
              </thead>
              <tbody>
                {scope.actualActions.map((action) => (
                  <tr key={action.executionId} className="border-b border-[#D9D9D9]/70">
                    <td className="py-2 pr-4 text-[#112278]">
                      {onSelectExecution ? (
                        <button type="button" onClick={() => onSelectExecution(action.executionId)} className="text-[#172E95] underline-offset-2 hover:underline">{action.action}</button>
                      ) : action.action}
                    </td>
                    <td className="py-2 pr-4 text-[#626161]">{action.targetSystem.label}{action.targetSystem.subLabel ? `（${action.targetSystem.subLabel}）` : ""}</td>
                    <td className="py-2 pr-4 text-[#626161]">{action.principalLabel}</td>
                    <td className="py-2 pr-4"><ResultBadge status={action.executionStatus} /></td>
                    <td className="py-2 pr-4"><PermissionBadge result={action.permissionEvaluation} /></td>
                    <td className="py-2 pr-4 text-[#626161]">{formatDateTime(action.observedAt)}</td>
                    <td className="py-2 text-[#626161]">
                      {action.workId && onSelectWork ? (
                        <button type="button" onClick={() => onSelectWork(action.workId!)} className="text-[#172E95] underline-offset-2 hover:underline">仕事を見る</button>
                      ) : action.workId ?? "紐づいていません"}
                    </td>
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
