<p align="center">
  <img src="assets/icons/app-192.png" alt="Alexa Alarm Skip App Icon" width="96" height="96">
</p>

# Alexa Alarm Skip (`alexa-alarm-skip`)

[日本語版はこちら (README.md)](README.md)

A personal utility (Windows Desktop App / Android App / CLI) that lets you skip or restore **only the next occurrence** of recurring alarms configured on your Amazon Echo devices with a single tap.

> [!NOTE]
> Instead of disabling the recurring alarm itself (which risks forgetting to turn it back on), this tool skips only the upcoming trigger so subsequent schedules ring as usual.

## Key Features

- **All Echo Devices**: View and manage alarms across all Echo devices linked to your account.
- **24-Hour Timeline**: Inspect alarms scheduled to ring within the next 24 hours in chronological order.
- **One-Tap Next-Occurrence Skip / Restore**: Skip or restore only the next alarm occurrence without breaking the recurring rule.
- **Cloud Differential Sync**: Synchronizes skipped and active states based on Alexa cloud state.
- **Windows Standalone Desktop App**: `.NET 10` WinForms + WebView2 host window with dark mode, window position persistence, and single-instance guard.
- **Android App & Home Screen Widgets**: Capacitor + embedded Node.js Android app with `1×1` and `2×1` home screen widgets.

## Windows PC Setup

### Requirements

- **Windows 10 / 11 (x64)**
- **[.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0)** (Required)
- **[Node.js (v22 or later)](https://nodejs.org/)** (Required for the local backend server)
- **Microsoft Edge WebView2 Runtime** (Pre-installed on Windows 11)

### Launch Steps

1. Download the latest `alexa-alarm-skip-windows_vX.Y.Z.zip` from [GitHub Releases](https://github.com/doanobu8982-design/alexa-alarm-skip/releases).
2. Extract the ZIP archive to any folder.
3. Run `AlexaAlarmSkip.exe` inside the extracted folder.

> [!TIP]
> To use the CLI or browser mode from source, run `npm ci`, then `npm run web` or `npm run list`.

## Android Setup

1. Download the latest `alexa-alarm-skip-android_vX.Y.Z.apk` and `checksums.txt` from [GitHub Releases](https://github.com/doanobu8982-design/alexa-alarm-skip/releases).
2. Verify the SHA-256 checksum before installation if desired.
3. Open the downloaded `.apk` on your Android device and allow installation from unknown sources if prompted.

### Building a Signed Android APK from Source

```bash
cp android/keystore.properties.example android/keystore.properties
# Fill in your keystore path, alias, and passwords in android/keystore.properties

npm ci
npm run cap:sync
cd android
./gradlew assembleRelease
```

## Checksum Verification

```powershell
# Windows (PowerShell)
Get-FileHash -Algorithm SHA256 .\alexa-alarm-skip-windows_vX.Y.Z.zip
```

```bash
# macOS / Linux
sha256sum -c checksums.txt
```

## Disclaimer & Security

> [!WARNING]
> - This tool relies on unofficial Amazon Alexa APIs (`alexa-remote2` / `alexa-cookie2`) and is **not an official Amazon application**.
> - Changes on Amazon's side may cause this tool to stop working without notice.
> - Authentication cookies (`alexa-cookie.json`, etc.) are stored locally on your device only. Never share them.

## License

This project's source code is licensed under the [MIT License](LICENSE).

## Third-Party Credits

The SVG icons used in the UI are provided under the following open-source licenses:

- **`www/assets/spinner-90-ring.svg`**: [SVG Spinners](https://github.com/n3r4zzurr0/svg-spinners) (MIT License)
- **UI Line Icons**: [Lucide Icons](https://lucide.dev/) (ISC License)
