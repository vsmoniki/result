# Zwift Result Image Maker

FITまたはCSVファイルを読み込ませることで、Zwift風のリザルトPNG画像をブラウザ内で作成できます。

## 機能

- FIT / CSVファイルをローカルのブラウザ内で解析（アップロードなし）
- 「完走タイム」画像を生成
  - 完走時間を表示
  - 20分 / 5分 / 1分 / 15秒のベスト平均パワーを、入力体重で割った W/kg として表示
- 「ライドレポート」画像を生成
  - 入力したライドタイトルをヘッダーに表示
  - 平均パワー、距離、経過時間、消費カロリー、最大パワー、最大心拍を表示
  - 3秒平均パワーを使ったタイムライングラフ
  - FTP基準のパワーゾーン色分け（Z1: グレー、Z2: 青、Z3: 緑、Z4: 黄、Z5: オレンジ、Z6以上: 赤）
  - 心拍推移を赤線で表示
  - パワー分布 / 心拍分布の簡易ヒストグラムを表示
- 生成した画像をPNGで保存

## 使い方

```bash
npm install
npm run dev
```

ブラウザで表示されたURLを開き、FITまたはCSVファイルを選択して必要項目を入力してください。CSVはヘッダー付きで、時刻または経過時間、パワー、心拍、ケイデンス、距離、速度などの列を自動判別します。

## ビルド

```bash
npm run build
```

## デプロイ

GitHub Pages 用の自動デプロイ設定を同梱しています。

1. GitHubリポジトリの **Settings > Pages** で Source を **GitHub Actions** に設定します。
2. `main` / `master` / `work` ブランチへマージまたはプッシュすると、`.github/workflows/deploy.yml` が `npm ci` と `npm run build` を実行し、`dist/` をGitHub Pagesへ公開します。
3. 手動で再デプロイしたい場合は、GitHub Actions の **Deploy to GitHub Pages** ワークフローから **Run workflow** を実行します。

Viteの `base` は `./` に設定しているため、GitHub Pages のサブパス配信でもアセットを読み込めます。
