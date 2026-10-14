// A Windows notification ("toast"), shown under VS Code's own name. Pure: the
// XML and the PowerShell that shows it; host/windowsToast.ts runs it.
//
// The script is a constant. The toast's XML (which carries text from the
// model: a session title, a file name) reaches it only as an environment
// variable, so nothing in it is ever parsed as PowerShell. The XML itself
// escapes every value.
//
// A click opens `launch` (a vscode:// link) through Windows's protocol
// activation: VS Code comes to the front and hands the link to the extension
// (extension.ts registerUriHandler).

export interface ToastContent {
  title: string;
  body: string;
  /** The small grey line under the body. */
  attribution?: string;
  /** The one button. */
  action: string;
  /** The vscode:// link a click (on the toast or the button) opens. */
  launch: string;
  /** A file:// URL of a PNG shown at the left (the Hermes mark). */
  logo?: string;
}

/** Characters XML 1.0 cannot carry at all (controls other than tab, LF, CR). */
// A string, not a regex literal: formatters rewrite \u escapes of
// noncharacters into invisible literal characters.
// biome-ignore lint/complexity/useRegexLiterals: see above
const XML_BAD = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]", "g");

export function xmlEscape(s: string): string {
  return s
    .replace(XML_BAD, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function toastXml(c: ToastContent): string {
  const e = xmlEscape;
  const attribution = c.attribution
    ? `<text placement="attribution">${e(c.attribution)}</text>`
    : "";
  const logo = c.logo
    ? `<image placement="appLogoOverride" hint-crop="none" src="${e(c.logo)}"/>`
    : "";
  return (
    `<toast launch="${e(c.launch)}" activationType="protocol">` +
    `<visual><binding template="ToastGeneric">` +
    `<text hint-maxLines="1">${e(c.title)}</text>` +
    `<text>${e(c.body)}</text>` +
    attribution +
    logo +
    `</binding></visual>` +
    `<actions><action content="${e(c.action)}" activationType="protocol" arguments="${e(c.launch)}"/></actions>` +
    `</toast>`
  );
}

/**
 * Shows $env:HS_TOAST_XML under the app id $env:HS_TOAST_APPID — or, when
 * that is empty, the Start menu app named $env:HS_TOAST_APPNAME ("Visual
 * Studio Code"): its id is printed as `appid=…` so the next toast skips the
 * lookup. Windows PowerShell 5.1 (it has the WinRT projection).
 */
export const TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
  "[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
  "$id = $env:HS_TOAST_APPID",
  "if (-not $id) {",
  "  $app = Get-StartApps | Where-Object { $_.Name -eq $env:HS_TOAST_APPNAME } | Select-Object -First 1",
  "  if (-not $app) { Write-Output 'appid='; exit 3 }",
  "  $id = $app.AppID",
  "}",
  "$doc = New-Object Windows.Data.Xml.Dom.XmlDocument",
  "$doc.LoadXml($env:HS_TOAST_XML)",
  "$toast = New-Object Windows.UI.Notifications.ToastNotification $doc",
  "$toast.Tag = $env:HS_TOAST_TAG",
  "$toast.Group = 'hermes-studio'",
  "$toast.ExpirationTime = [DateTimeOffset]::Now.AddMinutes(30)",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show($toast)",
  'Write-Output "appid=$id"',
].join("\n");

/** For `powershell.exe -EncodedCommand`: base64 of the UTF-16LE text. */
export function encodeCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** A toast replaces the previous one with the same tag (≤ 64 characters). */
export function toastTag(kind: string, sessionId: string): string {
  return `${kind}-${sessionId}`.replace(/[^\w-]/g, "").slice(0, 64);
}
