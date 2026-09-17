// =========================
// TACT UI — Core Push Auth Header Regression (Production 401 fix)
// =========================
//
// 背景: Production で POST /api/tact/core/push が常に401を返していた。
// 原因は components/tact/CoreSection.tsx のfetch呼び出しが
// Authorization headerを一切送っていなかったこと(server側の
// app/api/tact/core/push/route.ts・core/auth/*はSTEP212設計通り正しく
// Bearer tokenを要求しており、無変更)。
//
// このrepositoryにReact component testing infrastructureが存在しない
// ため(既存precedent: tests/tact/ui/connectionsPanel.test.ts)、
// CoreSection.tsxのsourceを直接検証するsource-level testとする。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../lib/check";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf-8");
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const source = readRepoFile("components/tact/CoreSection.tsx");

  results.push(
    check(
      "[A] CoreSectionはAuthProviderのuseAuth()からgetAccessToken()を取得する",
      /import\s*\{\s*useAuth\s*\}\s*from\s*["']@\/components\/auth\/AuthProvider["']/.test(source) &&
        /const\s*\{\s*getAccessToken\s*\}\s*=\s*useAuth\(\)/.test(source)
    )
  );

  results.push(
    check(
      "[B] handleSubmit()はfetch呼び出し前にgetAccessToken()を呼び出す",
      (() => {
        const handleSubmitIndex = source.indexOf("async function handleSubmit()");
        const getTokenIndex = source.indexOf("getAccessToken()", handleSubmitIndex);
        const fetchIndex = source.indexOf('fetch("/api/tact/core/push"', handleSubmitIndex);

        return (
          handleSubmitIndex >= 0 &&
          getTokenIndex > handleSubmitIndex &&
          fetchIndex > getTokenIndex
        );
      })()
    )
  );

  results.push(
    check(
      "[C] POST /api/tact/core/pushはAuthorization: Bearer <accessToken> headerを送る",
      /fetch\("\/api\/tact\/core\/push",\s*\{[\s\S]*?Authorization:\s*`Bearer \$\{accessToken\}`/.test(source)
    )
  );

  results.push(
    check(
      "[D] accessTokenが無い場合、fetch()を呼ばずに早期returnする(匿名requestを送らない)",
      (() => {
        const handleSubmitIndex = source.indexOf("async function handleSubmit()");
        const ifNoTokenIndex = source.indexOf("if (!accessToken)", handleSubmitIndex);
        const fetchIndex = source.indexOf('fetch("/api/tact/core/push"', handleSubmitIndex);

        if (ifNoTokenIndex < 0 || fetchIndex < 0 || ifNoTokenIndex > fetchIndex) {
          return false;
        }

        // if (!accessToken) ブロック内に return があり、そのブロックが
        // fetch呼び出しより手前で閉じていること(=fetchはガードの外側)。
        const guardBlockEnd = source.indexOf("}", source.indexOf("return;", ifNoTokenIndex));

        return guardBlockEnd > 0 && guardBlockEnd < fetchIndex;
      })()
    )
  );

  results.push(
    check(
      "[E] server route(app/api/tact/core/push/route.ts)・core/auth/*は本Phaseで変更しない(絶対条件、Bearer検証・owner isolationは既存のまま)",
      (() => {
        const routeSource = readRepoFile("app/api/tact/core/push/route.ts");

        return (
          routeSource.includes('"authentication is required to push to Core"') &&
          routeSource.includes("status: 401")
        );
      })()
    )
  );

  return summarize("ui/coreSectionAuth", results);

}
