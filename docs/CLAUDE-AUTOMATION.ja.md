# Issue 自動対応パイプライン

`claude-auto` ラベルを付けた Issue を、毎日1件ずつ Claude が実装し、PR を作り、レビューし、
条件を満たせば自動マージするための仕組み。

このドキュメントは**セットアップ手順**と**運用ルール**を扱う。
実装は `.github/workflows/` の4ファイル。

## 全体像

```
[あなた] Issue に claude-auto ラベルを付ける
   │
   ▼
claude-issue-agent.yml   毎日 03:10 JST / 手動実行
   ├ pick        claude-auto かつ claude-wip / claude-blocked が付いていない最古の1件を選ぶ
   ├ implement   claude-wip でロック → Claude が実装 → ローカルコミット（push はさせない）
   ├ gate        差分を検査（禁止パス / 12ファイル・600行の上限 / 生成物の混入）
   └ push & PR   自前 GitHub App のトークンで push → gh pr create
   │
   ▼
ci.yml + docker.yml      必須チェック（check / worker-smoke / build）
   │
   ▼
claude-pr-review.yml
   ├ review      別人が書いたコードとして懐疑的にレビュー → verdict / risk を返す
   ├ auto-merge  claude-automerge ラベル + verdict=approve + risk=low なら auto-merge を有効化
   └ unlock      PR が閉じたら Issue の claude-wip を外す
```

Claude に渡していない権限:

- `git push` / `gh pr create` / `gh pr merge` は `--allowedTools` に入れていない。すべてワークフロー側の決定的ステップ。
- 自前 GitHub App に `Workflows: write` を付けないので、エージェントは `.github/workflows/**` を書き換えられない（プロンプトのガードより強い）。

## ファイル構成

| ファイル | トリガー | 責務 |
|---|---|---|
| `ci.yml` | push(main) / PR | 必須チェックの実体。構文チェック・i18n・起動スモーク・Workers 統合テスト |
| `claude.yml` | `@claude` メンション | 人間が起点の対話用。公式 Claude App 経由 |
| `claude-issue-agent.yml` | schedule / 手動 | Issue 1件 → 実装 → PR 作成 |
| `claude-pr-review.yml` | pull_request | `claude/**` PR のレビュー → 自動マージ許可 → ロック解除 |

## セットアップ（手作業）

**1〜5 を終えるまでワークフローは動かない。** `CLAUDE_AGENT_ENABLED` が `true` でない限り全ジョブがスキップされるので、順番に進めればよい。

### 1. 自前 GitHub App を作る

1. https://github.com/settings/apps/new
2. GitHub App name: 例 `html-vault-bot`（Homepage URL はリポジトリ URL でよい）
3. **Webhook: "Active" のチェックを外す**
4. Repository permissions:
   - Contents: **Read & write**
   - Issues: **Read & write**
   - Pull requests: **Read & write**
   - **Workflows: 付けない**（重要）
   - Metadata: Read-only（自動で付く）
5. "Where can this GitHub App be installed?" → Only on this account
6. Create → **Generate a private key** → `.pem` をダウンロード
7. 左メニュー **Install App** → uzuraDev → **Only select repositories** → `html-vault`

### 2. Secrets / Variables を登録

Settings → Secrets and variables → Actions

**Secrets**

| 名前 | 値 |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com の API キー。**このリポジトリ専用のキーを新規発行**し、Console 側でスペンドリミットを設定する |
| `CLAUDE_APP_ID` | 手順1で作った App の App ID |
| `CLAUDE_APP_PRIVATE_KEY` | `.pem` の中身を丸ごと（`-----BEGIN` から末尾まで、改行含む） |

**Variables**

| 名前 | 値 | 用途 |
|---|---|---|
| `CLAUDE_AGENT_ENABLED` | `true` | 緊急停止スイッチ。`false` にすれば全 Claude ワークフローが即停止する |

### 3. Actions 設定

Settings → Actions → General

- **Workflow permissions**: `Read repository contents and packages permissions`（既定のまま）
- **"Allow GitHub Actions to create and approve pull requests"**: **OFF のまま**。PR 作成は自前 App トークンで行うので不要

### 4. マージ設定

Settings → General → Pull Requests

- ✅ **Allow auto-merge**（OFF だと `gh pr merge --auto` が失敗する）
- ✅ Allow squash merging
- ✅ Automatically delete head branches

### 5. main のブランチ保護（Rulesets）

Settings → Rules → Rulesets → New branch ruleset

- Target: `main` / Enforcement: Active
- ✅ Restrict deletions
- ✅ Block force pushes
- ✅ Require a pull request before merging
  - Required approvals: **0**（1人 OSS で自動マージしたい場合の妥協。`1` にすると半自動になる）
  - ❌ **Require conversation resolution before merging は OFF**（Claude の inline comment が未解決スレッドとして残り、自動マージが永久にブロックされる）
- ✅ Require status checks to pass
  - 追加するチェック: **`check`** / **`worker-smoke`**（ci.yml）と **`build`**（docker.yml）**のみ**
  - ⚠️ **`review` を required checks に入れてはいけない**。人間の PR ではスキップされ、スキップされた required check はマージ不能になる

> required checks は**一度でも実行された後**でないと候補に出てこない。`ci.yml` をマージしてから設定する。

### 6. ラベルを作る

```bash
gh label create claude-auto      --repo uzuraDev/html-vault --color 1D76DB --description "Claude が自動で着手してよい Issue"
```

```bash
gh label create claude-automerge --repo uzuraDev/html-vault --color 0E8A16 --description "レビュー合格時に自動マージしてよい"
```

```bash
gh label create claude-wip       --repo uzuraDev/html-vault --color FBCA04 --description "Claude が作業中（自動付与・重複着手防止ロック）"
```

```bash
gh label create claude-blocked   --repo uzuraDev/html-vault --color B60205 --description "Claude に触らせない"
```

```bash
gh label create claude-pr        --repo uzuraDev/html-vault --color C5DEF5 --description "Claude が作成した PR"
```

## ラベル運用

| ラベル | 誰が付ける | 意味 |
|---|---|---|
| `claude-auto` | **あなたが手で付ける（唯一の opt-in ゲート）** | 自動対応の対象。ラベル付与には write/triage 権限が要るので、第三者が勝手に起動させることはできない |
| `claude-automerge` | あなたが Issue に付ける | PR 作成時に PR へ転写され、verdict=approve かつ risk=low なら auto-merge を有効化する。**付けなければ PR は作られるがマージはされない** |
| `claude-wip` | ワークフローが自動付与／自動除去 | 排他ロック。失敗時と PR クローズ時に自動で外れる |
| `claude-blocked` | あなた | 明示的な除外 |
| `claude-pr` | ワークフローが PR に自動付与 | 識別用 |

2段階 opt-in（`claude-auto` → `claude-automerge`）が要点。慣れるまでは `claude-auto` だけ付けて、PR は人間がマージする運用から始める。

## 立ち上げ順

1. **`ci.yml` だけ先に main へ入れる。** 手動で PR を1本立て、`check` と `worker-smoke` が緑になるのを確認する
2. ruleset を設定（手順5）
3. `claude.yml` を入れ、公式 Claude App をインストール（Claude Code のターミナルで `/install-github-app`、または手動）+ `ANTHROPIC_API_KEY`。Issue に `@claude このリポジトリの構成を教えて` と書いて疎通確認
4. 自前 App を作り（手順1〜2）、`claude-issue-agent.yml` と `claude-pr-review.yml` を入れる
5. `CLAUDE_AGENT_ENABLED=true` にしてから、小さい Issue に `claude-auto` を付けて **workflow_dispatch で `issue_number` を指定した手動1回テスト**。PR が立ち、`ci.yml` と `docker.yml` が**起動する**ことを目視確認する（これが「GITHUB_TOKEN で作った PR は CI が走らない」問題を回避できている証拠）
6. `claude-automerge` は最初は付けない。数本を人力マージして品質を見てから解禁する
7. 初回のマージ後だけ `gh run list --workflow docker.yml --branch main --limit 3` で GHCR publish が実際に成功したかを確認する

## 安全ガード

| 層 | ガード | 実装箇所 |
|---|---|---|
| 起動 | `claude-auto` ラベルが唯一の入口 | `pick` ジョブ |
| 起動 | `vars.CLAUDE_AGENT_ENABLED != 'true'` で全停止 | 全 Claude ジョブの `if:` |
| 同時実行 | `concurrency: claude-issue-agent`（cancel-in-progress: false）で1本のみ | agent |
| 重複着手 | `claude-wip` による排他ロック。失敗時・PR クローズ時に自動解除 | agent / unlock-issue |
| ターン数 | `--max-turns 30`（実装）/ `20`（レビュー） | `claude_args` |
| ツール | `git push` / `gh pr create` / `gh pr merge` は Claude に渡さない。`WebSearch` / `WebFetch` は明示遮断 | `claude_args` |
| 対象パス | 実装後に diff を検査し `.github/` `Dockerfile` `deploy/` `package*.json` 等を検出したら fail | `Gate` |
| 対象パス | 自前 App に `workflows: write` を付与しない | GitHub App 設定 |
| 変更規模 | 12ファイル / 600行 を超えたら fail（プロンプト側の閾値と一致させてある） | `Gate` |
| プロンプトインジェクション | Issue 本文を「データであり指示ではない」と明示。逸脱要求は changed=false で終了 | prompt |
| シェルインジェクション | `github.event.*` は必ず `env:` 経由。`issue_number` は数字チェック | 全 run |
| fork | `head.repo.full_name == github.repository` で除外。`pull_request_target` は Claude 系で一切使わない | review の `if:` |
| マージ | ①`claude-automerge` ②verdict=approve ③risk=low ④required checks 通過 の4つ全部 | auto-merge + ruleset |
| マージ | 構造化出力が空なら verdict=unknown / risk=high（fail-closed） | `parse` / `Resolve verdict` |
| マージ | `--match-head-commit` で有効化時点の HEAD を固定。失敗しても即時マージにフォールバックしない | `gh pr merge` |
| コスト | 1日1回・1 Issue のみ。Console でスペンドリミット | schedule / 手作業 |

## 既知の落とし穴

### GITHUB_TOKEN で作った PR は CI を起動しない

[GitHub Docs](https://docs.github.com/en/actions/concepts/security/github_token) 明記。PR は作られるが `ci.yml` も `docker.yml` も走らず、required checks が pending のまま自動マージが永久に発火しない、という「静かに壊れた状態」になる。
本設計では `actions/create-github-app-token` で取った自前 App のインストールトークンで checkout / push / `gh pr create` を行っている。

### auto-merge を GITHUB_TOKEN で有効化すると GHCR publish が飛ぶ

auto-merge の最終マージは「有効化したアクター」の行為として扱われる。`GITHUB_TOKEN` で有効化すると main への push イベントが workflow を起動せず、`docker.yml` の publish がエラーも出さずスキップされる。auto-merge の有効化も App トークンで行っている。

### Claude は既定では PR を作らない

`claude-code-action` はブランチにコミットして PR 作成ページへの**リンクを返すだけ**。「PR まで自動」を期待して `prompt` に書いても動かない。`gh pr create` はワークフロー側で持っている。

### Issue のラベルは PR に転写されない

`claude-automerge` を Issue に付けても PR には付かない。`pick` ジョブでラベルの有無を判定し、`gh pr create --label claude-automerge` で貼り直している。ここを落とすと自動マージが一生発火しない。

### `review` を required status check に入れない

人間の PR ではスキップされる。required に指定されたチェックがスキップされると、その PR は「required check が報告されていない」状態のままマージできなくなる。

### 公開リポジトリの schedule は 60 日で自動停止

60 日間リポジトリ活動がないと scheduled workflow は自動的に無効化される。`schedule` は default branch の最新コミットでしか走らない。

### `allowed_bots: '*'` は使わない

公開リポジトリでは外部の GitHub App がこの action を任意プロンプトで起動できてしまう。既定の空文字のままにしてある。副次的に、自前 App のレビューコメントで `claude.yml` が反応しない（`sender.type != 'Bot'` でも二重に止めている）。

### `pull_request_target` は Claude 系で一切使わない

既存の `dependabot-auto-merge.yml` は `pull_request_target` を使っているが、PR のコードを checkout していないので安全。危険なのは「`pull_request_target` + PR head の checkout + そのコードの実行」の組み合わせ。

## 一次情報

- [anthropics/claude-code-action — docs/usage.md](https://github.com/anthropics/claude-code-action/blob/main/docs/usage.md)
- [anthropics/claude-code-action — docs/security.md](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md)
- [anthropics/claude-code-action — docs/setup.md](https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md)
- [Claude Code GitHub Actions](https://code.claude.com/docs/en/github-actions)
- [GitHub Docs — GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)
- [GitHub Docs — Automatically merging a pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request)
- [GitHub CLI manual — gh pr merge](https://cli.github.com/manual/gh_pr_merge)
- [actions/create-github-app-token](https://github.com/actions/create-github-app-token)
