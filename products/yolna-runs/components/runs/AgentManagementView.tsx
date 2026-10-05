"use client";

// =========================
// AgentManagementView (SOR-186: Observed AI Management)
// =========================
//
// Work-centricな補助管理View——Agent fleet console(稼働状況・停止/
// 再起動・quota・cost・performance score等)ではない。判定・集計ロジック
// は一切ここに無い——core/tact-runs-view/agentManagement.tsが既に確定
// させたview modelをそのまま描画するだけ(絶対条件「No business logic
// in React」、PermissionManagementView.tsxと同じ既存規律)。
//
// 絶対条件(SOR-186指示、最重要): 表示名・AI提供元・モデル・登録状態は
// 常に「確認できません」——agentId文字列からのブランド推測(例:
// "claude-prod-01" -> Claude/Anthropic)は一切行わない。Permission Rule
// やExecutionの存在を「登録済み」とは表示しない。

import type {
  AgentManagementDetailView,
  AgentManagementItemView,
} from "@tact/runs-core/tact-runs-view/agentManagement";
import { identityEvidenceLabel } from "@tact/runs-core/tact-runs-view/agentManagement";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import { PermissionBadge, ResultBadge, AttentionReasonBadge } from "./badges";

const UNCONFIRMED = "確認できません";

function formatDateTime(value: string | null): string {
  return value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : UNCONFIRMED;
}

export function AgentManagementView({
  items,
  details,
  state,
  selectedAgentId,
  onSelectWork,
  onSelectExecution,
  onOpenPermission,
  onOpenAttention,
}: {
  items: AgentManagementItemView[];
  details: AgentManagementDetailView[];
  state: PresentationStateKind | null;
  selectedAgentId: string | null;
  onSelectWork?: (workId: string) => void;
  onSelectExecution?: (executionId: string) => void;
  // exactScopeKey is non-null only when every Permission Rule for this
  // agent shares exactly one service scope — the one case where jumping
  // straight to that existing Permission scope is not a guess (SOR-186
  // instructions "exact scopeKeyが既に分かる場合のみ。推測でserviceを
  // 選ばない").
  onOpenPermission?: (exactScopeKey: string | null) => void;
  onOpenAttention?: () => void;
}) {

  if (state) {
    return <PresentationState kind={state} />;
  }

  if (items.length === 0) {
    return (
      <PresentationState kind="empty">
        AIとして識別できる実行記録・権限設定はまだありません。
      </PresentationState>
    );
  }

  const detail = details.find((item) => item.agentId === selectedAgentId) ?? null;

  if (!detail) {
    return <p className="text-[13px] text-[#626161]">左の一覧からAI識別子を選択してください。</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">

      <header>
        <h2 className="text-[16px] font-medium text-[#112278]">{detail.agentId}</h2>
      </header>

      {/* 1. 基本情報 */}
      <section aria-labelledby="agent-basic-heading" className="rounded-xl border border-[#D9D9D9] bg-white p-4">
        <h3 id="agent-basic-heading" className="text-[13px] font-medium text-[#112278]">1. 基本情報</h3>
        <dl className="mt-3 grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-2">
          <div><dt className="text-[#626161]">AI識別子</dt><dd className="mt-0.5 text-[#112278]">{detail.agentId}</dd></div>
          <div><dt className="text-[#626161]">表示名</dt><dd className="mt-0.5 text-[#626161]">{UNCONFIRMED}</dd></div>
          <div><dt className="text-[#626161]">AI提供元</dt><dd className="mt-0.5 text-[#626161]">{UNCONFIRMED}</dd></div>
          <div><dt className="text-[#626161]">モデル</dt><dd className="mt-0.5 text-[#626161]">{UNCONFIRMED}</dd></div>
          <div><dt className="text-[#626161]">登録状態</dt><dd className="mt-0.5 text-[#626161]">{UNCONFIRMED}</dd></div>
          <div><dt className="text-[#626161]">最終観測</dt><dd className="mt-0.5 text-[#112278]">{detail.lastActivityAt ? formatDateTime(detail.lastActivityAt) : "実行記録がありません"}</dd></div>
        </dl>
      </section>

      {/* 2. Identity Source */}
      <section aria-labelledby="agent-identity-source-heading" className="rounded-xl border border-[#D9D9D9] bg-white p-4">
        <h3 id="agent-identity-source-heading" className="text-[13px] font-medium text-[#112278]">2. Identity Source</h3>
        <ul className="mt-2 flex flex-col gap-1 text-[13px] text-[#112278]">
          {detail.identityEvidence.map((evidence) => (
            <li key={evidence}>・{identityEvidenceLabel(evidence)}</li>
          ))}
        </ul>
      </section>

      {/* 3. 責任 / 代理 */}
      <section aria-labelledby="agent-responsibility-heading" className="rounded-xl border border-[#D9D9D9] bg-white p-4">
        <h3 id="agent-responsibility-heading" className="text-[13px] font-medium text-[#112278]">3. 責任 / 代理</h3>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <p className="text-[12px] font-medium text-[#626161]">依頼元</p>
            {detail.principals.length === 0 ? (
              <p className="mt-1 text-[13px] text-[#626161]">依頼元の記録はまだありません。</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1 text-[13px] text-[#112278]">
                {detail.principals.map((principal, index) => (
                  <li key={index}>{principal.actorKindLabel} / {principal.actorLabel}</li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="text-[12px] font-medium text-[#626161]">代理元</p>
            {detail.delegations.length === 0 ? (
              <p className="mt-1 text-[13px] text-[#626161]">代理元の記録なし</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1 text-[13px] text-[#112278]">
                {detail.delegations.map((delegation, index) => (
                  <li key={index}>{delegation.onBehalfOfActorKindLabel} / {delegation.actorLabel}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* 4. 操作・観測されたサービス */}
      <section aria-labelledby="agent-target-systems-heading" className="rounded-xl border border-[#D9D9D9] bg-white p-4">
        <h3 id="agent-target-systems-heading" className="text-[13px] font-medium text-[#112278]">4. 操作・観測されたサービス</h3>
        {detail.targetSystems.length === 0 ? (
          <p className="mt-2 text-[13px] text-[#626161]">操作・観測記録はまだありません。</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-[12px] leading-[16px]">
              <thead className="border-b border-[#D9D9D9] text-[#626161]">
                <tr>
                  <th className="pb-2 pr-4 font-medium">サービス</th>
                  <th className="pb-2 pr-4 font-medium">実行件数</th>
                  <th className="pb-2 font-medium">最終観測</th>
                </tr>
              </thead>
              <tbody>
                {detail.targetSystems.map((system) => (
                  <tr key={system.label} className="border-b border-[#D9D9D9]/70">
                    <td className="py-2 pr-4 text-[#112278]">{system.label}{system.subLabel ? `（${system.subLabel}）` : ""}</td>
                    <td className="py-2 pr-4 text-[#626161]">{system.executionCount}</td>
                    <td className="py-2 text-[#626161]">{formatDateTime(system.lastObservedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 5. Connection evidence */}
      <section aria-labelledby="agent-connection-heading" className="rounded-xl border border-[#D9D9D9] bg-white p-4">
        <h3 id="agent-connection-heading" className="text-[13px] font-medium text-[#112278]">5. 接続（Connection）</h3>
        {detail.connectionEvidence.connections.length === 0 ? (
          <p className="mt-2 text-[13px] text-[#626161]">{detail.connectionEvidence.unavailableMessage}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-[12px] leading-[16px]">
              <thead className="border-b border-[#D9D9D9] text-[#626161]">
                <tr>
                  <th className="pb-2 pr-4 font-medium">サービス</th>
                  <th className="pb-2 pr-4 font-medium">接続元</th>
                  <th className="pb-2 font-medium">状態</th>
                </tr>
              </thead>
              <tbody>
                {detail.connectionEvidence.connections.map((connection) => (
                  <tr key={connection.connectionId} className="border-b border-[#D9D9D9]/70">
                    <td className="py-2 pr-4 text-[#112278]">{connection.service}</td>
                    <td className="py-2 pr-4 text-[#626161]">{connection.provider}</td>
                    <td className="py-2 text-[#626161]">{connection.statusLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 6. 権限 */}
      <section aria-labelledby="agent-permission-heading" className="rounded-xl border border-[#D9D9D9] bg-white p-4">
        <div className="flex items-center justify-between">
          <h3 id="agent-permission-heading" className="text-[13px] font-medium text-[#112278]">6. 権限設定</h3>
          {onOpenPermission && (
            <button type="button" onClick={() => onOpenPermission(detail.permission.exactScopeKey)} className="text-[12px] text-[#172E95] underline-offset-2 hover:underline">
              権限設定を見る
            </button>
          )}
        </div>
        {detail.permission.ruleCount === 0 ? (
          <p className="mt-2 text-[13px] text-[#626161]">このAIに登録された権限ルールはありません。</p>
        ) : (
          <>
            <p className="mt-2 text-[12px] text-[#626161]">
              合計 {detail.permission.ruleCount} 件（許可 {detail.permission.allowedCount} ・ 承認が必要 {detail.permission.approvalRequiredCount} ・ 許可しない {detail.permission.deniedCount}）
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-[12px] leading-[16px]">
                <thead className="border-b border-[#D9D9D9] text-[#626161]">
                  <tr>
                    <th className="pb-2 pr-4 font-medium">識別子</th>
                    <th className="pb-2 pr-4 font-medium">対象サービス</th>
                    <th className="pb-2 pr-4 font-medium">操作区分</th>
                    <th className="pb-2 font-medium">有効</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.permission.rules.map((rule) => (
                    <tr key={rule.ruleId} className="border-b border-[#D9D9D9]/70">
                      <td className="py-2 pr-4 text-[#112278]">{rule.identifier}</td>
                      <td className="py-2 pr-4 text-[#626161]">{rule.targetSystemLabel}</td>
                      <td className="py-2 pr-4 text-[#626161]">{rule.actionCategory ?? "未指定"}</td>
                      <td className="py-2 text-[#626161]">{rule.enabled ? "有効" : "無効化済み"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {/* 7. 最近の仕事 */}
      <section aria-labelledby="agent-recent-works-heading" className="rounded-xl border border-[#D9D9D9] bg-white p-4">
        <h3 id="agent-recent-works-heading" className="text-[13px] font-medium text-[#112278]">7. 最近の仕事</h3>
        {detail.recentWorks.length === 0 ? (
          <p className="mt-2 text-[13px] text-[#626161]">このAIが関わった仕事の記録はまだありません。</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-[12px] leading-[16px]">
              <thead className="border-b border-[#D9D9D9] text-[#626161]">
                <tr>
                  <th className="pb-2 pr-4 font-medium">仕事</th>
                  <th className="pb-2 pr-4 font-medium">最新の実行</th>
                  <th className="pb-2 pr-4 font-medium">実行件数</th>
                  <th className="pb-2 pr-4 font-medium">要確認</th>
                  <th className="pb-2 font-medium">最終活動</th>
                </tr>
              </thead>
              <tbody>
                {detail.recentWorks.map((work) => (
                  <tr key={work.workId} className="border-b border-[#D9D9D9]/70">
                    <td className="py-2 pr-4 text-[#112278]">
                      {onSelectWork ? (
                        <button type="button" onClick={() => onSelectWork(work.workId)} className="text-[#172E95] underline-offset-2 hover:underline">
                          {work.workTitle ?? work.workId}
                        </button>
                      ) : (work.workTitle ?? work.workId)}
                    </td>
                    <td className="py-2 pr-4"><ResultBadge status={work.latestExecutionStatus} /></td>
                    <td className="py-2 pr-4 text-[#626161]">{work.executionCount}</td>
                    <td className="py-2 pr-4 text-[#626161]">{work.activeAttentionCount > 0 ? `${work.activeAttentionCount}件` : "なし"}</td>
                    <td className="py-2 text-[#626161]">{formatDateTime(work.lastAgentActivityAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 8. 最近の実行 */}
      <section aria-labelledby="agent-recent-executions-heading" className="rounded-xl border border-[#D9D9D9] bg-white p-4">
        <h3 id="agent-recent-executions-heading" className="text-[13px] font-medium text-[#112278]">8. 最近の実行</h3>
        {detail.recentExecutions.length === 0 ? (
          <p className="mt-2 text-[13px] text-[#626161]">このAIの実行記録はまだありません。</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-[12px] leading-[16px]">
              <thead className="border-b border-[#D9D9D9] text-[#626161]">
                <tr>
                  <th className="pb-2 pr-4 font-medium">操作</th>
                  <th className="pb-2 pr-4 font-medium">対象</th>
                  <th className="pb-2 pr-4 font-medium">結果</th>
                  <th className="pb-2 pr-4 font-medium">権限評価</th>
                  <th className="pb-2 pr-4 font-medium">観測時刻</th>
                  <th className="pb-2 font-medium">仕事</th>
                </tr>
              </thead>
              <tbody>
                {detail.recentExecutions.map((execution) => (
                  <tr key={execution.executionId} className="border-b border-[#D9D9D9]/70">
                    <td className="py-2 pr-4 text-[#112278]">
                      {onSelectExecution ? (
                        <button type="button" onClick={() => onSelectExecution(execution.executionId)} className="text-[#172E95] underline-offset-2 hover:underline">{execution.action}</button>
                      ) : execution.action}
                    </td>
                    <td className="py-2 pr-4 text-[#626161]">{execution.targetSystem.label}{execution.targetSystem.subLabel ? `（${execution.targetSystem.subLabel}）` : ""}</td>
                    <td className="py-2 pr-4"><ResultBadge status={execution.executionStatus} /></td>
                    <td className="py-2 pr-4"><PermissionBadge result={execution.permissionEvaluation} /></td>
                    <td className="py-2 pr-4 text-[#626161]">{formatDateTime(execution.observedAt)}</td>
                    <td className="py-2 text-[#626161]">
                      {execution.workId && onSelectWork ? (
                        <button type="button" onClick={() => onSelectWork(execution.workId!)} className="text-[#172E95] underline-offset-2 hover:underline">{execution.workTitle ?? "仕事を見る"}</button>
                      ) : execution.workTitle ?? (execution.workId ? "紐づいています" : "紐づいていません")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 9. 問題 / Attention */}
      <section aria-labelledby="agent-attention-heading" className="rounded-xl border border-[#D9D9D9] bg-white p-4">
        <div className="flex items-center justify-between">
          <h3 id="agent-attention-heading" className="text-[13px] font-medium text-[#112278]">9. 要確認</h3>
          {onOpenAttention && detail.attentions.length > 0 && (
            <button type="button" onClick={onOpenAttention} className="text-[12px] text-[#172E95] underline-offset-2 hover:underline">
              要確認を見る
            </button>
          )}
        </div>
        {detail.attentions.length === 0 ? (
          <p className="mt-2 text-[13px] text-[#626161]">未解決の要確認はありません。</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-[12px] leading-[16px]">
              <thead className="border-b border-[#D9D9D9] text-[#626161]">
                <tr>
                  <th className="pb-2 pr-4 font-medium">理由</th>
                  <th className="pb-2 pr-4 font-medium">発生時刻</th>
                  <th className="pb-2 font-medium">仕事</th>
                </tr>
              </thead>
              <tbody>
                {detail.attentions.map((attention) => (
                  <tr key={attention.attentionId} className="border-b border-[#D9D9D9]/70">
                    <td className="py-2 pr-4">
                      {onSelectExecution ? (
                        <button type="button" onClick={() => onSelectExecution(attention.executionId)} className="underline-offset-2 hover:underline">
                          <AttentionReasonBadge reason={attention.reason} />
                        </button>
                      ) : <AttentionReasonBadge reason={attention.reason} />}
                    </td>
                    <td className="py-2 pr-4 text-[#626161]">{formatDateTime(attention.createdAt)}</td>
                    <td className="py-2 text-[#626161]">
                      {attention.workId && onSelectWork ? (
                        <button type="button" onClick={() => onSelectWork(attention.workId!)} className="text-[#172E95] underline-offset-2 hover:underline">{attention.workTitle ?? "仕事を見る"}</button>
                      ) : attention.workTitle ?? (attention.workId ? "紐づいています" : "紐づいていません")}
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
