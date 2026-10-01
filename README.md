# Nayther 開発

Naytherは、YolnaとYolna Runsを提供する会社およびプロダクト群です。このリポジトリには、
Yolna側の内部開発コードネームであるTACTのコードベースがあります。

## 会社と製品

- **Yolna** — 人間の仕事を管理し、実行を支援する製品
- **Yolna Runs** — AI実行を観測・説明・監査する独立製品。TACTの機能ではありません。
- **TACT** — このリポジトリにおけるYolna側の内部開発コードネーム

Yolna Runsを含むcheckoutでは、独立製品のコードは次のrootにあります。

- `products/yolna-runs/` — プロダクトアプリケーション
- `packages/runs-core/` — Runsのドメインコード
- `packages/execution-contract/` — Execution Contract

どの統合済みバージョンを使うか、また現在の提供状況はGitHubとLinearで確認してください。
このREADMEから推測しないでください。

## 正本

| 確認したいこと | 正本 |
| --- | --- |
| 実装済みの振る舞い、コード、migration、テスト | GitHubとリポジトリ |
| Issue、優先順位、status、dependency | Linear |
| 設計判断、方針、学び | Notion |
| AI共通の長期開発ルール | [AGENTS.md](AGENTS.md) |
| 現在地の確認手順 | [CURRENT_STATE.md](docs/ai/CURRENT_STATE.md) |
| Claude Code固有の補足 | [CLAUDE.md](CLAUDE.md) |

ローカルの進捗メモをGitHub、Linear、Notionの代わりに使わないでください。矛盾があれば、
推測せず報告してください。

## 開発を始める

### 必要環境

- Git
- Node.js and npm

### ローカル起動

```bash
git clone https://github.com/sora-ishibashi/TACT.git
cd TACT
npm ci
npm run dev
```

開発サーバー起動後に`http://localhost:3000`を開きます。外部サービスや認証情報が必要な
作業では、そのIssue固有の案内に従ってください。ローカル起動のためにsecretを作成、複製、
露出してはいけません。

### 確認コマンド

変更に応じて、引き渡し前に必要な確認を実行します。

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```

文書だけの変更では、無関係な全buildではなく、リンク、path、diffを確認します。

## AI開発ルール

コードを変更する前に、次を読んでください。

- [AGENTS.md](AGENTS.md) — 全AI共通の長期ルール
- [CURRENT_STATE.md](docs/ai/CURRENT_STATE.md) — 現在の事実を見つける手順
- [CONTEXT_BUILDER.md](docs/ai/CONTEXT_BUILDER.md) — 役割ごとの最小Context
- [CLAUDE.md](CLAUDE.md) — Claude Code固有の補足

Issue単位のbranchとworktreeを使ってください。`main`を直接変更せず、他AIの未commit作業を
混ぜず、AI向け文書をLinear Issueやコードレビューの代わりにしないでください。

## Human Approval Gate

次の変更にはHuman Ownerの承認が必要です。

- Productionへの公開・deployment
- cloud resourceの作成
- 破壊的なDB変更、またはStaging／Productionへのmigration適用
- permissionの拡大、security boundaryの変更
- secretの変更・rotation
- 外部サービスへのデータ送信
- customer dataの利用

完全な作業ルールと確認要件は[AGENTS.md](AGENTS.md)にあります。
