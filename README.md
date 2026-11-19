<p align="center">
  <img src="assets/icons/app-192.png" alt="Alexa アラーム管理 アプリアイコン" width="96" height="96">
</p>

# Alexa アラーム管理 (alexa-alarm-skip)

Amazon Echo に設定された繰り返しアラームの**「次回分だけ」**をワンタップでスキップ・復元できる個人向けツール（Android アプリ / PC Web UI・CLI）です。

> [!NOTE]
> 繰り返し設定そのものをオフにして戻し忘れる事故を防ぐため、次回鳴動分のみをスキップし、翌回以降は通常どおり鳴動するように制御します。

## 主な機能

- **全 Echo デバイス対応**: アカウントに紐づく Echo デバイスのアラームを一覧表示・操作できます。
- **直近24時間タイムライン**: これから24時間以内に鳴動予定のアラームを時系列で確認できます。
- **次回分ワンタップスキップ / 元に戻す**: 繰り返しの親設定を壊さず、次回分だけをスキップ状態へ切り替え・復元できます。
- **クラウド差分スキップ検知**: Alexa クラウド側の状態を基準にスキップ済み・有効状態を同期します。
- **Android ホーム画面ウィジェット**: `1×1` および `1×2` サイズのウィジェットに対応し、バックグラウンドで自動更新されます。

## Android アプリの導入方法（メイン）

### 1. APK のダウンロードとインストール

1. [GitHub Releases](https://github.com/doanobu8982-design/alexa-alarm-skip/releases) から最新の `alexa-alarm-skip_vX.Y.Z.apk` と `checksums.txt` をダウンロードします。
2. 必要に応じてインストール前に SHA-256 チェックサムを検証します（後述）。
3. Android 端末でダウンロードした `.apk` を開き、画面の案内に従って「提供元不明のアプリ（不明なアプリのインストール）」を許可してインストールします。

### 2. SHA-256 チェックサムの検証

ダウンロードしたファイルが改ざんされていないことを確認できます。

```powershell
# Windows (PowerShell)
Get-FileHash -Algorithm SHA256 .\alexa-alarm-skip_vX.Y.Z.apk
```

```bash
# macOS / Linux
sha256sum -c checksums.txt
```

出力されたハッシュ値が `checksums.txt` 内の値と一致することを確認してください。

### 3. 初期ログインとホーム画面ウィジェットの配置

1. アプリを起動し、アプリ内 WebView から `Amazon.co.jp` にサインインします（認証 Cookie は端末内のみに保存されます）。
2. ログイン完了後、アラーム一覧が表示されます。
3. ホーム画面の空きスペースを長押し →「ウィジェット」から **Alexa アラーム管理**（`1×1` または `1×2`）を追加すると、次回アラームの予定とスキップ状態をホーム画面から確認できます。

## PC / CLI 版の利用方法（サブ）

PC 上でローカル Web UI または CLI として利用する場合は、Node.js **22 以上**が必要です。

1. [GitHub Releases](https://github.com/doanobu8982-design/alexa-alarm-skip/releases) から `alexa-alarm-skip_vX.Y.Z.zip` をダウンロードして解凍します。
2. 解凍したフォルダで依存パッケージをインストールします。

```bash
npm ci
```

3. 用途に応じて起動します。

```bash
# ブラウザで Web UI を起動
npm run web

# アプリウィンドウモードで起動
node prototype/web-ui.js --app

# CLI でアラーム一覧を表示
npm run list
```

> [!TIP]
> ネットワークや Cookie に干渉しない動作セルフテストは `npm run selftest`（`node prototype/skip-next-alarm.js --selftest`）で実行できます。

## ソースからの独自ビルド方法

ご自身の署名鍵を使って Android リリース APK をビルドする手順です。

### 1. 署名設定ファイルの作成

```bash
cp android/keystore.properties.example android/keystore.properties
```

`android/keystore.properties` を開き、ご自身のキーストアパスとパスワード・エイリアスを設定してください。

### 2. ビルド実行

```bash
npm ci
npm run cap:sync
cd android
./gradlew assembleRelease
```

ビルドが成功すると `android/app/build/outputs/apk/release/app-release.apk` が生成されます。

## 注意事項・セキュリティ・免責事項

> [!WARNING]
> - 本ツールは Amazon Alexa の非公式 API（`alexa-remote2` / `alexa-cookie2`）を利用しており、**Amazon 公式アプリではありません**。
> - Amazon 側の仕様変更により、予告なく動作しなくなる場合があります。
> - 認証後に生成されるセッション情報（`alexa-cookie.json`）や Android 署名鍵（`*.jks` / `android/keystore.properties`）は**第三者に絶対に共有しないでください**。
> - 本ツールの利用によって生じたいかなる損害についても作者は責任を負いません。自己責任でご利用ください。
