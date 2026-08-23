// =========================
// TACT Core — Project (STEP175)
// =========================
//
// Projectは「この仕事・活動についてTACTが継続的に文脈を持つ単位」
// として定義する(STEP175絶対条件)。既存のConversation
// (core/conversation/types.ts)は「1つの会話セッション」を表すのに対し、
// Projectはより上位の、複数Conversationを束ねうる単位という位置づけ。
//
// STEP175時点では型定義のみ。既存のconversationsテーブル
// (supabase/migrations/20260811120000_create_conversation_tables.sql)
// にはproject_idに相当するカラムが存在しない(STEP174監査で確認済み)。
// Conversation ⇄ Project の関連付けは、DB migrationを伴う将来STEPの
// 対象とする。

export interface Project {

  id: string;

  // 個人利用(Organizationに属さない)の場合はundefined。
  organizationId?: string;

  name: string;

  description?: string;

  createdAt: string;

  updatedAt: string;

}
