// =========================
// orchestrateClarification (Phase 46)
// =========================
//
// Clarification UX Option B(Phase34で設計、Phase45でPhase46の実装対象
// として採用)の中核ロジック: 「元のユーザー入力」と「Clarification
// への回答」を、既存の/api/tact/orchestrate(input: stringのみを
// 受け取る既存契約、絶対条件Rule6: schema変更禁止)へそのまま渡せる
// 単一の文字列へ組み立てる。
//
// 絶対条件Rule5: Clarification判定ロジック自体(ambiguityDetector.ts)
// は変更しない。ここでは既に返されたquestionと、ユーザーが入力した
// answerを、再度runOrchestration()が解釈できる1つのinputへ結合する
// だけであり、新しい判定・分類ロジックは一切持たない。
//
// Phase55: 結合ロジックの正本はConversation Layer側
// (core/conversation/clarification.ts、Phase54 Decision D:
// 「結合処理はConversation Layerの責務」)へ移した。この関数は
// 後方互換のための再エクスポートのみ(ResearchPanel.tsx等の
// 既存呼び出し元・挙動を一切変更しないため)。改行区切りを採用する
// 理由等の設計コメントはcore/conversation/clarification.ts側では
// なく、移設前のPhase46コメントとして以下に残す:
//
// 改行区切りを採用する理由: ambiguityDetector.tsのBARE_VERB_QUESTIONS
// は「trimmed文字列全体が辞書の値と完全一致するか」だけを見るため、
// 元入力の後ろに何かを連結した時点で二度と完全一致しなくなる。また
// SUBJECT_PATTERN(`^(.*?)(について|を)`)は`.`が改行を跨がないため、
// 1行目に「について/を」が無ければ2行目以降とは無関係にambiguous:false
// となる。この性質を意図的に利用し、改行区切りにすることで再度
// Clarificationが誤って連鎖しにくい形にしている(新しいループ防止
// 機構ではなく、既存ロジックの自然な帰結)。

export { buildClarificationResendInput } from "@/core/conversation/clarification";
