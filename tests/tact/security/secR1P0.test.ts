// =========================
// TACT — SEC-R1-P0 Remediation Regression
// =========================
//
// 対象: SEC-R1 Enterprise Security & Trust Full Auditで確認された
// P0 Critical 2件の修正。
//
//   P0-1: Unauthenticated cross-tenant conversation hijack
//     (app/api/tact/conversation/stream/route.tsがsibling
//     app/api/tact/conversation/route.tsの所有者チェックを
//     コピーし忘れていた)
//   P0-2: Cross-tenant ImprovementProposal read via code-tasks
//     (app/api/tact/code-tasks/route.tsがgetImprovementProposalById()
//     へuserIdを渡し忘れ、owner filterが丸ごとskipされていた)
//
// このrepositoryのapp/api/**route handlerはDI parameterを持たない
// ため、tests/tact/security/preLiveSecP0.test.tsと同じ2種類の検証を
// 組み合わせる:
//   1. Pure logicとして切り出せる部分(core/conversation/store.tsの
//      isConversationAccessibleBy())は、実DB接続なしの通常のunit
//      testで直接検証する——これがP0-1の実際のenforcement logicその
//      ものであるため、「owner can access」「different user cannot
//      access」「unauthenticated caller cannot access owned」という
//      要求を、mockingではなく本物のsecurity boundaryとして検証できる。
//   2. Route handler自体の配線(getConversation()/
//      getImprovementProposalById()へ実際にuserIdが渡っているか、
//      アクセス拒否がmutation/CodeTask作成より前に来るか)は、
//      source-levelの構造的テストとする。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isConversationAccessibleBy } from "../../../core/conversation/store";
import { check, summarize, type CheckResult } from "../lib/check";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf-8");
}

// 行番号ベースで「AがBより前に現れる」ことを確認する(既存
// preLiveSecP0.test.tsの「認証チェックがrunWorkflow(より前に来る」
// 検証と同じ手法)。
function indexOfOrThrow(source: string, needle: string, label: string): number {
  const index = source.indexOf(needle);
  if (index === -1) {
    throw new Error(`[secR1P0.test] expected to find ${label} in source, but it was not present.`);
  }
  return index;
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // P0-1: isConversationAccessibleBy() — 純粋関数としてのsecurity
  // boundary検証(実DBなし)
  // =========================

  results.push(
    check(
      "[P0-1] owner can access: ownerUserId === callerUserId -> true",
      isConversationAccessibleBy("user-1", "user-1") === true
    )
  );

  results.push(
    check(
      "[P0-1] different authenticated user cannot access: ownerUserId !== callerUserId(共に非null) -> false",
      isConversationAccessibleBy("user-1", "user-2") === false
    )
  );

  results.push(
    check(
      "[P0-1] unauthenticated caller cannot continue an owned conversation: ownerUserId=非null, callerUserId=null -> false",
      isConversationAccessibleBy("user-1", null) === false
    )
  );

  results.push(
    check(
      "[P0-1] legacy/anonymous conversation(ownerUserId=null)は、callerUserIdの値に関わらず後方互換でアクセス可能 -> true(既存ユーザーを壊さない、今回のP0 scope外の既存挙動)",
      isConversationAccessibleBy(null, "user-1") === true &&
        isConversationAccessibleBy(null, null) === true
    )
  );

  // =========================
  // P0-1: source-level — core/conversation/store.tsのgetConversation()
  // シグネチャがcallerUserIdを必須(optionalではない)にしている
  // =========================
  {
    const storeSource = readRepoFile("core/conversation/store.ts");

    results.push(
      check(
        "[P0-1] getConversation()のシグネチャがcallerUserId(必須、optionalではない)を持つ",
        /export async function getConversation\(\s*id: string,\s*callerUserId: string \| null\s*\)/.test(storeSource)
      )
    );

    results.push(
      check(
        "[P0-1] getConversation()内部がisConversationAccessibleBy()で所有者判定してからmessages/workflowRunsをfetchしている",
        (() => {
          const accessCheckIndex = indexOfOrThrow(storeSource, "isConversationAccessibleBy(row.user_id, callerUserId)", "ownership check");
          const messagesFetchIndex = indexOfOrThrow(storeSource, '.from("conversation_messages")', "messages fetch (ownership check must precede this)");
          return accessCheckIndex < messagesFetchIndex;
        })()
      )
    );
  }

  // =========================
  // P0-1: source-level — 両routeがgetConversation()へ
  // authenticatedUserIdを実際に渡しているか
  // =========================
  {
    const nonStreamSource = readRepoFile("app/api/tact/conversation/route.ts");

    results.push(
      check(
        "[P0-1] POST /api/tact/conversationがgetConversation(body.conversationId, authenticatedUserId)を呼んでいる",
        /getConversation\(\s*body\.conversationId,\s*authenticatedUserId\s*\)/.test(nonStreamSource)
      )
    );

    results.push(
      check(
        "[P0-1] POST側: body.conversationIdが指定されたのに取得できなかった場合、新規作成へフォールスルーせず404を返す(conversation not foundを返す分岐が、新規Conversation作成(createConversation)より前に来る)",
        (() => {
          const guardIndex = indexOfOrThrow(
            nonStreamSource,
            "if (body.conversationId && !conversation)",
            "explicit-conversationId-not-found guard"
          );
          const createIndex = indexOfOrThrow(nonStreamSource, "createConversation(", "createConversation() call");
          return guardIndex < createIndex;
        })()
      )
    );

    results.push(
      check(
        "[P0-1] GET /api/tact/conversationが認証情報を取得した後にgetConversation(conversationId, authenticatedUserId)を呼んでいる(認証チェックが取得より前)",
        (() => {
          const authIndex = indexOfOrThrow(nonStreamSource, "await getCurrentUserContext(request)", "auth resolution (GET)");
          const fetchIndex = indexOfOrThrow(
            nonStreamSource,
            "getConversation(conversationId, authenticatedUserId)",
            "owner-scoped getConversation call (GET)"
          );
          return authIndex < fetchIndex;
        })()
      )
    );
  }

  {
    const streamSource = readRepoFile("app/api/tact/conversation/stream/route.ts");

    results.push(
      check(
        "[P0-1] POST /api/tact/conversation/streamがgetConversation(body.conversationId, authenticatedUserId)を呼んでいる(sibling routeと同じ2引数)",
        /getConversation\(\s*body\.conversationId,\s*authenticatedUserId\s*\)/.test(streamSource)
      )
    );

    results.push(
      check(
        "[P0-1] stream側: 認証解決(getAuthenticatedUser)が、getConversation()呼び出しより前に来る(未認証callerがcallerUserId=nullとして正しく渡る)",
        (() => {
          const authIndex = indexOfOrThrow(streamSource, "await getAuthenticatedUser(request)", "auth resolution (stream)");
          const fetchIndex = indexOfOrThrow(streamSource, "getConversation(", "getConversation call (stream)");
          return authIndex < fetchIndex;
        })()
      )
    );

    results.push(
      check(
        "[P0-1] stream側: body.conversationIdが指定されたのに取得できなかった場合、error eventを送って即returnし、新規Conversation作成(createConversation)・runConversationTurn・saveConversationのいずれへも進まない(mutation 0)",
        (() => {
          const guardIndex = indexOfOrThrow(
            streamSource,
            "if (body.conversationId && !conversation)",
            "explicit-conversationId-not-found guard (stream)"
          );
          // 実呼び出し(await付き)だけを対象にする——ファイル冒頭の
          // 説明コメントに"runConversationTurn()"という空括弧の言及が
          // 存在し、それを実呼び出しと誤認しないようにするため。
          const createIndex = indexOfOrThrow(streamSource, "createConversation(", "createConversation() call (stream)");
          const turnIndex = indexOfOrThrow(streamSource, "await runConversationTurn(", "runConversationTurn() call (stream)");
          const saveIndex = indexOfOrThrow(streamSource, "await saveConversation(", "saveConversation() call (stream)");
          return guardIndex < createIndex && guardIndex < turnIndex && guardIndex < saveIndex;
        })()
      )
    );

    results.push(
      check(
        "[P0-1] stream側のfail-closed guardが、見つからなかった場合にcontroller.close()相当のreturnで終了する(sendの後にreturn文がある、後続処理へ流れ落ちない)",
        /if \(body\.conversationId && !conversation\) \{\s*\n\s*send\(\{\s*\n\s*type: "error",\s*\n\s*error: "conversation not found",\s*\n\s*\}\);\s*\n\s*return;/.test(streamSource)
      )
    );
  }

  // =========================
  // P0-1: 再発防止の検証——legacy getConversation()の全call siteが
  // 2引数を渡している(1引数呼び出しが残っていないか、実source全体を
  // 対象にgrepと同じ精神でチェック)
  // =========================
  {

    const callSites: { file: string; source: string }[] = [
      { file: "app/api/tact/conversation/route.ts", source: readRepoFile("app/api/tact/conversation/route.ts") },
      { file: "app/api/tact/conversation/stream/route.ts", source: readRepoFile("app/api/tact/conversation/stream/route.ts") },
    ];

    for (const { file, source } of callSites) {

      // "getConversation(" の直後に、閉じ括弧が来る前に必ずカンマ
      // (2つ目の引数の存在)がある、という緩い構文チェック。
      // core/conversation/store.tsからのimportに限定するため、
      // "from \"@/core/conversation/store\"" の import自体を先に確認する。
      results.push(
        check(
          `[P0-1 再発防止] ${file} がcore/conversation/storeからgetConversationをimportしている`,
          /import\s*\{[^}]*getConversation[^}]*\}\s*from\s*"@\/core\/conversation\/store"/.test(source)
        )
      );

      // コメント中の "getConversation()"(空括弧での言及)を実呼び出しと
      // 誤認しないよう、captured argsが空/空白のみのmatchは除外する。
      const calls = [...source.matchAll(/getConversation\(([^)]*)\)/g)]
        .map((m) => m[1])
        .filter((args) => args.trim().length > 0);

      results.push(
        check(
          `[P0-1 再発防止] ${file} 内のgetConversation(...)実呼び出しは全て2引数(callerUserId相当を含む、カンマを含む)`,
          calls.length > 0 && calls.every((args) => args.includes(","))
        )
      );

    }

  }

  // =========================
  // P0-2: source-level — code-tasks/route.tsがuserIdを渡しているか、
  // 拒否がCodeTask作成より前に来るか
  // =========================
  {
    const codeTasksSource = readRepoFile("app/api/tact/code-tasks/route.ts");

    results.push(
      check(
        "[P0-2] POST /api/tact/code-tasksがgetImprovementProposalById(proposalId, userId)を2引数で呼んでいる(userId省略なし)",
        /getImprovementProposalById\(\s*proposalId,\s*userId\s*\)/.test(codeTasksSource)
      )
    );

    results.push(
      check(
        "[P0-2] proposal取得(owner-scoped)が、CodeTask構築(saveCodeTask)より前に来る(foreign proposalからCodeTaskが作成されない)",
        (() => {
          const proposalIndex = indexOfOrThrow(
            codeTasksSource,
            "getImprovementProposalById(",
            "getImprovementProposalById call"
          );
          const saveIndex = indexOfOrThrow(codeTasksSource, "saveCodeTask(", "saveCodeTask call");
          return proposalIndex < saveIndex;
        })()
      )
    );

    results.push(
      check(
        "[P0-2] proposalが見つからない(=他user所有で非開示、または実在しない)場合は404を返し、以降のCodeTask構築処理へ進まない(!proposalガードがbuildSafeClaudeCodeInstruction呼び出しより前)",
        (() => {
          const guardIndex = indexOfOrThrow(codeTasksSource, "if (!proposal)", "!proposal guard");
          const instructionIndex = indexOfOrThrow(
            codeTasksSource,
            "buildSafeClaudeCodeInstruction(",
            "buildSafeClaudeCodeInstruction call"
          );
          return guardIndex < instructionIndex;
        })()
      )
    );
  }

  // =========================
  // P0-2: sibling routeとの整合性確認(既存improvement-proposals
  // routeは元々owner-scopedだった——今回の修正で崩していないことの
  // regression確認)
  // =========================
  {
    const siblingSource = readRepoFile("app/api/tact/improvement-proposals/route.ts");

    results.push(
      check(
        "[P0-2 整合性] sibling app/api/tact/improvement-proposals/route.tsは引き続きgetImprovementProposalById()へauthenticatedUserIdを渡している(今回の修正で崩れていない)",
        /getImprovementProposalById\(\s*[\s\S]{0,80}authenticatedUserId/.test(siblingSource)
      )
    );
  }

  // =========================
  // P0-2: 再発防止 — getImprovementProposalById()の全call siteが
  // 2引数呼び出しである(core/brain/memory.ts自体は今回変更しない、
  // 呼び出し側だけを確認する)
  // =========================
  {

    const callSites: { file: string; source: string }[] = [
      { file: "app/api/tact/code-tasks/route.ts", source: readRepoFile("app/api/tact/code-tasks/route.ts") },
      { file: "app/api/tact/improvement-proposals/route.ts", source: readRepoFile("app/api/tact/improvement-proposals/route.ts") },
    ];

    for (const { file, source } of callSites) {

      // コメント中の "getImprovementProposalById()"(空括弧での言及)を
      // 実呼び出しと誤認しないよう、captured argsが空/空白のみのmatch
      // は除外する。
      const calls = [...source.matchAll(/getImprovementProposalById\(([^)]*)\)/g)]
        .map((m) => m[1])
        .filter((args) => args.trim().length > 0);

      results.push(
        check(
          `[P0-2 再発防止] ${file} 内のgetImprovementProposalById(...)実呼び出しは全てuserId相当の2引数目を含む(カンマを含む)`,
          calls.length > 0 && calls.every((args) => args.includes(","))
        )
      );

    }

  }

  return summarize("security/secR1P0", results);

}
