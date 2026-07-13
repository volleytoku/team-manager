# Team Manager 📋

部署の情報共有・タスク管理・カレンダーをひとつにまとめたWebアプリ。
Notion風のシンプルなデザイン。GitHub Pages でホスティングし、データは Firebase（無料枠）に保存します。

## 機能

- **💬 掲示板** — 投稿・コメント・📌固定表示。部署内の情報共有に
- **✅ タスク** — 担当者・期限・ステータス・進捗%を管理。🔒プライベート（本人のみ表示）と公開の切替可
- **👥 メンバー** — ポジション別にメンバーの公開タスクと進捗を一覧
- **📅 カレンダー** — タスク期限と予定をまとめて月表示。日付クリックで追加
- **🔑 認証** — 各自が ID / パスワードで登録・ログイン

## 初期設定（最初に1回だけ）

### 1. Firebase プロジェクトを作成

1. [Firebase Console](https://console.firebase.google.com/) を開き「プロジェクトを追加」
2. プロジェクト名は任意（例: `team-manager`）。Google アナリティクスは不要（オフでOK）

### 2. Authentication を有効化

1. 左メニュー「構築」→「Authentication」→「始める」
2. 「メール / パスワード」を選び、有効にして保存

### 3. Firestore Database を作成

1. 左メニュー「構築」→「Firestore Database」→「データベースを作成」
2. ロケーションは `asia-northeast1`（東京）推奨、「本番環境モード」で作成
3. 作成後、「ルール」タブを開き、このリポジトリの `firestore.rules` の中身を貼り付けて「公開」

### 4. ウェブアプリを登録して設定を取得

1. プロジェクトの設定（⚙）→「マイアプリ」→ ウェブ（`</>`）アイコン
2. アプリ名は任意。「Firebase Hosting」のチェックは不要
3. 表示される `firebaseConfig = { ... }` をコピー
4. このリポジトリの `firebase-config.js` に貼り付けてコミット & プッシュ

### 5. 承認済みドメインの追加

1. Authentication →「設定」→「承認済みドメイン」
2. GitHub Pages のドメイン（`○○.github.io`）を追加

これで完了。GitHub Pages の URL にアクセスし、「新規登録」からアカウントを作成して使い始められます。

## 更新方法

```bash
cd ~/team_manager
git add -A && git commit -m "update" && git push
```

数十秒〜数分で GitHub Pages に反映されます。

## 技術構成

- フロントエンド: HTML / CSS / Vanilla JS（ビルド不要）
- 認証: Firebase Authentication（ID を `id@team-manager.app` 形式の疑似メールに変換）
- データベース: Cloud Firestore（リアルタイム同期）
- ホスティング: GitHub Pages

## セキュリティについて

- URL を知っていてもログインしないとデータは見えません（Firestore ルールで保護）
- 🔒プライベートのタスク・予定は Firestore ルールにより本人以外読み取り不可
- `firebase-config.js` の apiKey は公開されても問題ない設計です（Firebase の仕様）
