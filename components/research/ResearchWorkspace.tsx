"use client";

// =========================
// ResearchWorkspace (Phase 74→Phase75でArtifact右パネルを追加)
// =========================
//
// Phase75: 右パネルを、Research結果一覧を表示するだけの「情報源」から、現在進行中の
// Artifact(成果物)を閲覧する「情報源」へと切り替えた(Section13の方針)。
// 現時点ではArtifactを閲覧・更新する情報源は、core/tact-conversation/orchestration.tsの
// applyArtifactMutation()(Turnの副作用として作成・更新される)のみで、このコンポーネント
// 自体は直接書き換えを行わず、あくまで取得専用でGET /api/tact/artifacts/[id]を
// 叩くだけに留める。
//
// Phase73 Investigationの結果を踏まえ、これまでTACT Researchの機能が分散していた
// (「ChatGPTのようなプロダクト画面」ではなく、Project(=Folder)・
// Chat History・Conversation・Research結果/Knowledgeがバラバラの画面だった)ことを
// 踏まえ、Workspaceとして再構成する(Phase74 Section1)。
//
// Repository Evidence(Phase73/74):
//   - core/tact-project/*(Phase30/31で追加、既存に無変更)がProject=Folder
//     として機能しており、実運用でFolder entityは作られていない。
//   - core/tact-conversation/*・/api/tact/tact-conversations*
//     (Phase64〜69で既存Conversation Panelの実装がある、それをそのまま使う。
//     Phase74で追加したのはBackend変更のみで、
//     tact_conversations.project_id(nullable FK、Phase73 Case B)を
//     受けてstore.ts/route.tsを最小限拡張しただけ。
//   - core/tact-orchestrator/*・core/tact-research/*は無変更
//     (Phase74 Section7で既存Backendをそのまま呼び出すのみ)。
//   - Research結果は既にOrchestrator経由でtact_core_knowledgeへ自動で
//     書き込まれる(memoryWriter.ts、Phase5で既に実装済み)ため、
//     閲覧するためだけの新規GET /api/tact/knowledge(Phase74で追加)。
//     読み取り専用で、recordKnowledge()等の書き込み経路は変更していない。
//
// Phase70のConversationSection.tsxはトップレベルSectionとして完成しており、
// そのファイル自体は削除しておらず(認識・カラー等のメッセージ表示や
// ロールバックパターンをそのまま)Workspace内のConversation
// Panelへ移植・再利用した。CLAUDE.mdの既存方針により、無関係な削除は
// 行わない。
import Image from "next/image";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChartNoAxesCombined,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  FileText,
  Folder,
  Library,
  Lightbulb,
  Link,
  LoaderCircle,
  Menu,
  MessageCircle,
  MessageSquarePlus,
  Package,
  Pin,
  Plus,
  Search,
  Table2,
  type LucideIcon,
} from "lucide-react";

import { useAuth } from "@/components/auth/AuthProvider";
import ProductLauncher, { type TactSection } from "@/components/tact/ProductLauncher";
// LW-P3: Local Workspace(接続済みの場合のみ)をResearch Context
// Sourceとして使うためのWorkspace Context Resolver。Coreの
// LocalWorkspacePanel(components/tact/localWorkspace/LocalWorkspacePanel.tsx)
// と同じhookを再利用する(接続状態はブラウザのIndexedDBに永続化されて
// おり、queryPermissionのみの無音確認で復元される。ここでは接続UIは
// 描画せず、resolveWorkspaceContext()だけを利用する)。
import { useLocalWorkspace } from "@/components/tact/localWorkspace/useLocalWorkspace";
import type { Project } from "@/core/tact-project/types";
import type {
  ConversationMessageAttachment,
  ConversationMessageRole,
  ConversationSummary,
} from "@/core/tact-conversation/types";
import type { KnowledgeItem } from "@/core/tact-core";
import type { Artifact, ArtifactBlock, TableBlock } from "@/core/tact-artifact/types";
import { renderBlocksToPlainText } from "@/core/tact-artifact/blocks";
import { ArtifactEvidencePopover, type ArtifactEvidenceSource } from "./ArtifactEvidencePopover";
import { getArtifactPreview, getArtifactPreviewEvidenceSources } from "./artifactPreview";
// LW-P3 Mock E2E Preview(development専用、実Browser/LLM/Search API/
// Supabase writeなし)。既存のartifactPreviewと同じgating patternを
// 踏襲する独立した機能のため、既存のResearch送信フローには一切
// 影響しない(下記の早期returnでのみ分岐する)。
import {
  getLocalWorkspacePreviewKind,
  type LocalWorkspacePreviewKind,
} from "./localWorkspacePreview";
import LocalWorkspacePreviewPanel from "./LocalWorkspacePreviewPanel";
import {
  applyAttachmentUploadResult,
  canSubmitConversationTurn,
  clearAttachmentsAfterSuccessfulSend,
  getReadyAttachmentIds,
  getMessageAttachmentFilenames,
  hasPendingAttachment,
  removeComposerAttachment,
  shouldShowAttachmentSpinner,
  validatePdfSelection,
  type ComposerAttachment,
} from "./attachmentComposer";

type ConversationMessageView = {
  id: string;
  role: ConversationMessageRole;
  content: string;
  attachments?: ConversationMessageAttachment[];
  createdAt?: string;
  // LW-P3: このTurnでLocal Workspaceから参照したfile数(0または
  // undefinedの場合は表示しない)。server往復無しで、client側の
  // Workspace Context Resolverの結果からそのまま設定する透明性表示用の
  // 値であり、永続化はしない(再読み込みで消える。既存attachmentsの
  // ようにDBへ保存された実体ではないため)。
  workspaceFileCount?: number;
};

type Props = {
  activeSection: TactSection;
  onSelectSection: (section: TactSection) => void;
};

function subscribeToArtifactPreview() {
  return () => {};
}

function getClientArtifactPreview(): Artifact | null {
  return getArtifactPreview(new URLSearchParams(window.location.search).get("artifactPreview"));
}

function getServerArtifactPreview(): undefined {
  return undefined;
}

// LW-P3 Mock E2E Preview(development専用)。artifactPreviewと同じ
// gating pattern(production常時null・useSyncExternalStoreでURL変更を
// 拾う)を踏襲する。
function subscribeToLocalWorkspacePreview() {
  return () => {};
}

function getClientLocalWorkspacePreviewKind(): LocalWorkspacePreviewKind | null {
  return getLocalWorkspacePreviewKind(
    new URLSearchParams(window.location.search).get("localWorkspacePreview")
  );
}

function getServerLocalWorkspacePreviewKind(): null {
  return null;
}

function describeErrorResponse(status: number): string {

  if (status === 401) {
    return "ログインセッションが確認できません。お手数ですが再度ログインしてください。";
  }

  if (status === 400) {
    return "入力内容をご確認のうえ、やり直してください。";
  }

  if (status === 404) {
    return "見つかりませんでした。";
  }

  return "TACTとの通信でエラーが発生しました。しばらくしてから再度お試しください。";

}

// =========================
// groupConversationsByDay (会話一覧を日付でグルーピング)
// =========================
//
// Phase74 Section4「今日/昨日」のグルーピング。過度なライブラリを追加
// せず、今日/昨日の日付文字列を単純比較するだけで十分機能する。
function groupConversationsByDay(
  conversations: ConversationSummary[]
): { label: string; items: ConversationSummary[] }[] {

  const now = new Date();
  const todayKey = now.toDateString();

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayKey = yesterday.toDateString();

  const groups = new Map<string, ConversationSummary[]>();

  for (const conversation of conversations) {

    const updatedAt = new Date(conversation.updatedAt);
    const key = updatedAt.toDateString();

    const label =
      key === todayKey ? "今日" : key === yesterdayKey ? "昨日" : "それ以前";

    const list = groups.get(label) ?? [];
    list.push(conversation);
    groups.set(label, list);

  }

  const order = ["今日", "昨日", "それ以前"];

  return order
    .filter((label) => groups.has(label))
    .map((label) => ({ label, items: groups.get(label)! }));

}

function conversationLabel(conversation: ConversationSummary): string {
  return conversation.title?.trim() || "無題の会話";
}

function formatArtifactHistoryTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

type EmptyStateGreetingPeriod = "morning" | "midday" | "afternoon" | "evening" | "lateNight";

type EmptyStateGreeting = {
  period: EmptyStateGreetingPeriod;
  text: string;
};

const EMPTY_STATE_GREETINGS: Record<EmptyStateGreetingPeriod, readonly string[]> = {
  morning: [
    "おはようございます！",
    "今日も始めましょう。",
    "おはようございます。何から進めますか？",
  ],
  midday: [
    "こんにちは！",
    "今日も進めていきましょう。",
    "何から始めますか？",
  ],
  afternoon: [
    "午後も頑張りましょう！",
    "午後は何から進めますか？",
    "ひとつずつ片付けていきましょう。",
  ],
  evening: [
    "こんばんは！",
    "今日もお疲れさまです。",
    "夜は何を進めますか？",
  ],
  lateNight: [
    "遅い時間までお疲れさまです。",
    "まだ少し進めますか？",
    "無理のない範囲で進めましょう。",
  ],
};

export function getEmptyStateGreetingPeriod(hour: number): EmptyStateGreetingPeriod {
  if (hour < 5) {
    return "lateNight";
  }
  if (hour < 11) {
    return "morning";
  }
  if (hour < 14) {
    return "midday";
  }
  if (hour < 18) {
    return "afternoon";
  }
  if (hour < 23) {
    return "evening";
  }
  return "lateNight";
}

function getLocalEmptyStateGreeting(now: Date): EmptyStateGreeting {
  const period = getEmptyStateGreetingPeriod(now.getHours());
  const greetings = EMPTY_STATE_GREETINGS[period];
  return {
    period,
    text: greetings[Math.floor(Math.random() * greetings.length)],
  };
}

function getMillisecondsUntilNextGreetingPeriod(now: Date): number {
  const next = new Date(now);
  const nextHour = [5, 11, 14, 18, 23].find((hour) => hour > now.getHours());

  if (nextHour === undefined) {
    next.setDate(next.getDate() + 1);
    next.setHours(5, 0, 0, 0);
  } else {
    next.setHours(nextHour, 0, 0, 0);
  }

  return next.getTime() - now.getTime() + 100;
}

// =========================
// buildArtifactMarkdown (Phase77 Section6)
// =========================
//
// core/tact-artifact/blocks.tsのrenderBlocksToPlainText()(Phase76)で
// Artifact.contentを互換フィールドの生成に依存せず、既存の決定論的な
// 関数をそのまま再利用する(新しくMarkdown変換ロジックを増やさない)。
// タイトルを見出しとして先頭に付け、コピーしても「元がArtifactか
// 本文だけでもわかるようにする」。
const ARTIFACT_TABLE_LABELS: Record<string, string> = {
  Metric: "指標",
  Display: "結果",
  Section: "項目",
  Content: "内容",
  Evidence: "根拠",
};

const FRAMEWORK_SECTION_LABELS: Record<string, string> = {
  Strength: "強み",
  Weakness: "弱み",
  Opportunity: "機会",
  Threat: "脅威",
};

function isInternalArtifactColumn(column: string): boolean {
  return ["raw", "formula", "kind"].includes(column.trim().toLowerCase());
}

function isEvidenceArtifactColumn(column: string): boolean {
  return column.trim().toLowerCase() === "evidence";
}

function formatArtifactColumn(column: string): string {
  return ARTIFACT_TABLE_LABELS[column] ?? column;
}

function formatArtifactCell(column: string, value: string): string {
  if (column === "Section") return FRAMEWORK_SECTION_LABELS[value] ?? value;
  if (isEvidenceArtifactColumn(column)) return value ? "根拠あり" : "";
  return value;
}

function getArtifactTableView(table: TableBlock) {
  const visibleIndexes = table.columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !isInternalArtifactColumn(column));

  return {
    visibleIndexes,
    columns: visibleIndexes.map(({ column }) => formatArtifactColumn(column)),
    rows: table.rows.map((row) => visibleIndexes.map(({ column, index }) => formatArtifactCell(column, row[index] ?? ""))),
  };
}

function getArtifactEvidenceSources(artifact: Artifact): Record<string, ArtifactEvidenceSource> {
  const evidenceSources: Record<string, ArtifactEvidenceSource> = {};

  for (const block of artifact.blocks) {
    if (block.type !== "evidence") continue;
    const title = block.title ?? block.source ?? block.claim;
    if (!title && !block.url) continue;
    evidenceSources[block.id] = { id: block.id, title, url: block.url };
  }

  return { ...evidenceSources, ...getArtifactPreviewEvidenceSources(artifact.id) };
}

function getBlockSourceEvidenceIds(block: ArtifactBlock): string[] {
  return "sourceEvidenceIds" in block && Array.isArray(block.sourceEvidenceIds)
    ? block.sourceEvidenceIds
    : [];
}

function getTableCellSourceEvidenceIds(table: TableBlock, rowIndex: number, columnIndex: number, value: string): string[] {
  return table.cellSourceEvidenceIds?.[rowIndex]?.[columnIndex]
    ?? table.rowSourceEvidenceIds?.[rowIndex]
    ?? (value ? [value] : []);
}

function buildArtifactMarkdown(artifact: Artifact): string {
  const body = [...artifact.blocks]
    .sort((a, b) => a.order - b.order)
    .map((block) => {
      if (block.type !== "table") return renderBlocksToPlainText([block]);
      const view = getArtifactTableView(block);
      const heading = block.title ? `## ${block.title}\n\n` : "";
      const header = `| ${view.columns.join(" | ")} |`;
      const divider = `| ${view.columns.map(() => "---").join(" | ")} |`;
      const rows = view.rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
      return `${heading}${header}\n${divider}${rows ? `\n${rows}` : ""}`;
    })
    .filter(Boolean)
    .join("\n\n");
  return body ? `# ${artifact.title}\n\n${body}` : `# ${artifact.title}`;
}

const KNOWLEDGE_KIND_ICON: Record<string, LucideIcon> = {
  document: FileText,
  example: Lightbulb,
  evidence: Link,
  reference: Library,
  artifact: Package,
};

// =========================
// ArtifactBlockView (Phase76)
// =========================
//
// Section11「ブロックをMarkdown表示からArtifact Rendererへ」の、block.typeで
// 分岐し、既存の白基調・シンプルなUIデザイン(Section11「継続」)を保つ。
// 意識するのは、tableは実際のHTML table、chartは最小限のinline SVG棒グラフで
// (Section10「グラフ描画UIを過剰に作り込みすぎない」)新しいchart
// libraryは追加しない。
const BLOCK_TYPE_LABEL: Record<ArtifactBlock["type"], string> = {
  text: "メモ",
  research_summary: "調査概要",
  finding: "発見",
  evidence: "根拠",
  example: "事例",
  table: "比較表",
  chart: "グラフ",
  recommendation: "提案",
  hypothesis: "仮説",
};

// Phase77再実装 Section8: Block種別ごとの視覚的差別化。既存の
// KNOWLEDGE_KIND_ICON(結果一覧タブで同じパターンをArtifact Blockでも
// 適用するだけで)、新しいデザインシステムは作らない。色は左の
// accentとbadgeの淡いトーン差だけに留め、白基調・シンプルUIとborder・
// radiusという既存デザイン(Section8「過剰装飾UIにしない」)を優先する。
const BLOCK_TYPE_ICON: Record<ArtifactBlock["type"], LucideIcon> = {
  text: FileText,
  research_summary: Search,
  finding: Lightbulb,
  evidence: Link,
  example: Pin,
  table: Table2,
  chart: ChartNoAxesCombined,
  recommendation: CircleCheck,
  hypothesis: CircleHelp,
};

const BLOCK_TYPE_STYLE: Record<ArtifactBlock["type"], { accent: string; badge: string }> = {
  text: { accent: "border-l-[#18B5A6]", badge: "bg-[#E6F2F2] text-[#112278]" },
  research_summary: { accent: "border-l-[#18B5A6]", badge: "bg-[#E6F2F2] text-[#112278]" },
  // Section8「finding→重要な発見として目立たせる」
  finding: { accent: "border-l-[#18B5A6]", badge: "bg-[#E6F2F2] text-[#112278]" },
  // Section8「evidence→出典・URL・根拠がわかる」
  evidence: { accent: "border-l-[#18B5A6]", badge: "bg-[#E6F2F2] text-[#112278]" },
  // Section8「example→具体例として扱う」
  example: { accent: "border-l-[#18B5A6]", badge: "bg-[#E6F2F2] text-[#112278]" },
  table: { accent: "border-l-[#18B5A6]", badge: "bg-[#E6F2F2] text-[#112278]" },
  chart: { accent: "border-l-[#18B5A6]", badge: "bg-[#E6F2F2] text-[#112278]" },
  // Section8「recommendation→提案として扱う」
  recommendation: { accent: "border-l-[#18B5A6]", badge: "bg-[#E6F2F2] text-[#112278]" },
  // Section8「hypothesis→未検証の仮説として扱う」
  hypothesis: { accent: "border-l-[#18B5A6]", badge: "bg-[#E6F2F2] text-[#112278]" },
};

const CONFIDENCE_LABEL: Record<string, string> = {
  high: "確度: 高",
  medium: "確度: 中",
  low: "確度: 低",
};

function BarChart({ data }: { data: { label: string; value: number }[] }) {

  const width = 300;
  const barHeight = 16;
  const gap = 5;
  const labelWidth = 88;
  const maxValue = Math.max(1, ...data.map((d) => d.value));
  const chartWidth = width - labelWidth;
  const height = Math.max(42, data.length * (barHeight + gap));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      role="img"
      aria-label="棒グラフ"
      className="max-w-full"
    >
      {data.map((d, i) => {

        const barWidth = Math.max(2, (d.value / maxValue) * chartWidth);
        const y = i * (barHeight + gap);

        return (
          <g key={`${d.label}-${i}`}>
            <text
              x={labelWidth - 6}
              y={y + barHeight / 2 + 4}
              textAnchor="end"
              fontSize="10"
              fill="currentColor"
              className="text-[#626161]"
            >
              {d.label}
            </text>
            <rect x={labelWidth} y={y} width={barWidth} height={barHeight} rx={3} className="fill-[#112278]" />
            <text
              x={labelWidth + barWidth + 4}
              y={y + barHeight / 2 + 4}
              fontSize="10"
              fill="currentColor"
              className="text-[#626161]"
            >
              {d.value}
            </text>
          </g>
        );

      })}
    </svg>
  );

}

function LineChart({ data }: { data: { label: string; value: number }[] }) {

  const width = 300;
  const height = 106;
  const padding = { top: 12, right: 12, bottom: 28, left: 38 };
  const values = data.map((item) => item.value);
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const range = maximum - minimum || 1;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const pointAt = (value: number, index: number) => ({
    x: padding.left + (data.length <= 1 ? plotWidth / 2 : (index / (data.length - 1)) * plotWidth),
    y: padding.top + ((maximum - value) / range) * plotHeight,
  });
  const points = data.map((item, index) => pointAt(item.value, index));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="折れ線グラフ" className="max-w-full">
      <line x1={padding.left} y1={padding.top} x2={padding.left} y2={height - padding.bottom} className="stroke-[#D9D9D9]" />
      <line x1={padding.left} y1={height - padding.bottom} x2={width - padding.right} y2={height - padding.bottom} className="stroke-[#D9D9D9]" />
      <polyline points={points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke="#112278" strokeWidth="2" />
      {data.map((item, index) => {
        const point = points[index];
        return (
          <g key={`${item.label}-${index}`}>
            <circle cx={point.x} cy={point.y} r="3" className="fill-[#18B5A6]" />
            <text x={point.x} y={height - padding.bottom + 15} textAnchor="middle" fontSize="10" fill="currentColor" className="text-[#626161]">{item.label}</text>
            <text x={point.x} y={point.y - 7} textAnchor="middle" fontSize="10" fill="currentColor" className="text-[#626161]">{item.value}</text>
          </g>
        );
      })}
    </svg>
  );

}

function LoadingIndicator() {
  return (
    <p className="flex items-center gap-2 text-xs text-[#626161]">
      <LoaderCircle aria-hidden="true" className="animate-spin text-[#18B5A6]" size={16} strokeWidth={2} />
      読み込み中...
    </p>
  );
}

function KnowledgeKindIcon({ kind }: { kind: string }) {
  const Icon = KNOWLEDGE_KIND_ICON[kind] ?? FileText;
  return <Icon aria-hidden="true" size={16} strokeWidth={2} />;
}

function ArtifactBlockView({
  block,
  evidenceSources,
}: {
  block: ArtifactBlock;
  evidenceSources: Readonly<Record<string, ArtifactEvidenceSource>>;
}) {

  // Phase79 Section13: Table Blockが「比較表」なのか「根拠一覧」なのか
  // タブ表示を切り替える。tablePurposeが無い既存Artifact(Phase76〜78)
  // 由来は「evidence相当」として扱う(後方互換)。
  const label =
    block.type === "table" && block.tablePurpose === "comparison"
      ? "比較表"
      : block.type === "table"
        ? "根拠一覧"
        : BLOCK_TYPE_LABEL[block.type];

  const Icon = BLOCK_TYPE_ICON[block.type];
  const style = BLOCK_TYPE_STYLE[block.type];
  const tableView = block.type === "table" ? getArtifactTableView(block) : null;

  return (
    <div className={`rounded-xl border border-[#D9D9D9] border-l-2 ${style.accent} bg-white p-3`}>

      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${style.badge}`}
        >
          <Icon aria-hidden="true" size={16} strokeWidth={2} />
          {label}
        </span>
        {block.title && (
          <p className="break-words text-sm font-medium text-[#112278]">{block.title}</p>
        )}
      </div>

      {(block.type === "text" || block.type === "research_summary") && (
        <p className="whitespace-pre-wrap text-[15px] leading-6 text-[#112278]">
          {block.content}
        </p>
      )}

      {/* Section8「finding→重要な発見として目立つ」よう太字で強調する。*/}
      {block.type === "finding" && (
        <p className="whitespace-pre-wrap text-[15px] font-medium leading-6 text-[#112278]">
          {block.content}
        </p>
      )}

      {/* Section8「evidence→出典・URL・根拠がわかる」*/}
      {block.type === "evidence" && (
        <div className="space-y-1">
          <p className="text-[15px] leading-6 text-[#112278]">{block.claim}</p>
          {block.data && (
            <p className="whitespace-pre-wrap text-xs text-[#626161]">{block.data}</p>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#626161]">
            {block.source && <span className="truncate">出典: {block.source}</span>}
            {block.confidence && <span>{CONFIDENCE_LABEL[block.confidence]}</span>}
          </div>
        </div>
      )}

      {/* Section8「example→具体例として扱う」*/}
      {block.type === "example" && (
        <p className="whitespace-pre-wrap text-[15px] leading-6 text-[#112278]">
          {block.summary}
        </p>
      )}

      {/* Section8「table→実際のHTML tableとして扱う」*/}
      {block.type === "table" && (
        <div className="overflow-x-auto">
          {/*
            Phase80 Section10(Repository Evidence、Phase79投稿レビューより):
            以前は`w-full`(=親要素の100%に収める)を指定していたが、
            Artifact Panelの実効幅(狭い時は18px)に対して列数が多い
            比較表では`overflow-x-auto`が機能する前に列が圧縮されて
            読めなくなる問題があったため、`min-w-full`(=最低でも100%、内容
            次第で伸びる)に変更し、内容が多い場合は横スクロールを優先
            する(Section10の既存条件)。th/tdにも最低限のmin-widthを与え、
            列が異常に狭くなるのを防ぐ(最小限の変更)。
            新しいレイアウトシステムは追加しない。
          */}
          <table className="min-w-full border-collapse text-xs">
            <thead>
              <tr>
                {tableView?.visibleIndexes.map(({ column: col, index: originalIndex }, i) => (
                  <th
                    key={originalIndex}
                    className={
                      "min-w-[88px] max-w-[200px] whitespace-normal break-words border-b border-[#D9D9D9] px-3 py-2 text-left font-medium text-[#626161]" +
                      // Phase90 Section16: 6列以上の表でも先頭列を固定して
                      // 見比べやすくする(比較表・根拠一覧どちらの列名でも)ため、位置基準を
                      // (sticky、既存のoverflow-x-autoコンテナと組み合わせて機能する)。
                      // 新しいレイアウトシステムは作らない(最小限のクラス追加のみ)。
                      (i === 0 ? " sticky left-0 z-10 bg-[#E6F2F2]" : "")
                    }
                  >
                    {formatArtifactColumn(col)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {tableView?.visibleIndexes.map(({ column, index: originalIndex }, j) => {
                    const cell = row[originalIndex] ?? "";
                    const sourceEvidenceIds = getTableCellSourceEvidenceIds(block, i, originalIndex, cell);
                    return (
                    <td
                      key={originalIndex}
                      className={
                        `${column === "Content" ? "min-w-[220px] max-w-[440px]" : "min-w-[88px] max-w-[200px]"} whitespace-normal break-words border-b border-[#D9D9D9] px-3 py-2 text-[#112278]` +
                        (j === 0 ? " sticky left-0 z-10 bg-white" : "")
                      }
                    >
                      {isEvidenceArtifactColumn(column)
                        ? <ArtifactEvidencePopover compact sourceEvidenceIds={sourceEvidenceIds} evidenceSources={evidenceSources} />
                        : formatArtifactCell(column, cell)}
                    </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {/* Phase79 Section13「evidence/source情報を必ず確認できるようにする」ための
              最小限の「構成」表示。行数が多いTraceability詳細画面を作らず、
              関連するevidence件数だけを表示して、既存より情報量の多いUIを追加
              しつつ、一覧のような作り込みはしない。*/}
          {block.sourceEvidenceIds && block.sourceEvidenceIds.length > 0 && (
            <p className="mt-1.5 text-[10px] text-[#626161]">
              根拠 {block.sourceEvidenceIds.length}件から構成
            </p>
          )}
        </div>
      )}

      {/* Section8「chart→実データを最小限のグラフにして表示する」*/}
      {block.type === "table" && (
        <div className="mt-2">
          <ArtifactEvidencePopover sourceEvidenceIds={getBlockSourceEvidenceIds(block)} evidenceSources={evidenceSources} />
        </div>
      )}

      {block.type === "chart" && (
        <>
          {block.chartType === "line" ? <LineChart data={block.data} /> : <BarChart data={block.data} />}
          <div className="mt-2">
            <ArtifactEvidencePopover sourceEvidenceIds={getBlockSourceEvidenceIds(block)} evidenceSources={evidenceSources} />
          </div>
        </>
      )}

      {/* Section8「recommendation→提案として扱う」 矢印付きの
          アクション形式で表示する。*/}
      {block.type === "recommendation" && (
        <div className="flex items-start gap-1.5">
          <ArrowRight className="mt-0.5 shrink-0 text-[#18B5A6]" aria-hidden="true" size={16} strokeWidth={2} />
          <p className="whitespace-pre-wrap text-[15px] leading-6 text-[#112278]">
            {block.content}
          </p>
        </div>
      )}

      {/* Section8「hypothesis→未検証の仮説であることがわかるように表示する」
          「検証済みの事実」と混同しないよう斜体で表示する。*/}
      {block.type === "hypothesis" && (
        <p className="whitespace-pre-wrap text-[15px] italic leading-6 text-[#112278]">
          {block.content}
        </p>
      )}

    </div>
  );

}

export default function ResearchWorkspace({
  activeSection,
  onSelectSection,
}: Props) {

  const { user, getAccessToken, signOut } = useAuth();

  // LW-P3: 接続UIはここでは描画しない(Coreの
  // LocalWorkspacePanelが唯一の接続/切断UI)。resolveWorkspaceContext()
  // だけを利用する——Workspace未接続/未許可の場合は
  // reason:"not_connected"を即座に返すだけで、directoryHandleへの
  // アクセスは一切発生しない。
  const { resolveWorkspaceContext } = useLocalWorkspace();

  // --- Projects (= Folder) ---
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);

  // --- 選択中のProject(null = 全体/未分類) ---
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  // --- Chat History ---
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("");

  // --- 中央: Conversation Panel ---
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessageView[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentSequenceRef = useRef(0);
  const emptyStateGreetingRef = useRef<EmptyStateGreeting | null>(null);
  const [emptyStateGreeting, setEmptyStateGreeting] = useState<EmptyStateGreeting | null>(null);

  // --- 右: Artifact(成果物) / Knowledge Panel ---
  const [rightTab, setRightTab] = useState<"artifact" | "knowledge">("artifact");
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  // undefined means the client-only preview query has not been resolved yet.
  // Keeping network work paused for that render prevents a preview URL from
  // initiating normal Workspace reads before the fixture is selected.
  const artifactPreview = useSyncExternalStore<Artifact | null | undefined>(
    subscribeToArtifactPreview,
    getClientArtifactPreview,
    getServerArtifactPreview,
  );
  const artifactPreviewActive = artifactPreview !== null;
  const displayedArtifact = artifactPreview ?? artifact;
  const artifactEvidenceSources = displayedArtifact ? getArtifactEvidenceSources(displayedArtifact) : {};

  // LW-P3 Mock E2E Preview。artifactPreviewと同じ理由でuseSyncExternalStore
  // を使う(SSR/CSRでgetSnapshotの不整合が起きないようgetServerSnapshotを
  // 別に渡す)。
  const localWorkspacePreviewKind = useSyncExternalStore<LocalWorkspacePreviewKind | null>(
    subscribeToLocalWorkspacePreview,
    getClientLocalWorkspacePreviewKind,
    getServerLocalWorkspacePreviewKind,
  );

  // Phase77 Section6: Artifactコピー機能。Legacy(components/layout/
  // OutputViewer.tsxのSTEP23)と同じ「コピーしました」表示パターン
  // を踏襲する(新しいUIパターンを増やさない)。
  const [artifactCopied, setArtifactCopied] = useState(false);
  const artifactCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [knowledgeFetched, setKnowledgeFetched] = useState(false);
  const [selectedKnowledgeId, setSelectedKnowledgeId] = useState<string | null>(null);
  const [navigationOpen, setNavigationOpen] = useState(false);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [messages, sending]);

  useEffect(() => {
    let timer: number | undefined;

    function updateEmptyStateGreeting() {
      const now = new Date();
      const period = getEmptyStateGreetingPeriod(now.getHours());

      if (!emptyStateGreetingRef.current || emptyStateGreetingRef.current.period !== period) {
        const nextGreeting = getLocalEmptyStateGreeting(now);
        emptyStateGreetingRef.current = nextGreeting;
        setEmptyStateGreeting(nextGreeting);
      }

      timer = window.setTimeout(updateEmptyStateGreeting, getMillisecondsUntilNextGreetingPeriod(now));
    }

    updateEmptyStateGreeting();

    return () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  useEffect(() => {
    if (!navigationOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setNavigationOpen(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [navigationOpen]);

  // Phase75: conversationIdからArtifactを取得する専用関数。
  // Artifactの作成/更新は行わず、あくまでapplyArtifactMutation()
  // (Turnの副作用)の責務。
  async function fetchArtifact(artifactId: string) {

    if (artifactPreviewActive) {
      return;
    }

    const accessToken = getAccessToken();

    if (!accessToken) {
      return;
    }

    setArtifactLoading(true);

    try {

      const response = await fetch(`/api/tact/artifacts/${artifactId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const body = await response.json();

      if (response.ok && body.success) {
        setArtifact(body.artifact);
      }

    } catch (err) {

      console.error("TACT Artifact fetch failed:", err);

    } finally {

      setArtifactLoading(false);

    }

  }

  // Phase77 Section6: Artifact全体をMarkdownにしてClipboardへコピーする。
  // 既存のArtifact内容自体は変更しない(表示のみ)。Legacy(components/
  // layout/OutputViewer.tsxのSTEP23)と同じ「一定時間だけ成功表示」の
  // パターンを踏襲する。
  function handleCopyArtifact() {

    if (!displayedArtifact) {
      return;
    }

    const text = buildArtifactMarkdown(displayedArtifact);

    if (!text.trim()) {
      return;
    }

    navigator.clipboard
      .writeText(text)
      .then(() => {

        if (artifactCopiedTimerRef.current) {
          clearTimeout(artifactCopiedTimerRef.current);
        }

        setArtifactCopied(true);

        artifactCopiedTimerRef.current = setTimeout(() => {
          setArtifactCopied(false);
          artifactCopiedTimerRef.current = null;
        }, 2000);

      })
      .catch((err) => {
        console.error("TACT Artifact copy failed:", err);
      });

  }

  // ページを開いた最初にProject一覧・Chat History一覧を取得する。
  // (Phase74 Section1「開いた瞬間に情報が自然に確認できる」)。
  // 未ログイン時は何も取得しない(既存ConversationSection.tsxの方針を踏襲)。
  useEffect(() => {

    if (artifactPreviewActive || !user) {
      return;
    }

    const accessToken = getAccessToken();

    if (!accessToken) {
      return;
    }

    let cancelled = false;

    async function loadInitial() {

      setProjectsLoading(true);
      setHistoryLoading(true);

      try {

        const [projectsRes, conversationsRes] = await Promise.all([
          fetch("/api/tact/projects", {
            headers: { Authorization: `Bearer ${accessToken}` },
          }),
          fetch("/api/tact/tact-conversations?limit=50", {
            headers: { Authorization: `Bearer ${accessToken}` },
          }),
        ]);

        if (!cancelled && projectsRes.ok) {
          const body = await projectsRes.json();
          if (body.success) {
            setProjects(Array.isArray(body.projects) ? body.projects : []);
          }
        }

        if (!cancelled && conversationsRes.ok) {
          const body = await conversationsRes.json();
          if (body.success) {
            setConversations(Array.isArray(body.conversations) ? body.conversations : []);
          }
        }

      } catch (err) {

        console.error("TACT Workspace initial load failed:", err);

      } finally {

        if (!cancelled) {
          setProjectsLoading(false);
          setHistoryLoading(false);
        }

      }

    }

    loadInitial();

    return () => {
      cancelled = true;
    };

    // getAccessToken is supplied by the stable auth provider; the preview
    // snapshot is intentionally the network gate for this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactPreview, user]);

  async function refreshHistory(projectId: string | null) {

    if (artifactPreviewActive) {
      return;
    }

    const accessToken = getAccessToken();

    if (!accessToken) {
      return;
    }

    setHistoryLoading(true);

    try {

      const qs = projectId ? `&projectId=${projectId}` : "";

      const response = await fetch(
        `/api/tact/tact-conversations?limit=50${qs}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      const body = await response.json();

      if (response.ok && body.success) {
        setConversations(Array.isArray(body.conversations) ? body.conversations : []);
      }

    } catch (err) {

      console.error("TACT Chat History fetch failed:", err);

    } finally {

      setHistoryLoading(false);

    }

  }

  function handleSelectProject(projectId: string | null) {
    setSelectedProjectId(projectId);
    refreshHistory(projectId);
  }

  async function handleCreateProject() {

    if (artifactPreviewActive) {
      return;
    }

    const name = newProjectName.trim();

    if (!name || creatingProject) {
      return;
    }

    const accessToken = getAccessToken();

    if (!accessToken) {
      return;
    }

    setCreatingProject(true);

    try {

      const response = await fetch("/api/tact/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ name }),
      });

      const body = await response.json();

      if (response.ok && body.success) {
        setProjects((prev) => [body.project, ...prev]);
        setNewProjectName("");
      }

    } catch (err) {

      console.error("TACT Project create failed:", err);

    } finally {

      setCreatingProject(false);

    }

  }

  function handleNewConversation() {

    if (artifactPreviewActive) {
      return;
    }

    setActiveConversationId(null);
    setMessages([]);
    setInput("");
    setAttachments([]);
    setSendError(null);
    setArtifact(null);
  }

  async function handleSelectConversation(id: string) {

    if (artifactPreviewActive) {
      return;
    }

    const accessToken = getAccessToken();

    if (!accessToken || sending) {
      return;
    }

    setSending(true);
    setSendError(null);
    setArtifact(null);

    try {

      // Phase75: messages取得に加え、そのConversationが指すArtifact
      // (artifactId)を取得するためにConversation本体も並行取得する。
      // (Phase66既存のGET /api/tact/tact-conversations/[id]、新規APIは
      // 追加しない。)
      const [messagesRes, conversationRes] = await Promise.all([
        fetch(`/api/tact/tact-conversations/${id}/messages`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
        fetch(`/api/tact/tact-conversations/${id}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      ]);

      const messagesBody = await messagesRes.json();

      if (!messagesRes.ok || !messagesBody.success) {
        setSendError(describeErrorResponse(messagesRes.status));
        return;
      }

      const loaded: ConversationMessageView[] = Array.isArray(messagesBody.messages)
        ? messagesBody.messages.map(
            (m: { id: string; role: ConversationMessageRole; content: string; attachments?: ConversationMessageAttachment[]; createdAt?: string }) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              attachments: Array.isArray(m.attachments) ? m.attachments : [],
              createdAt: m.createdAt,
            })
          )
        : [];

      setActiveConversationId(id);
      setMessages(loaded);
      setRightTab("artifact");

      if (conversationRes.ok) {

        const conversationBody = await conversationRes.json();

        if (conversationBody.success && conversationBody.conversation?.artifactId) {
          fetchArtifact(conversationBody.conversation.artifactId);
        }

      }

    } catch (err) {

      console.error("TACT Conversation messages fetch failed:", err);

      setSendError("会話の読み込みに失敗しました。");

    } finally {

      setSending(false);

    }

  }

  async function uploadAttachment(attachment: ComposerAttachment) {

    if (artifactPreviewActive) {
      return;
    }

    const accessToken = getAccessToken();

    if (!accessToken) {
      setAttachments((current) =>
        applyAttachmentUploadResult(current, attachment.localId, {
          ok: false,
          error: "ログイン後にPDFを添付できます。",
        })
      );
      return;
    }

    const formData = new FormData();
    formData.set("file", attachment.file, attachment.file.name);

    try {

      const response = await fetch("/api/tact/tact-attachments", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: formData,
      });
      const body = await response.json().catch(() => null) as {
        success?: boolean;
        attachment?: { id?: string; extractionStatus?: string };
      } | null;

      const attachmentId = body?.attachment?.id;
      const isReady = body?.attachment?.extractionStatus === "ready";
      setAttachments((current) =>
        applyAttachmentUploadResult(
          current,
          attachment.localId,
          response.ok && body?.success && attachmentId && isReady
            ? { ok: true, attachmentId }
            : {
                ok: false,
                error: isReady === false && response.ok
                  ? "PDFを処理できませんでした。"
                  : "アップロードに失敗しました。",
              }
        )
      );

    } catch (err) {

      console.error("TACT attachment upload failed:", err);

      setAttachments((current) =>
        applyAttachmentUploadResult(current, attachment.localId, {
          ok: false,
          error: "アップロードに失敗しました。",
        })
      );

    }

  }

  function handleAttachmentSelection(event: React.ChangeEvent<HTMLInputElement>) {

    if (artifactPreviewActive) {
      event.currentTarget.value = "";
      return;
    }

    const selectedFiles = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";

    if (selectedFiles.length === 0) {
      return;
    }

    const selectionError = validatePdfSelection(
      attachments.map((attachment) => attachment.file),
      selectedFiles
    );
    if (selectionError) {
      setSendError(selectionError);
      return;
    }

    const nextAttachments = selectedFiles.map((file) => {
      attachmentSequenceRef.current += 1;
      return {
        localId: `attachment-${attachmentSequenceRef.current}`,
        file,
        status: "uploading" as const,
      };
    });

    setAttachments((current) => [...current, ...nextAttachments]);
    setSendError(null);
    nextAttachments.forEach((attachment) => {
      void uploadAttachment(attachment);
    });

  }

  function handleRemoveAttachment(localId: string) {
    setAttachments((current) => removeComposerAttachment(current, localId));
  }

  async function handleSubmit() {

    if (artifactPreviewActive) {
      return;
    }

    const content = input.trim();

    if (!canSubmitConversationTurn({ content, sending, attachments })) {
      return;
    }

    const accessToken = getAccessToken();

    if (!accessToken) {
      setSendError("この機能を使うにはログインが必要です。");
      return;
    }

    const readyAttachmentIds = getReadyAttachmentIds(attachments);
    const userMessageId = crypto.randomUUID();

    // LW-P3: 明示的なWorkspace参照意図がある場合のみ、bounded
    // LocalWorkspaceEvidence[]を組み立てる(最大3file・合計最大5万文字)。
    // LLM/Search APIはここで一切呼ばれない(adapter.resolveWorkspaceContext()
    // 内で完結するclient-side deterministic処理)。Workspace未接続・
    // 意図なし・permission失効・0件のいずれでも例外にせず、
    // used:falseのままResearchを通常通り続行する。
    const workspaceContext = await resolveWorkspaceContext(content).catch(() => ({
      used: false as const,
      evidence: [],
      candidateCount: 0,
      readCount: 0,
    }));

    setMessages((prev) => [
      ...prev,
      {
        id: userMessageId,
        role: "user",
        content,
        attachments: attachments.map((attachment) => ({
          id: attachment.attachmentId!,
          filename: attachment.file.name,
          mimeType: "application/pdf",
          sizeBytes: attachment.file.size,
          extractionStatus: "ready",
        })),
        workspaceFileCount: workspaceContext.used ? workspaceContext.evidence.length : undefined,
      },
    ]);
    setInput("");
    setSending(true);
    setSendError(null);

    try {

      const response = await fetch("/api/tact/tact-conversations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          conversationId: activeConversationId ?? undefined,
          projectId: !activeConversationId && selectedProjectId ? selectedProjectId : undefined,
          content,
          attachmentIds: readyAttachmentIds,
          workspaceEvidence: workspaceContext.used ? workspaceContext.evidence : undefined,
        }),
      });

      const body = await response.json();

      if (!response.ok || !body.success) {
        setSendError(describeErrorResponse(response.status));
        return;
      }

      if (body.conversation?.id) {
        setActiveConversationId(body.conversation.id);
      }

      setAttachments(clearAttachmentsAfterSuccessfulSend());

      if (body.message) {

        setMessages((prev) => [
          ...prev,
          {
            id: body.message.id,
            role: "assistant",
            content: body.message.content,
            createdAt: body.message.createdAt,
          },
        ]);

      }

      setRightTab("artifact");

      // Phase75: このTurnでArtifactが作成/更新された場合はapplyArtifactMutation()
      // の副作用でresponse.conversation.artifactIdが反映されているはず。
      // 常に最新状態を取得し直すことでロールバックが発生している可能性
      // があるため、ローカルstateを推測で更新せず、GETで正を取得し直す。
      if (body.conversation?.artifactId) {
        fetchArtifact(body.conversation.artifactId);
      }

      // Chat History即座反映(新規会話や更新・updated_atの更新を
      // 一覧に反映するため再取得。既存GETをそのまま再利用するだけで、
      // 新しいAPIは追加しない。
      refreshHistory(selectedProjectId);

    } catch (err) {

      console.error("TACT Conversation API call failed:", err);

      setSendError("TACTとの通信で失敗しました。");

    } finally {

      setSending(false);

    }

  }

  async function handleOpenKnowledgeTab() {

    if (artifactPreviewActive) {
      return;
    }

    setRightTab("knowledge");

    if (knowledgeFetched) {
      return;
    }

    const accessToken = getAccessToken();

    if (!accessToken) {
      return;
    }

    setKnowledgeLoading(true);
    setKnowledgeError(null);

    try {

      const response = await fetch("/api/tact/knowledge?limit=30", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const body = await response.json();

      if (!response.ok || !body.success) {
        setKnowledgeError(describeErrorResponse(response.status));
        return;
      }

      setKnowledge(Array.isArray(body.knowledge) ? body.knowledge : []);
      setKnowledgeFetched(true);

    } catch (err) {

      console.error("TACT Knowledge fetch failed:", err);

      setKnowledgeError("過去のResearch結果の取得に失敗しました。");

    } finally {

      setKnowledgeLoading(false);

    }

  }

  const filteredConversations = conversations.filter((c) =>
    conversationLabel(c).toLowerCase().includes(historyFilter.toLowerCase())
  );

  const historyGroups = groupConversationsByDay(filteredConversations);

  const selectedKnowledgeItem =
    knowledge.find((k) => k.id === selectedKnowledgeId) ?? null;

  // LW-P3 Mock E2E Preview: ?localWorkspacePreview=research が有効な
  // development環境でのみ、通常のResearch画面全体を置き換えて
  // debug専用panelを表示する。実Research送信・既存Turn state・
  // Artifact取得等、他のロジックには一切到達しない(早期return)。
  if (localWorkspacePreviewKind) {
    return <LocalWorkspacePreviewPanel />;
  }

  return (

    <div className="relative flex h-full min-w-0 flex-1 overflow-hidden bg-white text-[#112278]">

      {!navigationOpen && (
        <button
          type="button"
          onClick={() => setNavigationOpen(true)}
          aria-controls="research-navigation"
          aria-label="Navigationを開く"
          className="absolute left-3 top-3 z-30 rounded-[10px] border border-[#D9D9D9] bg-white px-2.5 py-1.5 text-[#112278] transition duration-200 ease-out hover:bg-[#E6F2F2] lg:hidden"
        >
          <Menu aria-hidden="true" size={24} strokeWidth={2} />
        </button>
      )}

      {navigationOpen && (
        <button
          type="button"
          aria-label="Navigationを閉じる"
          onClick={() => setNavigationOpen(false)}
          className="fixed inset-0 z-40 bg-black/30 lg:hidden"
        />
      )}

      {/* 左: Navigation(Projects / Chat History) */}
      <aside
        id="research-navigation"
        className={`fixed inset-y-0 left-0 z-50 flex h-full w-[15.25rem] shrink-0 flex-col overflow-hidden border-r border-[#D9D9D9] bg-white transition-transform duration-200 ease-out lg:static lg:z-auto lg:translate-x-0 lg:shadow-none ${
          navigationOpen
            ? "translate-x-0"
            : "invisible pointer-events-none -translate-x-full lg:visible lg:pointer-events-auto"
        }`}
      >

        <div className="border-b border-[#D9D9D9] px-3 py-0.5">
          <ProductLauncher active={activeSection} onSelect={onSelectSection} />
        </div>

        <div className="border-b border-[#D9D9D9] px-3 py-1">

          {/*
            Phase: Research UIヘッダー刷新。TACTブランド(ロゴ+文字ロゴ)は
            TactShell左サイドバーのProductLauncher側で一度だけ表示するため、
            ここでは「TACT Research」の二重表記になっていたブランディング
            ブロック(丸縁付きロゴ+見出し)を廃止した。Project作成・検索UIは
            変更していない。
          */}

          <button
            type="button"
            onClick={() => {
              handleNewConversation();
              setNavigationOpen(false);
            }}
            className="flex h-9 w-full items-center rounded-[6px] border border-transparent bg-[#E6F2F2] px-3 text-left text-[13px] font-medium leading-[18px] text-[#172E95] transition duration-150 ease-out hover:border-[#18B5A6] hover:bg-[#E6F2F2] focus:outline-none focus:ring-2 focus:ring-[#18B5A6]"
          >
            <span className="flex items-center gap-1.5"><MessageSquarePlus aria-hidden="true" size={14} strokeWidth={2} />新しいチャット</span>
          </button>

          <div className="relative mt-1.5">
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#626161]" size={14} strokeWidth={2} />
            <input
              value={historyFilter}
              onChange={(e) => setHistoryFilter(e.target.value)}
              type="text"
              placeholder="検索..."
              className="h-9 w-full rounded-[6px] border border-[#D9D9D9] bg-white pl-8 pr-2.5 text-[13px] leading-[18px] text-[#112278] outline-none transition duration-150 ease-out placeholder:text-[#8A8A8A] focus:border-[#18B5A6] focus:ring-2 focus:ring-[#18B5A6]"
            />
          </div>

        </div>

        <div className="tact-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-2">

          {!user ? (

            <p className="mt-4 rounded-xl border border-[#D9D9D9] bg-white px-3 py-2 text-xs text-[#626161]">
              <a href="/login" className="underline">ログイン</a>すると、Project・過去のチャットが表示されます。
            </p>

          ) : (

            <>

              {/* Projects(=Folder) */}
              <div className="mb-2">

                <p className="mb-2 px-1 text-[13px] font-medium leading-[18px] uppercase tracking-wide text-[#8A8A8A]">
                  プロジェクト
                </p>

                <button
                  type="button"
                  onClick={() => {
                    handleSelectProject(null);
                    setNavigationOpen(false);
                  }}
                  className={`mb-1 block w-full rounded-[10px] px-2.5 py-1 text-left text-xs leading-4 transition duration-150 ease-out ${
                    selectedProjectId === null
                      ? "bg-[#E6F2F2] text-[#172E95] ring-1 ring-[#D9D9D9]"
                      : "text-[#626161] hover:bg-[#E6F2F2]"
                  }`}
                >
                  すべて
                </button>

                {projectsLoading && (
                  <div className="px-2 py-1"><LoadingIndicator /></div>
                )}

                {projects.map((project) => (

                  <button
                    key={project.id}
                    type="button"
                    onClick={() => {
                      handleSelectProject(project.id);
                      setNavigationOpen(false);
                    }}
                    className={`mb-1 flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1 text-left text-xs leading-4 transition duration-150 ease-out ${
                      selectedProjectId === project.id
                        ? "bg-[#E6F2F2] text-[#172E95] ring-1 ring-[#D9D9D9]"
                        : "text-[#626161] hover:bg-[#E6F2F2]"
                    }`}
                    title={project.name}
                  >
                    <Folder aria-hidden="true" size={16} strokeWidth={2} />
                    <span className="truncate">{project.name}</span>
                  </button>

                ))}

                <div className="mt-2 flex items-center gap-1.5">

                  <input
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreateProject()}
                    type="text"
                    placeholder="新しいプロジェクト"
                    disabled={creatingProject || artifactPreviewActive}
                    className="h-9 min-w-0 flex-1 rounded-xl border border-[#D9D9D9] bg-white px-3 text-[13px] leading-[18px] text-[#112278] outline-none transition duration-150 ease-out placeholder:text-[#8A8A8A] focus:border-[#18B5A6] focus:ring-2 focus:ring-[#18B5A6] disabled:bg-[#F2F2F2] disabled:text-[#8A8A8A]"
                  />

                  <button
                    type="button"
                    onClick={handleCreateProject}
                    disabled={creatingProject || artifactPreviewActive || !newProjectName.trim()}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-[#18B5A6] bg-[#18B5A6] text-white transition duration-150 ease-out hover:bg-white hover:text-[#18B5A6] disabled:border-[#F2F2F2] disabled:bg-[#F2F2F2] disabled:text-[#8A8A8A]"
                  >
                    <Plus aria-hidden="true" size={16} strokeWidth={2} />
                  </button>

                </div>

              </div>

              {/* Chat History */}
              <div>

                <p className="mb-2 px-1 text-[13px] font-medium leading-[18px] uppercase tracking-wide text-[#8A8A8A]">
                  チャット履歴
                </p>

                {historyLoading && (
                  <div className="px-2 py-1"><LoadingIndicator /></div>
                )}

                {!historyLoading && filteredConversations.length === 0 && (
                  <p className="px-2 py-1 text-xs text-[#626161]">まだ会話はありません。</p>
                )}

                {historyGroups.map((group) => (

                  <div key={group.label} className="mb-1">

                  <p className="px-1 py-1 text-[10px] font-medium text-[#626161]">{group.label}</p>

                    {group.items.map((conversation) => (

                      <button
                        key={conversation.id}
                        type="button"
                        onClick={() => {
                          handleSelectConversation(conversation.id);
                          setNavigationOpen(false);
                        }}
                        className={`mb-1 flex w-full min-w-0 items-center gap-2 rounded-[10px] px-2.5 py-1 text-left text-xs leading-4 transition duration-150 ease-out ${
                          activeConversationId === conversation.id
                            ? "bg-[#E6F2F2] text-[#172E95] ring-1 ring-[#D9D9D9]"
                            : "text-[#626161] hover:bg-[#E6F2F2]"
                        }`}
                        title={conversationLabel(conversation)}
                      >
                        <MessageCircle aria-hidden="true" className="h-4 w-4 shrink-0" size={16} strokeWidth={2} />
                        <span className="min-w-0 flex-1 truncate">{conversationLabel(conversation)}</span>
                      </button>

                    ))}

                  </div>

                ))}

              </div>

            </>

          )}

        </div>

        <div className="shrink-0 border-t border-[#D9D9D9] px-3 py-2">
          <details className="relative">
            <summary className="cursor-pointer list-none text-xs text-[#626161] marker:content-none">
              アカウント
            </summary>

            <div className="absolute bottom-full left-0 z-[60] mb-2 w-48 rounded-xl border border-[#D9D9D9] bg-white p-2 text-xs shadow-[0_4px_16px_rgba(17,34,120,0.12)] transition duration-150 ease-out">
              {user ? (
                <>
                  <span
                    className="block truncate px-2 py-1.5 text-[#626161]"
                    title={user.email ?? undefined}
                  >
                    {user.email}
                  </span>
                  <button
                    type="button"
                    onClick={() => signOut()}
                    className="block w-full rounded-[10px] px-2 py-1.5 text-left text-[#626161] transition duration-150 ease-out hover:bg-[#E6F2F2]"
                  >
                    ログアウト
                  </button>
                </>
              ) : (
                <a
                  href="/login"
                  className="block rounded-[10px] px-2 py-1.5 text-[#626161] transition duration-150 ease-out hover:bg-[#E6F2F2]"
                >
                  ログイン
                </a>
              )}

              <a
                href="/legacy"
                className="block rounded-[10px] px-2 py-1.5 text-[#8A8A8A] transition duration-150 ease-out hover:bg-[#E6F2F2]"
              >
                旧UIを開く
              </a>
            </div>
          </details>
        </div>

      </aside>

      {/* 中央: Conversation Panel */}
      <div className="flex h-full w-[36%] min-w-72 shrink-0 flex-col overflow-hidden bg-white lg:w-[calc((100%_-_15.25rem)*0.36)]">

        <div className="hidden">

          <h2 className="text-sm font-medium text-[#112278]">
            {selectedProjectId
              ? projects.find((p) => p.id === selectedProjectId)?.name ?? "Conversation"
              : "Conversation"}
          </h2>

          <p className="text-xs text-[#626161]">
            TACT Conversation Architectureを経由してOrchestrator/Research Capabilityとやり取りします。
          </p>

        </div>

        <div className="tact-scrollbar flex-1 space-y-3 overflow-y-auto bg-white px-6 py-5">

          {!user && (
            <p className="rounded-xl border border-[#C53F4B] bg-white px-4 py-3 text-sm text-[#C53F4B]">
              この機能を使うには<a href="/login" className="mx-1 underline">ログイン</a>が必要です。
            </p>
          )}

          {user && messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
              {emptyStateGreeting && (
                <p className="text-sm font-medium leading-5 text-[#112278]">
                  {emptyStateGreeting.text}
                </p>
              )}
              <p className="text-[13px] leading-[18px] text-[#626161]">
                調べたいことを入力してください
              </p>
            </div>
          )}

          {messages.map((message) => (

            <div
              key={message.id}
              className={`block w-full rounded-xl px-3 py-2 text-left text-sm leading-5 ${
                message.role === "user"
                  ? "ml-auto max-w-[85%] bg-[#18B5A6] text-white"
                  : "max-w-[85%] bg-[#E6F2F2] text-[#112278]"
              }`}
            >
              {message.attachments && message.attachments.length > 0 && (
                <div className={`space-y-0.5 text-[13px] leading-[18px] ${message.content ? "mb-1.5" : ""}`}>
                  {getMessageAttachmentFilenames(message.attachments).map((filename, index) => (
                    <p key={`${message.id}-${index}`} className="truncate" title={filename}>
                      {filename}
                    </p>
                  ))}
                </div>
              )}
              {message.content && <p className="whitespace-pre-wrap">{message.content}</p>}
              {/* LW-P3: 透明性表示。Local Workspaceを実際に参照した場合のみ
                  「Local Workspace: Nファイル参照」の1行を出す(0件/未使用時は
                  何も表示しない)。 */}
              {typeof message.workspaceFileCount === "number" && message.workspaceFileCount > 0 && (
                <p
                  className={`mt-1 text-[12px] leading-4 ${
                    message.role === "user" ? "text-white/80" : "text-[#626161]"
                  }`}
                >
                  Local Workspace: {message.workspaceFileCount}ファイル参照
                </p>
              )}
            </div>

          ))}

          {sending && (
            <p className="flex items-center gap-2 text-sm text-[#626161]"><span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-[#18B5A6]" />TACTが応答を作成しています...</p>
          )}

          {sendError && (
            <p className="rounded-xl border border-[#C53F4B] bg-white px-4 py-3 text-sm text-[#C53F4B]">{sendError}</p>
          )}

          <div ref={conversationEndRef} />

        </div>

        <div className="border-t border-[#D9D9D9] bg-white p-3">

          <div className="rounded-xl border border-[#D9D9D9] bg-white px-3 py-2 transition duration-150 ease-out focus-within:border-[#18B5A6] focus-within:ring-2 focus-within:ring-[#18B5A6]">

            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {attachments.map((attachment) => (
                  <div
                    key={attachment.localId}
                    className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-1 text-[13px] leading-[18px] ${
                      attachment.status === "error"
                        ? "border-[#C53F4B] text-[#C53F4B]"
                        : "border-[#D9D9D9] text-[#626161]"
                    }`}
                  >
                    <span className="truncate" title={attachment.file.name}>{attachment.file.name}</span>
                    {shouldShowAttachmentSpinner(attachment.status) && (
                      <span role="status" aria-label="アップロード中" className="inline-flex shrink-0">
                        <span aria-hidden="true" className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
                      </span>
                    )}
                    {attachment.status === "error" && (
                      <span className="shrink-0 text-[10px] leading-[14px]">{attachment.error ?? "エラー"}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRemoveAttachment(attachment.localId)}
                      aria-label={`${attachment.file.name} を削除`}
                      className="shrink-0 text-[16px] leading-none transition duration-150 ease-out hover:text-[#112278] focus:outline-none focus:ring-2 focus:ring-[#18B5A6]"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              type="text"
              placeholder="メッセージを入力..."
              disabled={sending || artifactPreviewActive}
              className="h-5 min-w-0 w-full bg-transparent text-sm leading-5 text-[#112278] outline-none placeholder:text-[#8A8A8A] disabled:text-[#8A8A8A]"
            />

            <div className="mt-2 flex items-center justify-between gap-2">
              <input
                ref={attachmentInputRef}
                type="file"
                accept="application/pdf,.pdf"
                multiple
                onChange={handleAttachmentSelection}
                className="sr-only"
              />
              <button
                type="button"
                onClick={() => attachmentInputRef.current?.click()}
                disabled={sending || artifactPreviewActive}
                aria-label="PDFを添付"
                className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] text-[20px] leading-none text-[#112278] transition duration-150 ease-out hover:bg-[#E6F2F2] focus:outline-none focus:ring-2 focus:ring-[#18B5A6] disabled:text-[#8A8A8A]"
              >
                ＋
              </button>

              <button
                type="button"
                onClick={handleSubmit}
                disabled={artifactPreviewActive || !canSubmitConversationTurn({ content: input, sending, attachments })}
                className="inline-flex h-8 shrink-0 items-center justify-center rounded-[10px] border border-[#18B5A6] bg-[#18B5A6] px-3 text-[13px] font-medium leading-[18px] text-white transition duration-150 ease-out hover:bg-white hover:text-[#18B5A6] disabled:border-[#F2F2F2] disabled:bg-[#F2F2F2] disabled:text-[#8A8A8A]"
              >
                送信
              </button>
            </div>

            {hasPendingAttachment(attachments) && (
              <p className="mt-1.5 text-[10px] leading-[14px] text-[#626161]">PDFのアップロードを完了するか、エラーを削除してから送信できます。</p>
            )}

          </div>

        </div>

      </div>

      {/*
        右: Artifact(成果物) / Knowledge Panel
        UIレイアウト刷新(TactShellの上部ヘッダー廃止・左サイドバーの
        コンパクト化)で確保できた横幅を、成果物の閲覧性向上のため
        このパネルに優先的に割り当てる(w-[24rem]→w-[28rem]、
        xl:w-[26rem]→xl:w-[34rem]へ拡大)。左Navigation・中央
        Conversation Panelの幅は変更していない。
      */}
      <div className="relative hidden h-full min-w-0 flex-1 flex-col overflow-hidden border-l border-[#D9D9D9] bg-white md:flex">

        <div className="shrink-0 bg-white px-5 pt-3">
          <div
            aria-label="成果物の表示を切り替える"
            className="inline-flex h-8 max-w-full items-center gap-1 rounded-[6px] border border-[#D9D9D9] bg-white p-[2px]"
            role="group"
          >
            <button
              type="button"
              aria-pressed={rightTab === "artifact"}
              onClick={() => setRightTab("artifact")}
              className={`h-7 whitespace-nowrap rounded-[2px] px-2.5 text-[13px] font-medium leading-[18px] transition duration-150 ease-out focus:outline-none focus:ring-2 focus:ring-[#18B5A6] ${
                rightTab === "artifact"
                  ? "bg-[#E6F2F2] text-[#172E95]"
                  : "text-[#626161] hover:bg-[#E6F2F2]"
              }`}
            >
              現在の成果物
            </button>

            <button
              type="button"
              aria-pressed={rightTab === "knowledge"}
              onClick={() => void handleOpenKnowledgeTab()}
              className={`h-7 whitespace-nowrap rounded-[2px] px-2.5 text-[13px] font-medium leading-[18px] transition duration-150 ease-out focus:outline-none focus:ring-2 focus:ring-[#18B5A6] ${
                rightTab === "knowledge"
                  ? "bg-[#E6F2F2] text-[#172E95]"
                  : "text-[#626161] hover:bg-[#E6F2F2]"
              }`}
            >
              過去の成果物
            </button>
          </div>
        </div>

        <div className="tact-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 pb-3 pt-2">

          {rightTab === "artifact" ? (

            artifactLoading ? (

              <LoadingIndicator />

            ) : displayedArtifact ? (

              <div className="space-y-3">

                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1 rounded-full border border-[#D9D9D9] bg-[#E6F2F2] px-2 py-0.5 text-[10px] font-medium text-[#112278]">
                    <FileText aria-hidden="true" size={16} strokeWidth={2} />成果物 v{displayedArtifact.version}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyArtifact}
                    className="shrink-0 rounded-[10px] border border-[#D9D9D9] bg-white px-2.5 py-1 text-xs font-medium text-[#112278] transition duration-150 ease-out hover:bg-[#E6F2F2]"
                  >
                    {artifactCopied ? "コピーしました" : "成果物をコピー"}
                  </button>
                </div>

                <p className="text-sm font-medium text-[#112278]">{displayedArtifact.title}</p>

                <div className="space-y-2.5">
                  {[...displayedArtifact.blocks]
                    .sort((a, b) => a.order - b.order)
                    .map((block) => (
                      <ArtifactBlockView key={block.id} block={block} evidenceSources={artifactEvidenceSources} />
                    ))}
                </div>

              </div>

            ) : (

              <div className="flex min-h-full flex-col items-center justify-center gap-3 text-center">
                <Image
                  src="/research-assets/artifact-empty-state.svg"
                  alt=""
                  width={104}
                  height={106}
                  className="h-[72px] w-auto"
                  unoptimized
                />
                <p className="text-[13px] leading-[18px] text-[#626161]">
                  成果物はここに表示されます
                </p>
              </div>

            )

          ) : (

            <div className="min-w-0">

              <div className="mb-3 flex h-8 items-center">
                <span className="inline-flex rounded-full bg-[#E6F2F2] px-2.5 py-1 text-[13px] font-medium leading-[18px] text-[#172E95]">
                  すべて
                </span>
              </div>

              {knowledgeLoading && (
                <LoadingIndicator />
              )}

              {knowledgeError && (
                <p className="rounded-xl border border-[#C53F4B] bg-white px-4 py-3 text-sm text-[#C53F4B]">{knowledgeError}</p>
              )}

              {!knowledgeLoading && !knowledgeError && knowledge.length === 0 && (
                <p className="text-sm text-[#626161]">
                  過去の成果物はありません。
                </p>
              )}

              {selectedKnowledgeItem ? (

                <div className="min-w-0 space-y-3">

                  <button
                    type="button"
                    onClick={() => setSelectedKnowledgeId(null)}
                    className="inline-flex h-8 items-center gap-1 text-[13px] leading-[18px] text-[#626161] transition duration-150 ease-out hover:text-[#112278] focus:outline-none focus:ring-2 focus:ring-[#18B5A6]"
                  >
                    <ArrowLeft aria-hidden="true" size={16} strokeWidth={2} />一覧へ戻る
                  </button>

                  <p className="flex min-w-0 items-center gap-2 text-sm font-medium leading-5 text-[#112278]">
                    <span className="shrink-0"><KnowledgeKindIcon kind={selectedKnowledgeItem.kind} /></span>
                    <span className="min-w-0 truncate" title={selectedKnowledgeItem.title}>{selectedKnowledgeItem.title}</span>
                  </p>

                  <p className="whitespace-pre-wrap break-words text-sm leading-5 text-[#626161]">
                    {selectedKnowledgeItem.content}
                  </p>

                </div>

              ) : (

                <ul className="space-y-2 overflow-x-hidden">

                  {knowledge.map((item) => (

                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedKnowledgeId(item.id)}
                        className="grid h-12 w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 overflow-hidden rounded-[6px] border border-[#D9D9D9] bg-white px-3 text-left text-sm leading-5 text-[#112278] transition duration-150 ease-out hover:border-[#18B5A6] hover:bg-[#E6F2F2] focus:outline-none focus:ring-2 focus:ring-[#18B5A6]"
                        title={item.title}
                      >
                        <span className="shrink-0 text-[#626161]"><KnowledgeKindIcon kind={item.kind} /></span>
                        <span className="min-w-0 truncate font-medium">{item.title}</span>
                        <time className="shrink-0 whitespace-nowrap text-[12px] leading-4 text-[#626161]" dateTime={item.updatedAt}>
                          {formatArtifactHistoryTimestamp(item.updatedAt)}
                        </time>
                        <ChevronRight aria-hidden="true" className="shrink-0 text-[#626161]" size={16} strokeWidth={2} />
                      </button>
                    </li>

                  ))}

                </ul>

              )}

            </div>

          )}

        </div>

      </div>

    </div>

  );

}
