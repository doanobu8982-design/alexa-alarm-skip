<p align="center">
  <img src="assets/icons/app-192.png" alt="Alexa アラーム管理 アプリアイコン" width="96" height="96">
</p>

# Alexa アラーム管理 (alexa-alarm-skip)

[English version is here (README_en.md)](README_en.md)

Amazon Echo に設定された繰り返しアラームの**「次回分だけ」**をワンタップでスキップ・復元できる個人向けツール（Windows デスクトップアプリ / Android アプリ / CLI）です。

> [!NOTE]
> 繰り返し設定そのものをオフにして戻し忘れる事故を防ぐため、次回鳴動分のみをスキップし、翌回以降は通常どおり鳴動するように制御します。

## 主な機能

- **全 Echo デバイス対応**: アカウントに紐づく Echo デバイスのアラームを一覧表示・操作できます。
- **直近24時間タイムライン**: これから24時間以内に鳴動予定のアラームを時系列で確認できます。
- **次回分ワンタップスキップ / 元に戻す**: 繰り返しの親設定を壊さず、次回分だけをスキップ状態へ切り替え・復元できます。
- **クラウド差分スキップ検知**: Alexa クラウド側の状態を基準にスキップ済み・有効状態を同期します。
- **Windows 独立デスクトップアプリ**: `.NET 10` WinForms + WebView2 による専用ウィンドウ（ダークモード・ウィンドウ位置記憶・単一インスタンス制御対応）。
- **Android アプリ＆ホーム画面ウィジェット**: Capacitor + 内蔵 Node.js による Android アプリと、`1×1` / `2×1` サイズのホーム画面ウィジェットに対応。

## Windows PC 版の導入方法

### 動作要件

- **Windows 10 / 11 (x64)**
- **[.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0)**（必須）
- **[Node.js (v22以上)](https://nodejs.org/)**（必須・バックエンドサーバー起動用）
- **Microsoft Edge WebView2 Runtime**（Windows 11 には標準搭載）

### 起動手順

1. [GitHub Releases](https://github.com/doanobu8982-design/alexa-alarm-skip/releases) から最新の `alexa-alarm-skip-windows_vX.Y.Z.zip` をダウンロードします。
2. 配布 ZIP を任意のフォルダへ解凍します。
3. 解凍したフォルダ内の `AlexaAlarmSkip.exe` を起動します。

> [!TIP]
> CLI / ブラウザ版として利用する場合は、ソースを取得して `npm ci` のうえ `npm run web` または `npm run list` を実行してください。

## Android 版の導入方法

1. [GitHub Releases](https://github.com/doanobu8982-design/alexa-alarm-skip/releases) から最新の `alexa-alarm-skip-android_vX.Y.Z.apk` と `checksums.txt` をダウンロードします。
2. 必要に応じてインストール前に SHA-256 チェックサムを検証します。
3. Android 端末でダウンロードした `.apk` を開き、画面の案内に従って「提供元不明のアプリ（不明なアプリのインストール）」を許可してインストールします。

### ソースからの Android リリースビルド

```bash
cp android/keystore.properties.example android/keystore.properties
# android/keystore.properties にご自身のキーストア情報を記入してください

npm ci
npm run cap:sync
cd android
./gradlew assembleRelease
```

## チェックサムの検証

```powershell
# Windows (PowerShell)
Get-FileHash -Algorithm SHA256 .\alexa-alarm-skip-windows_vX.Y.Z.zip
```

```bash
# macOS / Linux
sha256sum -c checksums.txt
```

## 注意事項・免責事項

> [!WARNING]
> - 本ツールは Amazon Alexa の非公式 API（`alexa-remote2` / `alexa-cookie2`）を利用しており、**Amazon 公式アプリではありません**。
> - Amazon 側の仕様変更により、予告なく動作しなくなる場合があります。
> - 認証 Cookie（`alexa-cookie.json` 等）はお使いの端末内にのみ保存されます。第三者と共有しないでください。

## ライセンス

本プロジェクトの本体コードは [MIT License](LICENSE) のもとで公開されています。

## サードパーティ・クレジット

UI で使用している SVG アイコンは以下のオープンソース素材を利用しています。

- **`www/assets/spinner-90-ring.svg`**: [SVG Spinners](https://github.com/n3r4zzurr0/svg-spinners) (MIT License)
- **UI 細線アイコン**: [Lucide Icons](https://lucide.dev/) (ISC License)
