# SOR-130 — Generic Observation Gateway Reality Test

**これはproduct featureではない。** `core/tact-execution/`の外部契約(`observeCanonicalExecution()`と各providerのnormalize/observe wrapper)だけをimportし、逆方向のimportは一切無い。削除しても他のどのcode pathも壊れない。

## 目的

SOR-129で抽出したGeneric Observation Gatewayが、性質の異なる複数のSaaS providerを実際に通したときに、SaaS監査ログAPIを必須にせずCanonical Execution契約が成立するかを検証する(Reality Test)。5社対応を完成させる作業ではない。

## 対象カテゴリと実際のスクリプト

| カテゴリ | Provider | スクリプト | 実行に必要なもの |
|---|---|---|---|
| Document/Knowledge | Notion | `notionRealityTest.ts` | `NOTION_TEST_HOST_TOKEN`, `NOTION_TEST_HOST_SANDBOX_PARENT_PAGE_ID` |
| Development | GitHub | `githubRealityTest.ts` | `GITHUB_TOKEN`。`SOR130_GITHUB_TEST_REPO`("owner/repo")が設定されていればその人間が用意した専用sandbox repoをそのまま使う(作成/削除しない)。未設定ならdisposable private repoを新規作成し、実行後に削除する(fine-grained PATにAccount permissions > Administration: Read and writeが必要——無いと403になる) |
| Messaging | Slack | `slackRealityTest.ts` | `SLACK_BOT_TOKEN`。AUTH_TESTのみ既定で実行。実際のchat.postMessage(SEND)は`SOR130_SLACK_TEST_CHANNEL`が設定されている場合のみ実行する(未設定なら「未検証」として明示してskipする) |
| Google Workspace | — | (無し) | Composio認証キー未設定のため実施不可。「未検証」として報告する対象 |
| Business Record/CRM | — | (無し) | credential/コード共に存在しないため実施不可。「未検証」として報告する対象 |

## 永続化先

**実Staging/Productionへは一切接続しない。** ローカルDocker上のlocal Supabase(`supabase start`、このrepoのmigrationをそのまま適用したもの)へ永続化する。使い捨て・再現可能・いつでも`supabase stop`で破棄できる。

各スクリプトを実行する前に、以下を1回実行しておくこと(値は標準出力にのみ表示され、このrepoには一切書き込まれない):

```
supabase status -o env
```

その出力から`API_URL`と`SERVICE_ROLE_KEY`を、実行時に環境変数として渡す:

```
SOR130_LOCAL_SUPABASE_URL=http://127.0.0.1:54321 \
SOR130_LOCAL_SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY> \
npx tsx experiments/sor130-reality-test/notionRealityTest.ts
```

`lib/localSupabaseEnv.ts`は`SOR130_LOCAL_SUPABASE_URL`が`127.0.0.1`/`localhost`を含まない場合、fail-closedで即座に例外を投げる(Staging/Productionへの誤接続を防ぐ絶対的なガード)。

## 設計原則(SOR-130絶対条件)

- provider固有schemaをCoreへ持ち込まない(このディレクトリの外へは`core/tact-execution`の公開契約だけを通す)。
- raw payload本文(メッセージ本文・issue本文・ページ本文)を保存しない。`sourceMetadata`には識別子(repository名、channel ID等)のみを含める。
- Work IDはlegitimateなexplicit carrierが無い限りnull(fake claimを作らない)。
- credential/token/message本文をログ・標準出力へ出さない。
- 各実行後、実際に永続化された`tact_canonical_executions`行を読み戻し、privacy sweep(生payload文字列が含まれていないか)を行う。

## 後片付け

- Notion: sandbox page配下に作成したpageをarchive(削除)する。
- GitHub: 作成したdisposable repoを削除する(スクリプト末尾で実施、または手動で削除する手順をログに出す)。
- local Supabase: `supabase stop --workdir <this repo>` でいつでも破棄可能(実データは残らない)。
