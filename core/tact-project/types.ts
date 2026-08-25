// =========================
// Project (Phase 30/31)
// =========================
//
// Phase30で新設したprojectsテーブル(User直下、Organizationなし)に
// 対応する最小のドメイン型。File/Project Context/Conversationとの
// 関係は今回実装しない(絶対条件、Phase32以降のスコープ)。

export interface Project {

  id: string;

  userId: string;

  name: string;

  createdAt: string;

  updatedAt: string;

}
