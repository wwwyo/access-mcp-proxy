# Access MCP Proxy

Cloudflare AccessのJWTを検証し、ローカルMCPサーバーへの固定Bearerを内部で付与して外部agentへ公開する個人用Proxy。最初の対象upstreamはローカルOpenScreen。

## 構造

- `src/config.ts`: 起動設定の検証。
- `src/auth.ts`: Access JWTの検証とユーザー制限。
- `src/proxy.ts`: HTTP中継、セッション、切断・容量制限。
- `src/redact.ts`: 応答に混入した固定トークンの除去。
- `test/`: HTTP経由のテスト。
- `docs/connect.md`: CloudflareとChatGPTの設定。
- `docs/prd/`: 要件。
- `docs/adr/`: 設計判断。

## 開発

Node.js 24、TypeScript、pnpm、jose。`mise install`後、`mise exec -- pnpm install --frozen-lockfile`。
チェック: `mise exec -- pnpm check`、`mise exec -- pnpm test`、`mise exec -- pnpm build`。
秘密はmise + age。環境固有の設定と暗号文はgitignore済みの`mise.local.toml`に置き、public repoへcommitしない。平文で保存・出力せず、テストでは専用のfixtureだけを使用する。
依存はexact pin + 7日cooldown。認証を無効にする開発モードを追加しない。
通信境界を変える際はREADMEと`docs/adr/0001-auth-boundary.md`を読む。
Cloudflareを操作する際は`cf` CLIを優先し、Orca stateの操作は`orca` CLI経由にする。
追加のCodex実行・他エージェント実行は、料金の可能性を説明してユーザー確認を得てから行う。

## Glossary

- Access assertion: Cloudflareがoriginへ付与する署名済みJWT。クライアントのOAuth tokenとは別物。
- OpenScreen token: ローカルOpenScreenだけに送る固定Bearer。
- Session owner: Access JWTの`sub`。上流のMCPセッションをこのユーザーに結び付ける。
- Route: 外部agentへ公開する単位。公開URL・上流MCP・上流の秘密（mise環境変数名）・Access app（AUD）の組。Routeごとに別のAccess appを使う（ADR 0002）。

## Pullfrog

設定の正本は[`.github/pullfrog.config.sh`](.github/pullfrog.config.sh)。`.github/workflows/pullfrog.yml`はPullfrog管理のため編集しない。初回レビュー・追加コミットの再レビューとも自動で行い、手動レビューは`@pullfrog`で依頼する。
