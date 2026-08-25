"use client";

// =========================
// ResearchWorkspace (Phase 74、Phase75でArtifact右パネルへ進化)
// =========================
//
// Phase75: 右パネルを「Research結果一覧の表示場所」から「現在の
// Artifact(成果物)を閲覧する場所」へ置き換えた(Section13「右側は
// 現在のArtifactを閲覧・更新する場所へ進化させる」)。Artifactの実体は
// core/tact-conversation/orchestration.tsのapplyArtifactMutation()が
// Turnの副作用として作成・更新する(このコンポーネント自体はArtifactを
// 直接書き込まない、読み取り専用のGET /api/tact/artifacts/[id]
// だけを呼ぶ)。
//
// Phase73 Investigationの結論に基づく、TACT Researchの新しい入口。
// 「ChatGPTのようなチャット画面」ではなく、Project(=Folder)・
// Chat History・Conversation・Research結果/Knowledgeを1つの画面で
// 扱えるWorkspaceとして再構成する(Phase74 Section1〜2)。
//
// Repository Evidence(Phase73/74):
//   - core/tact-project/*(Phase30/31、既存・無変更)をProject=Folder
//     としてそのまま利用する(新しいFolder entityは作らない)。
//   - core/tact-conversation/*・/api/tact/tact-conversations*
//     (Phase64〜69、既存)をConversation Panelの実装にそのまま使う。
//     Phase74で追加した唯一のBackend変更は
//     tact_conversations.project_id(nullable FK、Phase73 Case B)と、
//     それを受け渡すstore.ts/route.tsの最小拡張のみ。
//   - core/tact-orchestrator/*・core/tact-research/*は無変更
//     (Phase74 Section7「既存Backendを無駄に作り直さない」)。
//   - Research結果は既にOrchestrator経由でtact_core_knowledgeへ自動
//     書き込みされている(memoryWriter.ts、Phase5、無変更)。これを
//     閲覧するためだけの新規GET /api/tact/knowledge(Phase74で追加、
//     読み取り専用、recordKnowledge()等の書き込み経路には触れない)。
//
// Phase70のConversationSection.tsxはトップレベルSectionとしては
// 廃止したが、ファイル自体は削除していない(認証・エラー処理・
// メッセージ表示のロジックパターンをこのWorkspace内のConversation
// Panelへ移植・再利用した——CLAUDE.mdの既存方針により、無関係な削除は
// 行わない)。

import { useEffect, useRef, useState } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import type { Project } from "@/core/tact-project/types";
import type {
  ConversationMessageRole,
  ConversationSummary,
} from "@/core/tact-conversation/types";
import type { KnowledgeItem } from "@/core/tact-core";
import type { Artifact, ArtifactBlock } from "@/core/tact-artifact/types";
import { renderBlocksToPlainText } from "@/core/tact-artifact/blocks";

type ConversationMessageView = {
  id: string;
  role: ConversationMessageRole;
  content: string;
  createdAt?: string;
};

function describeErrorResponse(status: number): string {

  if (status === 401) {
    return "ログイン状態が確認できませんでした。再度ログインしてください。";
  }

  if (status === 400) {
    return "入力内容を確認してください。";
  }

  if (status === 404) {
    return "見つかりませんでした。";
  }

  return "TACTとの通信でエラーが発生しました。しばらくしてから再度お試しください。";

}

// =========================
// groupConversationsByDay (純粋関数)
// =========================
//
// Phase74 Section4「今日/昨日」のグルーピング。過度なライブラリを
// 導入せず、日付文字列の単純な比較だけで十分成立する。

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

// =========================
// buildArtifactMarkdown (Phase77 Section6)
// =========================
//
// core/tact-artifact/blocks.tsのrenderBlocksToPlainText()(Phase76、
// Artifact.content互換フィールドの生成に使っている既存の決定論的
// 関数)をそのまま再利用する(新しいMarkdown変換ロジックを増やさない)。
// タイトルを見出しとして先頭に付け、コピーした際に「何のArtifactか」
// が本文だけでも分かるようにする。
function buildArtifactMarkdown(artifact: Artifact): string {
  const body = renderBlocksToPlainText(artifact.blocks);
  return body ? `# ${artifact.title}\n\n${body}` : `# ${artifact.title}`;
}

const KNOWLEDGE_KIND_ICON: Record<string, string> = {
  document: "📄",
  example: "📝",
  evidence: "📚",
  reference: "🔗",
  artifact: "🗂️",
};

// =========================
// ArtifactBlockView (Phase76)
// =========================
//
// Section11「単なるMarkdown表示からArtifact Rendererへ」。block.typeで
// 分岐し、既存の白基調・シンプルなUIデザイン(Section11「維持する」)を
// 踏襲する。Table→実際のHTML table、Chart→最小限のinline SVG棒グラフ
// (Section10「グラフ描画UIを過剰に作り込まない」、新しいchart
// libraryは追加しない)。

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
// KNOWLEDGE_KIND_ICON(絵文字バッジ)と同じパターンをArtifact Blockにも
// 適用するだけで、新しいデザインシステムは作らない。色は左のaccent
// borderとbadgeの淡い背景色のみに留め、白基調・薄いborder・小さめ
// radiusという既存デザイン(Section8「派手なUIにはしない」)を維持する。
const BLOCK_TYPE_ICON: Record<ArtifactBlock["type"], string> = {
  text: "📄",
  research_summary: "🧭",
  finding: "💡",
  evidence: "📚",
  example: "📝",
  table: "📊",
  chart: "📈",
  recommendation: "✅",
  hypothesis: "🧪",
};

const BLOCK_TYPE_STYLE: Record<ArtifactBlock["type"], { accent: string; badge: string }> = {
  text: { accent: "border-l-gray-200", badge: "bg-gray-100 text-gray-500" },
  research_summary: { accent: "border-l-gray-300", badge: "bg-gray-100 text-gray-600" },
  // Section8「Finding→重要な発見として目立つ」。
  finding: { accent: "border-l-amber-400", badge: "bg-amber-50 text-amber-700" },
  // Section8「Evidence→出典・URL・根拠が分かる」。
  evidence: { accent: "border-l-blue-300", badge: "bg-blue-50 text-blue-700" },
  // Section8「Example→具体例として読みやすい」。
  example: { accent: "border-l-slate-300", badge: "bg-slate-50 text-slate-600" },
  table: { accent: "border-l-gray-300", badge: "bg-gray-100 text-gray-600" },
  chart: { accent: "border-l-gray-300", badge: "bg-gray-100 text-gray-600" },
  // Section8「Recommendation→施策として読みやすい」。
  recommendation: { accent: "border-l-emerald-400", badge: "bg-emerald-50 text-emerald-700" },
  // Section8「Hypothesis→今後検証すべき仮説として読みやすい」。
  hypothesis: { accent: "border-l-violet-300", badge: "bg-violet-50 text-violet-700" },
};

const CONFIDENCE_LABEL: Record<string, string> = {
  high: "確信度: 高",
  medium: "確信度: 中",
  low: "確信度: 低",
};

function BarChart({ data }: { data: { label: string; value: number }[] }) {

  const width = 300;
  const barHeight = 22;
  const gap = 8;
  const labelWidth = 88;
  const maxValue = Math.max(1, ...data.map((d) => d.value));
  const chartWidth = width - labelWidth;
  const height = data.length * (barHeight + gap);

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
              className="text-gray-600"
            >
              {d.label}
            </text>
            <rect x={labelWidth} y={y} width={barWidth} height={barHeight} rx={3} className="fill-gray-800" />
            <text
              x={labelWidth + barWidth + 4}
              y={y + barHeight / 2 + 4}
              fontSize="10"
              fill="currentColor"
              className="text-gray-600"
            >
              {d.value}
            </text>
          </g>
        );

      })}
    </svg>
  );

}

function ArtifactBlockView({ block }: { block: ArtifactBlock }) {

  // Phase79 Section13: Table Blockは「比較表」か「根拠一覧」かで
  // バッジ表示を切り替える(tablePurposeが無い既存Artifact——Phase76〜78
  // 由来——はevidence相当として扱う、後方互換)。
  const label =
    block.type === "table" && block.tablePurpose === "comparison"
      ? "比較表"
      : block.type === "table"
        ? "根拠一覧"
        : BLOCK_TYPE_LABEL[block.type];

  const icon = BLOCK_TYPE_ICON[block.type];
  const style = BLOCK_TYPE_STYLE[block.type];

  return (
    <div className={`rounded-lg border border-gray-200 border-l-2 ${style.accent} bg-white p-3`}>

      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${style.badge}`}
        >
          <span aria-hidden="true">{icon}</span>
          {label}
        </span>
        {block.title && (
          <p className="text-sm font-semibold text-gray-900">{block.title}</p>
        )}
      </div>

      {(block.type === "text" || block.type === "research_summary") && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-900">
          {block.content}
        </p>
      )}

      {/* Section8「Finding→重要な発見として目立つ」: 太字で強調する。 */}
      {block.type === "finding" && (
        <p className="whitespace-pre-wrap text-sm font-medium leading-relaxed text-gray-900">
          {block.content}
        </p>
      )}

      {/* Section8「Evidence→出典・URL・根拠が分かる」。 */}
      {block.type === "evidence" && (
        <div className="space-y-1">
          <p className="text-sm leading-relaxed text-gray-900">{block.claim}</p>
          {block.data && (
            <p className="whitespace-pre-wrap text-xs text-gray-500">{block.data}</p>
          )}
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
            {block.source && <span className="truncate">出典: {block.source}</span>}
            {block.confidence && <span>{CONFIDENCE_LABEL[block.confidence]}</span>}
          </div>
        </div>
      )}

      {/* Section8「Example→具体例として読みやすい」。 */}
      {block.type === "example" && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
          {block.summary}
        </p>
      )}

      {/* Section8「Table→実際のHTML tableとして読みやすい」。 */}
      {block.type === "table" && (
        <div className="overflow-x-auto">
          {/*
            Phase80 Section10(Repository Evidence、Phase79投資調査):
            以前は`w-full`(=親要素の100%に必ず収まる)を指定しており、
            Artifact Panelの実効幅(約318px)に対し列数・文字数が多い
            比較表は、overflow-x-autoが機能する前に列の方が際限なく
            圧縮されていた。`min-w-full`(=最低でも100%、内容次第で
            それ以上に広がれる)へ変更し、内容が多い場合は実際に
            横スクロールできるようにする(「画面幅に無理やり収める」
            のではなく「必要なら横スクロールできる」ことを優先、
            Section10絶対条件)。各th/tdにも最低限のmin-widthを与え、
            列が判読不能なほど圧縮されることを防ぐ(最小限の変更、
            新しいレイアウトシステムは導入しない)。
          */}
          <table className="min-w-full border-collapse text-xs">
            <thead>
              <tr>
                {block.columns.map((col, i) => (
                  <th
                    key={i}
                    className={
                      "min-w-[88px] max-w-[200px] whitespace-normal break-words border-b border-gray-200 px-2 py-1 text-left font-medium text-gray-500" +
                      // Phase90 Section16: 6列以上でも横スクロールを正式なUXとして
                      // 採用し、1列目(比較対象の名前)だけは常に見える状態にする
                      // (sticky、既存のoverflow-x-autoコンテナと組み合わせて機能する。
                      // 新しいレイアウトシステムは導入しない、最小限のクラス追加のみ)。
                      (i === 0 ? " sticky left-0 z-10 bg-gray-50" : "")
                    }
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className={
                        "min-w-[88px] max-w-[200px] whitespace-normal break-words border-b border-gray-100 px-2 py-1 text-gray-900" +
                        (j === 0 ? " sticky left-0 z-10 bg-white" : "")
                      }
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {/* Phase79 Section13「Evidence/source情報を必要に応じて確認
              できる構造」。行単位のTraceabilityは詳細画面を作らず、
              合計根拠件数だけを軽く示す(既存の情報量の多いUIを維持
              しつつ、過剰な作り込みはしない)。 */}
          {block.sourceEvidenceIds && block.sourceEvidenceIds.length > 0 && (
            <p className="mt-1.5 text-[10px] text-gray-400">
              根拠 {block.sourceEvidenceIds.length}件から構成
            </p>
          )}
        </div>
      )}

      {/* Section8「Chart→実データに基づくグラフとして読みやすい」。 */}
      {block.type === "chart" && <BarChart data={block.data} />}

      {/* Section8「Recommendation→施策として読みやすい」: 矢印付きの
          アクション形式で表示する。 */}
      {block.type === "recommendation" && (
        <div className="flex items-start gap-1.5">
          <span className="mt-0.5 text-emerald-600" aria-hidden="true">→</span>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-900">
            {block.content}
          </p>
        </div>
      )}

      {/* Section8「Hypothesis→今後検証すべき仮説として読みやすい」:
          「検証済みの事実」と区別できるよう斜体で表示する。 */}
      {block.type === "hypothesis" && (
        <p className="whitespace-pre-wrap text-sm italic leading-relaxed text-gray-700">
          {block.content}
        </p>
      )}

    </div>
  );

}

export default function ResearchWorkspace() {

  const { user, getAccessToken } = useAuth();

  // --- Projects (= Folder) ---
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);

  // --- 選択中のProject(null = 全体/未所属) ---
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  // --- Chat History ---
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("");

  // --- 中央: Conversation Panel ---
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessageView[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // --- 右: Artifact(成果物) / Knowledge Panel ---
  const [rightTab, setRightTab] = useState<"artifact" | "knowledge">("artifact");
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);

  // Phase77 Section6: Artifactコピー機能。Legacy(components/layout/
  // OutputViewer.tsx、STEP23)と同じ「コピーしました」一時表示パターン
  // を踏襲する(新しいUIパターンを増やさない)。
  const [artifactCopied, setArtifactCopied] = useState(false);
  const artifactCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [knowledgeFetched, setKnowledgeFetched] = useState(false);
  const [selectedKnowledgeId, setSelectedKnowledgeId] = useState<string | null>(null);

  // Phase75: conversationIdからArtifactを取得する(読み取り専用、
  // Artifactの作成/更新は行わない——それはapplyArtifactMutation()
  // (Turnの副作用)の責務)。
  async function fetchArtifact(artifactId: string) {

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

  // Phase77 Section6: Artifact全体をMarkdownとしてClipboardへコピーする。
  // 既存Artifact内容は変更しない(読み取りのみ)。Legacy(components/
  // layout/OutputViewer.tsx、STEP23)と同じ「2秒間だけ成功表示」の
  // パターンを踏襲する。
  function handleCopyArtifact() {

    if (!artifact) {
      return;
    }

    const text = buildArtifactMarkdown(artifact);

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

  // ページを開いた時点でProject一覧・Chat History一覧を取得する
  // (Phase74 Section1「開いたら過去の活動が自然に確認できる」)。
  // 未ログイン時は何も取得しない(既存ConversationSection.tsxの方針を継続)。
  useEffect(() => {

    if (!user) {
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

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function refreshHistory(projectId: string | null) {

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
    setActiveConversationId(null);
    setMessages([]);
    setInput("");
    setSendError(null);
    setArtifact(null);
  }

  async function handleSelectConversation(id: string) {

    const accessToken = getAccessToken();

    if (!accessToken || sending) {
      return;
    }

    setSending(true);
    setSendError(null);
    setArtifact(null);

    try {

      // Phase75: messages取得に加え、そのConversationが指すArtifact
      // (artifactId)を得るためにConversation本体も並行取得する
      // (Phase66既存GET /api/tact/tact-conversations/[id]、新規APIは
      // 追加しない)。
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
            (m: { id: string; role: ConversationMessageRole; content: string; createdAt?: string }) => ({
              id: m.id,
              role: m.role,
              content: m.content,
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

  async function handleSubmit() {

    const content = input.trim();

    if (!content || sending) {
      return;
    }

    const accessToken = getAccessToken();

    if (!accessToken) {
      setSendError("この機能を使うにはログインが必要です。");
      return;
    }

    const userMessageId = crypto.randomUUID();

    setMessages((prev) => [...prev, { id: userMessageId, role: "user", content }]);
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

      // Phase75: このTurnでArtifactが作成/更新された場合(applyArtifactMutation()
      // の副作用)、response.conversation.artifactIdへ反映されている。
      // 常に最新状態を取り直す(バージョンが上がっている可能性があるため、
      // ローカルstateを推測で更新せず、GETで正を取得する)。
      if (body.conversation?.artifactId) {
        fetchArtifact(body.conversation.artifactId);
      }

      // Chat Historyへ即時反映(新規会話の作成・updated_atの更新を
      // 一覧へ反映するための再取得。既存GETをそのまま再利用するだけで、
      // 新しいAPIは追加しない)。
      refreshHistory(selectedProjectId);

    } catch (err) {

      console.error("TACT Conversation API call failed:", err);

      setSendError("TACTとの通信に失敗しました");

    } finally {

      setSending(false);

    }

  }

  async function handleOpenKnowledgeTab() {

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

  return (

    <div className="flex h-full min-w-0 flex-1">

      {/* 左: Navigation(Projects / Chat History) */}
      <div className="flex h-full w-64 shrink-0 flex-col border-r border-gray-200 bg-gray-50/50">

        <div className="border-b border-gray-100 p-3">

          <p className="mb-2 text-xs font-semibold text-gray-900">TACT Research</p>

          <button
            type="button"
            onClick={handleNewConversation}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-left text-xs text-gray-700 transition hover:border-gray-400"
          >
            ＋ 新しいチャット
          </button>

          <input
            value={historyFilter}
            onChange={(e) => setHistoryFilter(e.target.value)}
            type="text"
            placeholder="検索..."
            className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 outline-none placeholder:text-gray-400"
          />

        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2">

          {!user ? (

            <p className="mt-4 text-xs text-gray-400">
              <a href="/login" className="underline">ログイン</a>すると、Project・過去のチャットが表示されます。
            </p>

          ) : (

            <>

              {/* Projects(=Folder) */}
              <div className="mb-4">

                <p className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  プロジェクト
                </p>

                <button
                  type="button"
                  onClick={() => handleSelectProject(null)}
                  className={`mb-0.5 block w-full rounded-md px-2 py-1 text-left text-xs transition ${
                    selectedProjectId === null
                      ? "bg-gray-200 text-gray-900"
                      : "text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  すべて
                </button>

                {projectsLoading && (
                  <p className="px-2 py-1 text-[11px] text-gray-400">読み込み中...</p>
                )}

                {projects.map((project) => (

                  <button
                    key={project.id}
                    type="button"
                    onClick={() => handleSelectProject(project.id)}
                    className={`mb-0.5 block w-full truncate rounded-md px-2 py-1 text-left text-xs transition ${
                      selectedProjectId === project.id
                        ? "bg-gray-200 text-gray-900"
                        : "text-gray-600 hover:bg-gray-100"
                    }`}
                    title={project.name}
                  >
                    📁 {project.name}
                  </button>

                ))}

                <div className="mt-1.5 flex items-center gap-1">

                  <input
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreateProject()}
                    type="text"
                    placeholder="新しいプロジェクト"
                    disabled={creatingProject}
                    className="min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] outline-none placeholder:text-gray-400 disabled:opacity-50"
                  />

                  <button
                    type="button"
                    onClick={handleCreateProject}
                    disabled={creatingProject || !newProjectName.trim()}
                    className="shrink-0 rounded-md border border-gray-300 px-1.5 py-1 text-[11px] text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                  >
                    ＋
                  </button>

                </div>

              </div>

              {/* Chat History */}
              <div>

                <p className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  チャット履歴
                </p>

                {historyLoading && (
                  <p className="px-2 py-1 text-[11px] text-gray-400">読み込み中...</p>
                )}

                {!historyLoading && filteredConversations.length === 0 && (
                  <p className="px-2 py-1 text-[11px] text-gray-400">まだ会話はありません。</p>
                )}

                {historyGroups.map((group) => (

                  <div key={group.label} className="mb-2">

                    <p className="px-1 py-1 text-[10px] text-gray-400">{group.label}</p>

                    {group.items.map((conversation) => (

                      <button
                        key={conversation.id}
                        type="button"
                        onClick={() => handleSelectConversation(conversation.id)}
                        className={`mb-0.5 block w-full truncate rounded-md px-2 py-1 text-left text-xs transition ${
                          activeConversationId === conversation.id
                            ? "bg-gray-200 text-gray-900"
                            : "text-gray-600 hover:bg-gray-100"
                        }`}
                        title={conversationLabel(conversation)}
                      >
                        💬 {conversationLabel(conversation)}
                      </button>

                    ))}

                  </div>

                ))}

              </div>

            </>

          )}

        </div>

      </div>

      {/* 中央: Conversation Panel */}
      <div className="flex h-full min-w-0 flex-1 flex-col border-r border-gray-200">

        <div className="border-b border-gray-200 px-5 py-3">

          <h2 className="text-sm font-semibold text-gray-900">
            {selectedProjectId
              ? projects.find((p) => p.id === selectedProjectId)?.name ?? "Conversation"
              : "Conversation"}
          </h2>

          <p className="text-xs text-gray-400">
            TACT Conversation Architecture経由でOrchestrator/Research Capabilityと対話します。
          </p>

        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">

          {!user && (
            <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
              この機能を使うには<a href="/login" className="mx-1 underline">ログイン</a>が必要です。
            </p>
          )}

          {user && messages.length === 0 && (
            <p className="text-sm text-gray-400">
              まだ会話はありません。下の入力欄から話しかけてみてください。
            </p>
          )}

          {messages.map((message) => (

            <div
              key={message.id}
              className={`block w-full rounded-xl px-4 py-2.5 text-left text-sm ${
                message.role === "user"
                  ? "ml-auto max-w-[85%] bg-black text-white"
                  : "max-w-[85%] border border-gray-200 bg-gray-50 text-gray-900"
              }`}
            >
              <p className="whitespace-pre-wrap">{message.content || "…"}</p>
            </div>

          ))}

          {sending && (
            <p className="text-sm text-gray-400">TACTが応答を準備しています...</p>
          )}

          {sendError && (
            <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{sendError}</p>
          )}

        </div>

        <div className="border-t border-gray-200 p-3">

          <div className="flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-3 py-2">

            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              type="text"
              placeholder="メッセージを入力..."
              disabled={sending}
              className="flex-1 bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400 disabled:opacity-50"
            />

            <button
              type="button"
              onClick={handleSubmit}
              disabled={sending}
              className="shrink-0 rounded-lg bg-black px-3 py-1.5 text-xs text-white transition hover:bg-gray-800 disabled:opacity-50"
            >
              送信
            </button>

          </div>

        </div>

      </div>

      {/* 右: Artifact(成果物) / Knowledge Panel */}
      <div className="hidden h-full w-96 shrink-0 flex-col overflow-y-auto md:flex">

        <div className="flex border-b border-gray-200 px-4 pt-3">

          <button
            type="button"
            onClick={() => setRightTab("artifact")}
            className={`border-b-2 px-2 pb-2 text-xs font-medium ${
              rightTab === "artifact"
                ? "border-black text-gray-900"
                : "border-transparent text-gray-400 hover:text-gray-600"
            }`}
          >
            成果物
          </button>

          <button
            type="button"
            onClick={handleOpenKnowledgeTab}
            className={`border-b-2 px-2 pb-2 text-xs font-medium ${
              rightTab === "knowledge"
                ? "border-black text-gray-900"
                : "border-transparent text-gray-400 hover:text-gray-600"
            }`}
          >
            過去のResearch/Knowledge
          </button>

        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">

          {rightTab === "artifact" ? (

            artifactLoading ? (

              <p className="text-sm text-gray-400">読み込み中...</p>

            ) : artifact ? (

              <div className="space-y-3">

                <div className="flex items-center justify-between">
                  <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
                    📄 成果物 · v{artifact.version}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyArtifact}
                    className="shrink-0 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-700 transition hover:bg-gray-50"
                  >
                    {artifactCopied ? "コピーしました" : "成果物をコピー"}
                  </button>
                </div>

                <p className="text-sm font-semibold text-gray-900">{artifact.title}</p>

                <div className="space-y-2.5">
                  {[...artifact.blocks]
                    .sort((a, b) => a.order - b.order)
                    .map((block) => (
                      <ArtifactBlockView key={block.id} block={block} />
                    ))}
                </div>

              </div>

            ) : (

              <p className="text-sm text-gray-400">
                この会話ではまだ成果物が作成されていません。調査や具体的な作業指示を送ると、ここに成果物が育っていきます。
              </p>

            )

          ) : (

            <div className="space-y-3">

              {knowledgeLoading && (
                <p className="text-sm text-gray-400">読み込み中...</p>
              )}

              {knowledgeError && (
                <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{knowledgeError}</p>
              )}

              {!knowledgeLoading && !knowledgeError && knowledge.length === 0 && (
                <p className="text-sm text-gray-400">
                  まだ蓄積されたResearch結果・Knowledgeはありません。
                </p>
              )}

              {selectedKnowledgeItem ? (

                <div className="space-y-2">

                  <button
                    type="button"
                    onClick={() => setSelectedKnowledgeId(null)}
                    className="text-xs text-gray-400 hover:text-gray-600"
                  >
                    ← 一覧へ戻る
                  </button>

                  <p className="text-sm font-medium text-gray-900">
                    {KNOWLEDGE_KIND_ICON[selectedKnowledgeItem.kind] ?? "📄"} {selectedKnowledgeItem.title}
                  </p>

                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                    {selectedKnowledgeItem.content}
                  </p>

                </div>

              ) : (

                <ul className="space-y-1.5">

                  {knowledge.map((item) => (

                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedKnowledgeId(item.id)}
                        className="block w-full truncate rounded-lg border border-gray-200 px-3 py-2 text-left text-xs text-gray-700 transition hover:border-gray-300"
                        title={item.title}
                      >
                        {KNOWLEDGE_KIND_ICON[item.kind] ?? "📄"} {item.title}
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
