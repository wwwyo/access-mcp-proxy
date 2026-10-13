# Access MCP Proxy

ローカルのMCPサーバーをCloudflare Access越しにChatGPTなどの外部agentへ公開するTypeScript製Proxyです。Cloudflare Accessの認証済みユーザーを検証し、上流MCPの固定Bearer Tokenを内部で付与します。

現在の上流は、最初の対象であるローカルOpenScreenだけです。以下の設定・検証はOpenScreenを前提にしています。

[接続・Cloudflare設定](docs/connect.md) · [設計判断](docs/adr/0001-auth-boundary.md) · [検証記録](docs/validation.md)

```text
ChatGPT ── OAuth Bearer ──▶ Cloudflare Access Managed OAuth
                                │ 署名済み Cf-Access-Jwt-Assertion
                                ▼
                         Cloudflare Tunnel
                                ▼
                    Proxy: 127.0.0.1:47822/mcp
                                │ 固定Bearer（環境変数から取得）
                                ▼
                   OpenScreen: 127.0.0.1:47821/mcp
```

**状態:** ローカルProxy・Cloudflare Access/Tunnel/DNSを設定済み。公開URLのOAuth discoveryと実OpenScreenの認証接続を検証済みです。ChatGPTでのOAuthログイン・tool scanは未実施です。

## 起動

OpenScreenのStreamable HTTPエンドポイントと固定トークン、Cloudflareの独自ドメイン・AccessアプリのAUD tag・team domainが必要です。CloudflareとChatGPT側の手順は[接続ガイド](docs/connect.md)を参照してください。

プロジェクトのディレクトリで実行します。開発用ツールは`mise.toml`で固定し、依存関係は公開後7日以上経過した版をexact pinしています。

```sh
mise trust
mise install
mise exec -- pnpm install --frozen-lockfile
```

`env.example`は変数一覧です。Proxyは`.env`を自動読み込みしません。次の設定をrepo rootの`mise.local.toml`（gitignore済み）の`[env]`に書き、例の値を自分の環境に置き換えます。tracked の`mise.toml`はツールの版だけを持ちます。

```toml
[env]
PUBLIC_MCP_URL = "https://mcp.example.com/mcp"
CF_ACCESS_ISSUER = "https://your-team.cloudflareaccess.com"
CF_ACCESS_AUD = "your-application-audience-tag"
ALLOWED_EMAILS = "you@example.com"
# PROXY_PORT = "47822"
# OPENSCREEN_MCP_URL = "http://127.0.0.1:47821/mcp"
```

`OPENSCREEN_TOKEN`はmise + ageで`mise.local.toml`に暗号化保存し、起動時に環境変数へ復号します。暗号文であっても、環境固有の値と一緒にcommitしません。macOS Keychainに`mise-age-key`が登録済みの環境では、ローカルの対話ターミナルで次を実行できます。入力はマスクされ、トークンをコマンド履歴や引数に含めません。

```sh
mise set --file mise.local.toml --age-encrypt --prompt \
  --age-recipient "$(security find-generic-password -a "$USER" -s mise-age-key -w | age-keygen -y)" \
  OPENSCREEN_TOKEN
```

Keychainの鍵を読めるmise起動環境が必要です。別OSでは自分のage recipientと安全な鍵供給方法を使ってください。平文トークン・復号鍵をファイル、チャット、ログへ貼り付けないでください。

```sh
mise exec -- pnpm build
mise exec -- pnpm start
```

起動成功時に`MCP proxy ready on loopback`と表示されます。非対話プロセスでKeychainの鍵が環境に注入されない場合は、同じ起動コマンドを以下の形で実行します。

```sh
MISE_AGE_KEY="$(security find-generic-password -a "$USER" -s mise-age-key -w)" \
  mise exec -- pnpm start
```

## 検証・開発

```sh
mise exec -- pnpm check
mise exec -- pnpm test
mise exec -- pnpm build
mise exec -- pnpm dev
```

テストはローカルHTTPのOpenScreen代替サーバーとJWKS配信サーバーを起動し、実際にRS256署名を検証します。実トークンも外部のAI APIも使いません。独立したlint設定はありません。

## 対応範囲と境界

- `/mcp`のPOST・GET・DELETEを中継。JSON応答とStreamable HTTP内のSSE、`Mcp-Session-Id`、`MCP-Protocol-Version`、`Last-Event-ID`を維持します。GETの405等も上流の応答を返します。
- 全MCPリクエストでAccess JWTのRS256署名・issuer・AUD・有効期限・ユーザーを確認します。Cookie、OAuthの不透明トークン、OpenScreenの固定トークン単独ではProxyを認証できません。
- localhostだけにbindし、HostとOriginを制限。上流も`127.0.0.1`に固定し、リダイレクトには追従しません。
- ヘッダーは許可したものだけ転送。上流のCookie・認証challenge・Locationを返さず、ログにヘッダーや本文を出しません。トークンが上流応答にそのまま、JSON文字列として、またはURL encodeで混入した場合はチャンク境界をまたいでも伏せます。
- リクエスト本文は1 MiBまで。ヘッダー16 KiB、リクエスト受信30秒、上流ヘッダー待ち15秒。応答はbackpressureを伴ってストリームし、クライアント切断とJWT期限切れで上流も切断します。
- セッションはJWTの`sub`に結び付け、最大1,000件・24時間無操作で破棄します。再起動で消えるため、ChatGPT側で再initializeが必要です。JWT更新で同一ユーザーのセッションは継続できます。

旧式HTTP+SSEの`/sse`・`/messages`やendpointイベントのURL書き換え、WebSocket、CORS経由のブラウザクライアントは対象外です。OpenScreenが旧式SSEしか提供しない場合には別の変換実装が必要です。

許可ユーザーは同じOpenScreenの権限を使います。個人用途では許可メールを本人1人に限定してください。OpenScreenの実装とローカルOSを信頼する構成であり、悪意ある上流が秘密を任意の別形式に符号化して返すことまで検出するDLPではありません。Cloudflare/OpenAIを経由するMCP本文自体には、必要なデータだけを含めてください。

## License

[MIT](LICENSE)
