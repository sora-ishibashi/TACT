# tact UI Design Rules v0.9

## 1. Brand

| 項目ルール | |
| ------- | --------------------------------- |
| 正式ブランド名 | `tact` |
| 文字ロゴ | `tact`（小文字） |
| ロゴシンボル | `#00188E` |
| ロゴ文字色 | `#112278` |
| 最小使用サイズ | 32px |
| 周囲の余白 | ロゴ高さの25%以上 |
| 使用場所 | Header、Navigation上部、ログイン、空状態、共有画面 |
| 白背景 | 紺シンボル＋紺文字 |
| 明るい有色背景 | 紺シンボル＋紺文字。コントラスト不足時は白い領域を敷く |
| 濃い背景 | 白抜きロゴ |
| UI内の表記 | 正式名称は常に `tact` |

ロゴの色、比率、シンボルと文字の配置関係は変更しない。

## 2. Color

| 役割 | 色 | 使用箇所 |
| ------------------- | --------- | ----------------------------------------- |
| Main / Logo Navy | `#00188E` | ロゴシンボル、ブランド表現 |
| Main Text Navy | `#112278` | 見出し、本文、Navigation、通常アイコン |
| Mint | `#18B5A6` | Primary Button、送信、AI / Agent、成功 |
| White | `#FFFFFF` | 背景、Card、Input、Panel、Mint Button上の文字 |
| Sub text | `#626161` | 説明文、補足、メタ情報 |
| Border / Divider | `#D9D9D9` | Card、Panel、Input、区切り線 |
| Hover / Selected背景 | `#E6F2F2` | Hover、Selected、Active、Navigation、Tab、Menu |
| Selected文字 | `#172E95` | 選択中の文字・アイコン |
| Disabled文字・アイコン | `#8A8A8A` | 無効状態 |
| Disabled背景 | `#F2F2F2` | 無効Button、無効Input |
| Warning | `#C53F4B` | 注意、確認待ち |
| Error / Destructive | `#C53F4B` | エラー、失敗、削除など |

色の意味は以下に統一する。

- 紺：ブランド、構造、文字
- Mint：操作、AI、成功
- 薄いMint：Hover、Selected、Active
- Gray：Disabled
- 赤：Warning、Error、Destructive

定義されていない独自色は追加しない。

## 3. Typography

フォントはすべて `Inter`。基本ウェイトは `Medium / 500`。

| Token | サイズ | 太さ | 行間 | 用途 |
| ----------- | ---- | ------ | ---- | ------------- |
| Heading 1 | 32px | Medium | 40px | ページタイトル |
| Heading 2 | 24px | Medium | 32px | セクションタイトル |
| Heading 3 | 13px | Medium | 18px | 小見出し、セクションラベル |
| Navigation Item | 12px | Medium | 16px | Navigation内のProject名、Chat History、主要Navigation項目 |
| Body | 14px | Medium | 20px | 本文、チャット本文、Input |
| Body Strong | 14px | Medium | 20px | 強調、Button |
| Small | 13px | Medium | 18px | 補足本文 |
| Caption S | 10px | Medium | 14px | 極小メタ情報 |
| Caption M | 12px | Medium | 16px | 時刻、補助ラベル |
| Caption L | 13px | Medium | 18px | 強調した補足情報、Empty State等 |

TACTロゴ以外に、見出し専用の別フォントは使用しない。

## 4. Shape / Spacing

- Spacing単位：4px
- 基本余白：4 / 8 / 12 / 16 / 24 / 32px
- Panel：16px radius
- Card：12px radius
- Input：12px radius
- Button：10px radius
- Badge：999px radius
- Border：1px solid `#D9D9D9`
- Shadow：原則使用しない
- Modal / Dropdown Shadow：`0 4px 16px rgba(17,34,120,0.12)`
- Panel間の余白：16px
- コンテンツ最大幅：1440px

### Header

- Headerは必須要素ではない
- 使用する場合は高さ56px固定
- 独立Headerを持たないWorkspaceには設置しない
- Researchは独立Headerを持たない
- Desktop CompactではWorkspace左上の`☰`からNavigation Drawerを表示する

## 5. Icons

- UI上の意味を持つアイコンはLucideを統一採用
- 独自アイコンはTACTの正式シンボルなどブランド表現に限定
- 絵文字はUIアイコンとして使用しない
- 通常サイズ：24px
- 補助サイズ：16px
- 線幅：2px
- アイコンと文字の距離：8px
- Productごとの独自Icon Libraryは作らない
- Research / Design / Code / Meeting / Botはアイコン＋ラベルで識別する

## 6. Components

基本構造は以下とする。

`Navigation | Conversation | Artifact`

| コンポーネント | ルール |
| -------------------- | --------------------------------- |
| Primary Button | `#18B5A6`背景、`#FFFFFF`文字 |
| Primary Button Hover | 白背景、Mint文字、1px Mint Border |
| Secondary Button | 白背景、`#112278`文字、1px Border |
| Ghost Button | Hoverで`#E6F2F2`背景 |
| Disabled Button | `#F2F2F2`背景、`#8A8A8A`文字 |
| Input | 白背景、12px radius、1px Border |
| Disabled Input | `#F2F2F2`背景、`#8A8A8A`文字 |
| Search | Inputと同じ。左に検索アイコン |
| Dropdown | 白背景、12px radius。選択行は`#E6F2F2` |
| Modal | 白背景、16px radius、薄いShadow |
| Card | 白背景、12px radius、1px Border |
| Tab | Selected時に`#E6F2F2`背景またはMint下線 |
| Badge | 状態・分類の表示に限定 |
| Tooltip | `#112278`背景、白文字 |
| Toast | 右下。アイコン＋状態色＋短い説明 |
| Navigation | Selected時は`#E6F2F2`背景、`#172E95`文字 |
| Chat message | 自分はMint背景＋白文字、tactは薄いMint背景＋紺文字 |
| Artifact | 右側のArtifact Panel内に表示 |
| Agent status | Mintのインジケーター＋状態テキスト |

### Button size

- Standard Button：height 36px、horizontal padding 12px、Body Strong、10px radius
- Compact Button：height 32px、horizontal padding 12px、13px / 18px / 500、10px radius
- Icon Button：standard 36px × 36px、compact 32px × 32px、icon sizeはIcon Rulesに従う、10px radius

### Input size

- Standard Input：min-height 40px、Body、horizontal padding 12px、12px radius
- Compact Input：height 36px、13px / 18px / 500、horizontal padding 12px、12px radius
- Chat Composer：固定heightにはせず、min-height 40px、Bodyを基準とする

### Scrollbar

- Scrollbarは必要なスクロール領域に存在してよい
- 通常時は視覚的に非表示または極めて目立たない状態とする
- 対象スクロール領域にhoverした場合、Scrollbar thumbを表示する
- スクロール操作中もScrollbar thumbを視認可能にする
- Trackは透明、Thumbは`#D9D9D9`
- Scrollbar幅は5〜6px程度、Thumbは角丸
- Shadow、未定義の独自色は使用しない
- Scrollbar表示/非表示によるLayout Shiftを発生させない
- スクロール機能を無効化せず、Mouse wheel / Trackpad / Keyboard等による既存操作を維持する
- Scrollbarは情報構造ではなく補助的な操作UIとして、コンテンツより目立たせない

### Chat message

| 送信者 | 背景 | 文字 |
| ---- | --------- | --------- |
| 自分 | `#18B5A6` | `#FFFFFF` |
| tact | `#E6F2F2` | `#112278` |

## 7. States

| 状態 | 表現 |
| ----------------- | ---------------------------- |
| Normal | 白背景、紺文字 |
| Hover | `#E6F2F2`背景 |
| Selected / Active | `#E6F2F2`背景、`#172E95`文字・アイコン |
| Focus | Mintの2px Focus ring |
| Disabled | `#F2F2F2`背景、`#8A8A8A`文字・アイコン |
| Loading | SkeletonまたはSpinner |
| Processing | Mintの点またはパルス＋状態テキスト |
| Success | Mintのチェックアイコン＋完了テキスト |
| Warning | `#C53F4B`の警告アイコン＋「確認が必要」 |
| Error | `#C53F4B`のエラーアイコン＋原因と次の操作 |

Agentの状態は色だけでなく、必ずテキストでも表示する。

`待機 → 実行中 → 確認中 → 完了 / エラー`

## 8. Product Rules

Research / Design / Code / Meeting / Botは、同じtactデザインシステム内に置く。

- Layout、Typography、Button、Input、Card、状態表現は共通
- プロダクトごとに基調色、角丸、Button体系を変更しない
- 差別化はアイコン、ラベル、空状態、小さなアクセントに限定する

## 9. Responsive / Layout

### Desktop Wide

- Navigationを常設
- `Navigation | Conversation | Artifact`を基本構造とする
- HeaderはWorkspaceの要件に応じて設置する
- Researchでは独立Headerを設置しない

### Desktop Compact

- NavigationをDrawer化
- Workspace左上の`☰`から表示
- Drawer表示中はOverlayを表示
- HeaderがないWorkspaceでも、`☰`はWorkspace左上に配置する

### Workspace比率

- 対象はNavigationを除いたMain Workspace
- Conversation：40%
- Artifact：60%
- 40:60は基準値であり、固定絶対値ではない
- ResearchではArtifactをより広くしてよい

### Tablet / Mobile

PWA対応時に別途定義する。具体的なpx値は実機確認後に決定する。

## 10. Motion

- Drawer、Dropdown、Modalのtransition：150〜200ms
- easing：自然なEase-out
- 派手なアニメーション、常時動く装飾は使用しない
- Processing状態のPulseのみ例外として使用する

## 11. Z-index

| レイヤー | z-index |
| ------------------ | ------- |
| 通常コンテンツ | 0 |
| Overlay | 40 |
| Drawer | 50 |
| Dropdown / Tooltip | 60 |
| Modal | 80 |
| Toast | 90 |

Drawerは必ずOverlayより前面に表示する。

## 12. Artifact Rules

Artifact Panelは共通UIルールに従う。ただし、成果物自体は種類に応じた専用Rendererを使用してよい。

対象例：

- Research Report
- Table
- Chart
- Diagram
- Thinking Tool
- Source
- Design Slide
- Code Diff
- Code Preview

Artifactをすべて同じCard UIにするのではなく、情報表現に適したレイアウト、密度、操作方法を許可する。

## 13. Prohibited / Don't

- UIアイコンとして絵文字を使用しない
- 定義されていない独自色を追加しない
- 装飾目的のShadowを追加しない
- 不要なCardで情報を囲まない
- 不要なHeader、見出し、説明文を追加しない
- Productごとに独自の色・角丸・Button体系を作らない
- tactロゴの色・比率・配置関係を変更しない
- Artifactを一律Card UIとして表現しない
- 情報量に対して過剰な余白を設けない
- Researchに独立Headerを復活させない
- Navigation、Conversation、Artifactの構造を理由なく変更しない
- Gradientや過度な装飾を追加しない
- DrawerとOverlayの前後関係を変更しない
