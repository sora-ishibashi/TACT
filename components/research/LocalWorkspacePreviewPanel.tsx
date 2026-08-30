"use client";

// =========================
// LocalWorkspacePreviewPanel (development専用, LW-P3 Mock E2E Preview)
// =========================
//
// 実Browser Local Workspace接続・実LLM・実Search API・実Supabase write
// を一切使わず、components/research/localWorkspacePreview.tsの
// runLocalWorkspacePreview()(LW-P3の本番pure functionをそのまま
// 呼び出すglue)の結果を表示するだけのdebug UI。ここでは新しい
// ranking/matching/context assemblyロジックを実装しない。

import { useMemo, useState } from "react";

import {
  DEFAULT_MOCK_QUERY,
  DEFAULT_MOCK_WORKSPACE_FILES,
  runLocalWorkspacePreview,
  type LocalWorkspacePreviewReason,
} from "./localWorkspacePreview";

const PRESET_QUERIES: { label: string; query: string }[] = [
  { label: "SROI (Workspace利用)", query: DEFAULT_MOCK_QUERY },
  { label: "Opt-out", query: "ローカルは使わずに、SROIについて調べて" },
  { label: "No match(参照意図はあるが該当なし)", query: "ローカル資料を参考に、月面探査計画について調べて" },
  { label: "通常Research(意図なし)", query: "トヨタについて調べて" },
];

const REASON_LABEL: Record<LocalWorkspacePreviewReason, string> = {
  opted_out: "opted_out(明示的にWorkspaceを使わない指示)",
  no_intent: "no_intent(Workspace参照意図なし)",
  no_candidates: "no_candidates(該当候補なし)",
  used: "used(Workspace Evidenceを利用)",
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-4 text-[13px] font-medium leading-[18px] text-[#112278]">{children}</h3>
  );
}

export default function LocalWorkspacePreviewPanel() {

  const [query, setQuery] = useState(DEFAULT_MOCK_QUERY);

  const result = useMemo(
    () => runLocalWorkspacePreview(query, DEFAULT_MOCK_WORKSPACE_FILES),
    [query]
  );

  return (
    <div className="h-full min-w-0 flex-1 overflow-y-auto bg-white p-5 text-[#112278]">

      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[18px] font-medium leading-[24px] text-[#112278]">
            Local Workspace Mock E2E Preview
          </h2>
          <p className="mt-1 text-[13px] leading-[18px] text-[#626161]">
            development専用。実Browser接続・実LLM・実Search API・実Supabase writeは一切行いません
            (LLM = 0 / Search API = 0 / Supabase write = 0)。LW-P3の本番pure function
            (resolver / contentIndex / contextAssembly)を、静的なmock fileでそのまま実行しています。
          </p>
        </div>
        <span className="shrink-0 rounded-[999px] bg-[#E6F2F2] px-3 py-1 text-[12px] font-medium text-[#18B5A6]">
          Preview
        </span>
      </div>

      {/* mock file一覧 */}
      <SectionTitle>Mock Workspace Files</SectionTitle>
      <div className="mt-2 flex flex-wrap gap-2">
        {DEFAULT_MOCK_WORKSPACE_FILES.map((file) => (
          <span
            key={file.relativePath}
            className="rounded-[8px] border border-[#D9D9D9] bg-white px-2 py-1 text-[12px] text-[#626161]"
          >
            {file.relativePath}
          </span>
        ))}
      </div>

      {/* User Request */}
      <SectionTitle>User Request</SectionTitle>
      <textarea
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        rows={2}
        className="mt-2 w-full rounded-[12px] border border-[#D9D9D9] bg-white p-2.5 text-[13px] leading-[18px] text-[#112278] outline-none focus:border-[#18B5A6]"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        {PRESET_QUERIES.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => setQuery(preset.query)}
            className="rounded-[10px] border border-[#D9D9D9] bg-white px-2.5 py-1 text-[12px] font-medium text-[#112278] transition hover:bg-[#E6F2F2]"
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Workspace利用判定 */}
      <SectionTitle>Workspace利用判定</SectionTitle>
      <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[13px] leading-[18px]">
        <span>opt-out判定: <span className="font-medium">{String(result.optedOut)}</span></span>
        <span>参照意図判定: <span className="font-medium">{String(result.intentDetected)}</span></span>
        <span>
          結果:{" "}
          <span className={`font-medium ${result.used ? "text-[#18B5A6]" : "text-[#626161]"}`}>
            {REASON_LABEL[result.reason]}
          </span>
        </span>
      </div>

      {/* 抽出query terms */}
      <SectionTitle>抽出Query Terms</SectionTitle>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {result.terms.length === 0 ? (
          <span className="text-[13px] text-[#626161]">(なし)</span>
        ) : (
          result.terms.map((term) => (
            <span
              key={term}
              className="rounded-[999px] bg-[#E6F2F2] px-2.5 py-0.5 text-[12px] font-medium text-[#172E95]"
            >
              {term}
            </span>
          ))
        )}
      </div>

      {/* Candidate files */}
      <SectionTitle>Candidate Files（score / match件数）</SectionTitle>
      {result.candidates.length === 0 ? (
        <p className="mt-2 text-[13px] text-[#626161]">(候補なし)</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-[12px] border border-[#D9D9D9]">
          <table className="w-full min-w-[480px] text-left text-[12px]">
            <thead>
              <tr className="border-b border-[#D9D9D9] text-[#8A8A8A]">
                <th className="px-2.5 py-1.5 font-medium">relativePath</th>
                <th className="px-2.5 py-1.5 font-medium">score</th>
                <th className="px-2.5 py-1.5 font-medium">metadata match</th>
                <th className="px-2.5 py-1.5 font-medium">content match</th>
                <th className="px-2.5 py-1.5 font-medium">read対象</th>
              </tr>
            </thead>
            <tbody>
              {result.candidates.map((candidate) => (
                <tr key={candidate.relativePath} className="border-b border-[#D9D9D9] last:border-b-0">
                  <td className="px-2.5 py-1.5 text-[#112278]">{candidate.relativePath}</td>
                  <td className="px-2.5 py-1.5">{candidate.score}</td>
                  <td className="px-2.5 py-1.5">{candidate.metadataMatchCount}</td>
                  <td className="px-2.5 py-1.5">{candidate.contentMatchCount}</td>
                  <td className="px-2.5 py-1.5">
                    {candidate.read ? (
                      <span className="text-[#18B5A6]">read</span>
                    ) : (
                      <span className="text-[#8A8A8A]">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Read files */}
      <SectionTitle>実際にReadされたFiles</SectionTitle>
      {result.readFiles.length === 0 ? (
        <p className="mt-2 text-[13px] text-[#626161]">(なし)</p>
      ) : (
        <ul className="mt-2 space-y-1 text-[13px] leading-[18px]">
          {result.readFiles.map((file) => (
            <li key={file.relativePath} className="flex flex-wrap items-center gap-x-3">
              <span className="font-medium text-[#112278]">{file.relativePath}</span>
              <span className="text-[#626161]">{file.contentChars}文字</span>
              {file.truncated && <span className="text-[#C53F4B]">truncated</span>}
              {!file.includedInContext && (
                <span className="text-[#C53F4B]">合計文字数上限により最終contextから除外</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* 合計context文字数 */}
      <SectionTitle>合計Context文字数</SectionTitle>
      <p className="mt-2 text-[13px] leading-[18px] text-[#112278]">
        {result.totalContextChars.toLocaleString()} 文字
      </p>

      {/* Evidence provenance */}
      <SectionTitle>LocalWorkspaceEvidence Provenance</SectionTitle>
      {result.evidence.length === 0 ? (
        <p className="mt-2 text-[13px] text-[#626161]">(なし)</p>
      ) : (
        <div className="mt-2 space-y-2">
          {result.evidence.map((item) => (
            <div
              key={item.evidence.id}
              className="rounded-[10px] border border-[#D9D9D9] p-2.5 text-[12px] leading-[17px]"
            >
              <p><span className="text-[#8A8A8A]">id: </span>{item.evidence.id}</p>
              <p><span className="text-[#8A8A8A]">sourceType: </span>{item.provenance.sourceType}</p>
              <p><span className="text-[#8A8A8A]">workspaceId: </span>{item.provenance.workspaceId}</p>
              <p><span className="text-[#8A8A8A]">relativePath: </span>{item.provenance.relativePath}</p>
              <p><span className="text-[#8A8A8A]">fileName: </span>{item.provenance.fileName}</p>
            </div>
          ))}
        </div>
      )}

      {/* 最終context block */}
      <SectionTitle>Researchへ渡される「Local Workspace Evidence」Context Block</SectionTitle>
      {result.workspaceEvidenceBlock ? (
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-[#F2F2F2] p-2.5 text-[12px] leading-[18px] text-[#112278]">
          {result.workspaceEvidenceBlock}
        </pre>
      ) : (
        <p className="mt-2 text-[13px] text-[#626161]">(このTurnではLocal Workspace Evidenceは渡されません)</p>
      )}

    </div>
  );

}
