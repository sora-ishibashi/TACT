import type { StatusTone } from "../ui/StatusBadge";
import type { ServiceName } from "./ServiceBadge";

export type PreviewStatus = {
  label: string;
  tone: StatusTone;
  showActivity?: boolean;
};

export type PreviewProgressStep = {
  id: string;
  label: string;
  detail: string;
  status: PreviewStatus;
};

export type PreviewActivity = {
  time: string;
  message: string;
  service?: ServiceName;
  status: PreviewStatus;
};

export type PreviewApproval = {
  service: ServiceName;
  actionLabel: string;
  target: string;
  summary: string;
  fields: Array<{ label: string; value: string }>;
  changes: string[];
  effects: string[];
  warnings: string[];
};

export type PreviewClarification = {
  question: string;
  placeholder: string;
};

export type PreviewCandidateSlot = {
  id: string;
  label: string;
  description: string;
};

export type PreviewWork = {
  id: string;
  title: string;
  description: string;
  request: string;
  status: PreviewStatus;
  services: ServiceName[];
  updatedAt: string;
  progressSummary: string;
  progress: PreviewProgressStep[];
  activity: PreviewActivity[];
  result?: { title: string; summary: string; items: string[] };
  approval?: PreviewApproval;
  clarification?: PreviewClarification;
  candidateSlots?: PreviewCandidateSlot[];
  error?: string;
};

const completed = (label: string): PreviewStatus => ({ label, tone: "success" });
const waiting = (label: string): PreviewStatus => ({ label, tone: "neutral" });

export const mockWorks: readonly PreviewWork[] = [
  {
    id: "monthly-report-email",
    title: "月次レポートを取引先へ送信",
    description: "集計済みの月次レポートを確認し、取引先へメールで送る準備ができています。",
    request: "今月の利用状況をまとめたレポートを、田中さんへ送信してください。",
    status: { label: "承認待ち", tone: "attention" },
    services: ["gmail"],
    updatedAt: "今日 10:18",
    progressSummary: "3/3の準備が完了。送信には承認が必要です。",
    progress: [
      { id: "collect", label: "レポートを集計", detail: "利用状況と添付資料を確認", status: completed("完了") },
      { id: "draft", label: "メール下書きを作成", detail: "件名・宛先・本文を作成", status: completed("完了") },
      { id: "approve", label: "送信を確認", detail: "ユーザーの承認を待機", status: { label: "承認待ち", tone: "attention" } },
    ],
    activity: [
      { time: "10:12", message: "月次レポートの集計を完了しました。", status: completed("完了") },
      { time: "10:16", message: "送信用のメール下書きを作成しました。", service: "gmail", status: completed("完了") },
      { time: "10:18", message: "送信前の確認を待っています。", status: { label: "承認待ち", tone: "attention" } },
    ],
    approval: {
      service: "gmail",
      actionLabel: "メールを送信",
      target: "tanaka@example.com",
      summary: "月次レポートと今月の主な変更点を取引先へ共有します。",
      fields: [
        { label: "宛先", value: "tanaka@example.com" },
        { label: "件名", value: "9月 月次レポートのご共有" },
      ],
      changes: ["月次レポート（PDF）を添付します。", "本文に今月の利用状況と次回確認日を記載します。"],
      effects: ["取引先へメールが送信されます。", "送信済みメールがGmailに記録されます。"],
      warnings: ["この送信操作は取り消せません。"],
    },
  },
  {
    id: "customer-inquiry",
    title: "取引先からの問い合わせに回答",
    description: "回答案を作成するため、どのプランを案内するかを確認しています。",
    request: "A社からの料金に関する問い合わせへ、適切なプランを案内して回答してください。",
    status: { label: "回答待ち", tone: "attention" },
    services: ["slack", "gmail"],
    updatedAt: "今日 09:55",
    progressSummary: "案内するプランの確認を待っています。",
    progress: [
      { id: "read", label: "問い合わせを確認", detail: "依頼内容を要約", status: completed("完了") },
      { id: "clarify", label: "案内内容を確認", detail: "ユーザーの回答を待機", status: { label: "回答待ち", tone: "attention" } },
      { id: "reply", label: "回答案を作成", detail: "確認後にメール下書きを作成", status: waiting("待機中") },
    ],
    activity: [
      { time: "09:48", message: "問い合わせ内容を確認しました。", service: "gmail", status: completed("完了") },
      { time: "09:55", message: "案内するプランについて確認が必要です。", status: { label: "回答待ち", tone: "attention" } },
    ],
    clarification: {
      question: "A社には、標準プランとプロプランのどちらを案内しますか？",
      placeholder: "例: まずは標準プランを案内し、必要ならプロプランの資料も添えてください。",
    },
  },
  {
    id: "meeting-scheduling",
    title: "顧客との打ち合わせを調整",
    description: "30分の候補日時を確認し、参加者へ共有する準備を進めています。",
    request: "田中さんと30分の打ち合わせ候補を3つ用意してください。",
    status: { label: "実行中", tone: "processing", showActivity: true },
    services: ["google-calendar", "gmail", "notion"],
    updatedAt: "今日 09:44",
    progressSummary: "3/5のステップを完了。候補日時を整理中です。",
    progress: [
      { id: "calendar", label: "Calendarを確認", detail: "空き時間を検索", status: completed("完了") },
      { id: "crm", label: "CRM情報を確認", detail: "参加者と条件を確認", status: completed("完了") },
      { id: "gmail", label: "Gmail履歴を確認", detail: "既存のやり取りを確認", status: completed("完了") },
      { id: "notion", label: "Notionに候補を整理", detail: "候補日時を整形", status: { label: "実行中", tone: "processing", showActivity: true } },
      { id: "share", label: "候補を共有", detail: "選択後に共有内容を準備", status: waiting("待機中") },
    ],
    activity: [
      { time: "09:42", message: "空き時間を確認しました。", service: "google-calendar", status: completed("完了") },
      { time: "09:43", message: "過去のやり取りを確認しました。", service: "gmail", status: completed("完了") },
      { time: "09:44", message: "候補日時を整理しています。", service: "notion", status: { label: "実行中", tone: "processing", showActivity: true } },
    ],
    candidateSlots: [
      { id: "slot-1", label: "9/21 10:00–10:30", description: "Google Calendar / Asia/Tokyo" },
      { id: "slot-2", label: "9/21 14:30–15:00", description: "Google Calendar / Asia/Tokyo" },
      { id: "slot-3", label: "9/22 11:00–11:30", description: "Google Calendar / Asia/Tokyo" },
    ],
  },
  {
    id: "interview-summary",
    title: "顧客インタビューを要約",
    description: "インタビュー内容を要約し、共有用のノートを作成しました。",
    request: "今週実施した顧客インタビューを要約して、チームに共有してください。",
    status: { label: "完了", tone: "success" },
    services: ["notion", "slack"],
    updatedAt: "昨日 17:20",
    progressSummary: "すべてのステップが完了しました。",
    progress: [
      { id: "summarize", label: "内容を要約", detail: "重要な発見を抽出", status: completed("完了") },
      { id: "publish", label: "共有ノートを作成", detail: "チーム用のノートを作成", status: completed("完了") },
    ],
    activity: [{ time: "昨日 17:20", message: "共有ノートを作成しました。", service: "notion", status: completed("完了") }],
    result: {
      title: "インタビュー要約を共有しました",
      summary: "顧客が重視する導入支援とレポート機能に関する主な発見を整理しました。",
      items: ["導入初期の支援ニーズ", "レポートの共有頻度", "次回検証したい仮説"],
    },
  },
  {
    id: "sales-report",
    title: "週次営業レポートを作成",
    description: "商談状況と今週の注目点を整理したレポートです。",
    request: "今週の営業活動をまとめたレポートを作成してください。",
    status: { label: "完了", tone: "success" },
    services: ["notion"],
    updatedAt: "昨日 15:40",
    progressSummary: "レポートの作成と共有が完了しました。",
    progress: [{ id: "report", label: "レポートを作成", detail: "営業活動を要約", status: completed("完了") }],
    activity: [{ time: "昨日 15:40", message: "週次レポートを作成しました。", service: "notion", status: completed("完了") }],
    result: {
      title: "週次営業レポート",
      summary: "商談の進捗、来週の優先案件、支援が必要な項目をまとめました。",
      items: ["進行中の重点案件", "来週の予定", "確認が必要なリスク"],
    },
  },
  {
    id: "crm-sync",
    title: "CRMの連絡先情報を同期",
    description: "連絡先情報の同期中に確認できない項目がありました。",
    request: "CRMの連絡先情報を最新の内容に同期してください。",
    status: { label: "失敗", tone: "danger" },
    services: ["gmail"],
    updatedAt: "昨日 11:08",
    progressSummary: "一部の連絡先情報を確認できませんでした。",
    progress: [
      { id: "fetch", label: "連絡先を確認", detail: "対象データを取得", status: completed("完了") },
      { id: "sync", label: "連絡先を同期", detail: "確認できない項目があり停止", status: { label: "失敗", tone: "danger" } },
    ],
    activity: [{ time: "昨日 11:08", message: "必要な連絡先情報を確認できませんでした。", status: { label: "失敗", tone: "danger" } }],
    error: "一部の連絡先情報を確認できなかったため、同期を完了できませんでした。",
  },
];

export function findMockWork(id: string): PreviewWork | undefined {
  return mockWorks.find((work) => work.id === id);
}
