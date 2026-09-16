import { NextRequest } from "next/server";

import {
  handleListConversations,
  handleConversationTurn,
} from "../../tact-conversations/route";

// =========================
// GET / POST /api/tact/research/conversations
// (TACT Conversation Origin Boundary)
// =========================
//
// components/research/ResearchWorkspace.tsx専用のResearch-origin surface。
// app/api/tact/tact-conversations/route.tsが公開する
// handleListConversations()/handleConversationTurn()(validation・
// attachment解決・Conversation解決/作成・Orchestrator実行という共通ロジック
// 一式)をそのまま再利用し、origin引数だけを"research"に固定する
// (Section12「Separate thin Research/Core server endpoints that call
// common store functions」の採用)。
//
// このRoute自体はrequest body/query stringからoriginを一切読み取らない
// (下のGET/POSTがリテラル"research"を渡すのみ)——どちらのURLが呼ばれた
// かというサーバー側routing tableの事実だけがorigin決定の根拠であり、
// クライアントが「research」を名乗るための入力経路は存在しない。

export async function GET(request: NextRequest) {
  return handleListConversations(request, "research");
}

export async function POST(request: NextRequest) {
  return handleConversationTurn(request, "research");
}
