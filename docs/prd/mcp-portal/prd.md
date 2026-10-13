---
status: ready
---

# ローカルMCPをportal越しに外部agentへ公開する

## Problem

ローカルで動くMCPサーバーを、ChatGPTなどの外部agentから使いたい。現在のProxyはOpenScreen専用で、上流URL・固定token・Access AUDを環境変数で1組しか持てない。2つ目のMCPを公開するたびにProxyを複製するのは保守が重い。一方で、無造作に1回のログインの先へ全MCPを並べると、filesystemやshell系のMCPがprompt injectionの経路になる。

## Overview

本人は、公開したいローカルMCPをCloudflareのMCP Server Portalに登録する。外部agentは`https://mcp.wwwyo.dev/mcp`にOAuthでログインし、portalで許可したtoolだけを使える。権限の強いMCPは別のportalに置く（[ADR 0002](../../adr/0002-portal-by-privilege.md)）。上流の固定tokenはCloudflareに預け、外部agentには渡さない。

### Goals

- 2つ目以降のローカルMCPを、コードを書かずにportalへの登録だけで公開できる。
- 権限の弱いMCPは1つのURL・1回のログインで使え、強いMCPは別のログインに分かれる。
- OpenScreenを最初のMCPとして、`https://mcp.wwwyo.dev/mcp`から使える。

### Non-Goals

- このProxyを、公開単位ごとに上流を設定できるよう汎用化すること。Portalsで要件を満たせない場合にだけ再検討する。
- stdio専用MCPの直接サポート。既存のstdio→HTTP bridgeを前段に置き、自前で実装しない。
- OAuthサーバーの自前実装（[ADR 0001](../../adr/0001-auth-boundary.md)）。
- 本人以外への共有、チーム利用。

## Glossary

- **Portal**: 外部agentに見せる入口。1つのURLとAccess appを持ち、登録したMCP serverのtoolをまとめて出す。
- **MCP server（portal上）**: portalに登録したローカルMCP。上流URL、固定token、Gateway経由の有無、server単位のAccess policyを持つ。
- **上流の秘密**: 上流MCPだけに送る固定のBearerやヘッダー値。Cloudflareに保存する（2026-10-13決定）。

## Domain Model

```text
ChatGPT ──OAuth──▶ portal mcp.wwwyo.dev ──▶ Gateway ──▶ Tunnel ──▶ 127.0.0.1:<port> (ローカルMCP)
                     ├ OpenScreen                     （network policyで許可したportだけ通す）
                     └ 今後の権限の弱いMCP
ChatGPT ──OAuth──▶ portal <name>-mcp.wwwyo.dev ──▶ … ──▶ 権限の強いMCP（単独）
```

- Portalへのログインと、MCP serverごとのAccess policyの両方を満たした利用者だけが、そのserverのtoolを見られる。
- portalからローカルへの経路はGatewayとTunnelを通る。`127.0.0.1/32`のrouteはloopbackの全portへ届きうるため、Gatewayのnetwork policyで公開するportだけを許可する。
- 削除・書き込み系のtoolは、必要になるまでportalで無効にする。

## 代替との比較

Portalsを選んだ理由と、手放したものを残す。

| 観点 | MCP Server Portals（採用） | このProxyを汎用化 | sigbit/mcp-auth-proxy | Stacklok ToolHive |
| --- | --- | --- | --- | --- |
| 外部agentの認証 | Access Managed OAuth | Access Managed OAuth | 自前のOAuth 2.1。ChatGPTでの動作は検証済みとされる | OIDC gateway |
| 上流への固定token | serverごとのbearer・custom headers | Proxyが付与 | 未確認 | 未確認 |
| 上流の秘密の置き場 | Cloudflare | ローカルのmise + age | 未確認 | 未確認 |
| 上流へ利用者IDを渡す | 渡さない | Access JWTを検証し`sub`で縛る | 未確認 | 未確認 |
| 複数MCPの束ね・tool選択 | ある | ない | 未確認 | ある |
| localhostの上流 | 届く（Tunnelの`127.0.0.1/32` route、Gateway routing、2026-10-13検証） | 届く | 届く（ローカルで動く） | 未確認 |
| 追加で必要なもの | Gateway routing、network policy | Proxyの常駐と公開単位ごとの設定 | OAuthサーバーの運用 | コンテナ実行環境。個人用途には重い |

手放したのは、上流で利用者を確かめることと、秘密をローカルだけに置くことである。どちらかが必要なMCPが出てきたら、そのMCPに限ってこのProxyの汎用化を再検討する。sigbit/mcp-auth-proxyはADR 0001と方針が衝突するため、Access以外の認証基盤へ移る場合にだけ再検討する。

## Acceptance Criteria

- 本人がChatGPTに`https://mcp.wwwyo.dev/mcp`を登録してログインすると、OpenScreenのtoolを一覧でき、読み取り系のtoolを呼び出せる。
- 2つ目の権限の弱いMCPを、portalへの登録だけで同じURLから使える。
- 権限の強いMCPは別のportalにあり、`mcp.wwwyo.dev`へのログインだけでは届かない。
- 公開していないloopbackのportには、portal経由で届かない。
- 上流の秘密は、外部agentへの応答・ログ・git管理下のファイルのいずれにも平文で現れない。

## Success Metrics

- 2つ目のローカルMCPを公開する作業が、portalへの登録とnetwork policyの許可だけで済む。
- ChatGPTから、portal経由のMCPを1週間、日常的に使う。

## 検証済み・未決事項

- 検証済み（2026-10-13）: portalから`http://127.0.0.1:47821/mcp`のOpenScreenへ届き、固定Bearerで25個のtoolを同期できた。network policyを有効にすると47822への接続は失敗し、無効にすると届いた。portalは未認証時に401と`WWW-Authenticate`を返し、OAuth discovery（DCR・S256・refresh）も揃っている。
- 検証済み（2026-10-13）: ChatGPTに`https://mcp.wwwyo.dev/mcp`をOAuthで登録してログインし、OpenScreenの`getCurrentDocument`を実行できた。
- 運用上の注意: MCP serverのIDに`-`を含めると、ChatGPTからのtool呼び出しが`Invalid tool name format`で失敗した（portalはtool名を`serverId_toolName`で扱う）。IDは英数字だけにする。ChatGPTには`/mcp`まで含むURLを登録する。portalをAPIで更新するときは、省いた項目が既定値に戻るので全項目を指定する。
- 決定: 上流の秘密はCloudflareに預ける（2026-10-13）。
