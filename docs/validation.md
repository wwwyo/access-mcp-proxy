# 検証記録

検証日: 2026-10-13。macOS arm64 / Node.js 24.21.0 / pnpm 12.9.1。
依存: jose 6.2.12、TypeScript 7.0.2、@types/node 26.6.4。exact pinと7日cooldownで取得しlockfileを保存。

## 実施済み

| 確認 | 結果 |
| --- | --- |
| `pnpm check` | 成功 |
| `pnpm test` | 26件成功、失敗・skipなし |
| `pnpm build` | 成功 |
| ビルド後の`dist/main.js`起動 | 成功、loopback待受、未認証リクエスト401、ログにfixture tokenなし |
| OpenScreen `http://127.0.0.1:47821/mcp`の未認証GET | 401。資格情報を送らず本文も出力しない |
| 実OpenScreenの認証済みinitialize・tool一覧 | 成功（200）。編集toolは呼び出していない |
| Cloudflare Access・Tunnel・DNS | 設定済み。Tunnel healthy |
| 公開MCP URL（独自ドメインの`/mcp`）の未認証GET/POST | 401。偽造assertionでも拒否 |
| 公開OAuth discovery | resource `/mcp`一致、issuer HTTPS一致、DCR・S256・public client・refresh grantを確認 |
| 許可外のredirect URIによるDCR | 400で拒否 |

HTTPテストでは、ローカルのOpenScreen代替サーバーとJWKS配信サーバー、実RS256署名を使用。上流で観測するリクエストとクライアント側のステータス・ヘッダー・本文を確認した。

認証検証はissuer・AUD・署名・exp/iat/nbf・sub・email・token type、未認証、CookieやBearerのみ、JWKS停止を網羅。認証失敗時に上流へリクエストが届かないことを確認した。

中継はPOSTの本文、JSON応答、GET SSEの逐次受信、DELETE、再接続ヘッダー、セッションのユーザー隔離、切断・期限切れ、サイズ上限、Host/Origin/重複ヘッダー、上流redirect・認証失敗・接続失敗を確認。固定トークンの本文・許可ヘッダーへの混入と、チャンク境界をまたぐURL encode/raw形式の除去も確認した。

## 未実施

- 本物のAccess assertionを使うJWT検証・鍵rotation。
- 実OpenScreenの編集tool呼び出し。
- ChatGPTでのDCR・PKCE・refresh・再接続・tool操作。
- Cloudflare経由の実ストリームに対する遅延・buffering確認。

未認証GETの401は、ローカルOpenScreenの認証入口が応答することだけを示す。Streamable HTTP対応や認証済みtool操作の成功を意味しない。[接続ガイド](connect.md)に従って実環境を検証する。

独立したlintは未設定。OpenScreen tokenとTunnel tokenは作者の環境の`mise.local.toml`にage暗号文で保存し、repoには含めない。平文は出力・ファイル保存していない。
