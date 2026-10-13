---
status: draft
---

# ローカルMCPを公開するRouteの汎用化

## Problem

ローカルで動くMCPサーバーを、ChatGPTなどの外部agentから使いたい。現在のProxyはOpenScreen専用で、上流URL・固定token・Access AUDを環境変数で1組しか持てない。2つ目のMCPを公開するには、Proxyを複製するか、同じAccessログインの先に複数のMCPを並べるしかない。後者の場合、1回のログインでローカルの全toolに外部agentが届き、filesystemやshell系のMCPがprompt injectionの経路になる。

## Overview

本人は、公開したいローカルMCPごとにRouteを宣言する。外部agentは、Routeごとに別のAccess appでOAuthログインし、そのRouteのtoolだけを使える。上流の固定tokenは、外部agentの手に渡らない。

### Goals

- 2つ目以降のローカルMCPを、コードを変更せずにRouteの宣言だけで公開できる。
- Route同士の認証境界を分け、あるRouteの認可で別のRouteに届かないようにする（[ADR 0002](../../adr/0002-access-app-per-route.md)）。
- OpenScreenは、最初のRouteとして公開URLを変えずに使い続けられる。

### Non-Goals

- 複数MCPの集約・toolの取捨選択。必要になったらMCP Server Portalsに任せる。
- stdio専用MCPの直接サポート。既存のstdio→HTTP bridgeを前段に置き、自前で実装しない。
- OAuthサーバーの自前実装（[ADR 0001](../../adr/0001-auth-boundary.md)）。
- 本人以外への共有、チーム利用。
- 旧式HTTP+SSE、WebSocket、ブラウザからの直接接続。

## Glossary

- **Route**: 外部agentへ公開する単位。公開URL、上流MCPのURL、上流の秘密を参照するmiseの環境変数名、Access app（AUD）の組。
- **上流の秘密**: 上流MCPだけに送る固定のBearerやヘッダー値。現状のOpenScreen tokenを一般化したもの。

## Domain Model

```text
外部agent ──OAuth──▶ Access app (Route A) ──JWT──▶ Proxy ──秘密A──▶ ローカルMCP A
外部agent ──OAuth──▶ Access app (Route B) ──JWT──▶ Proxy ──秘密B──▶ ローカルMCP B
```

- 1つのRouteに、Access appを1つだけ割り当てる。逆に、1つのAccess appを複数のRouteで共有しない。
- Proxyは、リクエストのAccess JWTのAUDが、そのRouteのAccess appと一致する場合だけ中継する。
- 上流のMCPセッションは、Routeとsession owner（JWTの`sub`）の組に結び付ける。別のRouteで作ったセッションは使えない。
- 上流の秘密は、Routeの宣言には環境変数名として書き、値はmise + ageから実行時に読む。

## 最初に判断すること: MCP Server Portalsで足りるか

Cloudflareの[MCP Server Portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)のドキュメント（2026-10-13確認）には、次の機能が書かれている。上流への固定Bearer・カスタムヘッダーの付与、Tunnelなどのconnectorとprivate hostnameを使った、private networkにある上流への接続（Gateway routingが必須、Streamable HTTPのみ）、serverごとのAccess policy、portal単位のtoolの取捨選択。これらで足りるなら、自前の汎用化は不要になる。実装の前に、OpenScreenをPortals経由でChatGPTから使えるかを試し、次の表の未確認項目を埋めて方針を決める。

| 観点 | このProxyを汎用化 | MCP Server Portals | sigbit/mcp-auth-proxy | Stacklok ToolHive |
| --- | --- | --- | --- | --- |
| 外部agentの認証 | Access Managed OAuth | Access（portalごとのapp） | 自前のOAuth 2.1。ChatGPTでの動作は検証済みとされる | OIDC gateway |
| 上流への固定token | Proxyが付与 | serverごとのbearer・custom headersを付与 | 未確認 | 未確認 |
| 上流の秘密の置き場 | ローカルのmise + age | Cloudflareの設定に保存 | 未確認 | 未確認 |
| 上流へ利用者IDを渡す | Access JWTを検証し`sub`で縛る | 渡さないと記載。上流側でsession ownerを確かめられない | 未確認 | 未確認 |
| Routeごとの認証境界 | Access appを分ける（ADR 0002） | portalを分ければ可能。1つのportal内では、1回のログインで全serverに届く | 未確認 | 未確認 |
| stdio MCP | 対象外（bridgeを前段） | 対象外（Streamable HTTP / SSE） | stdio・HTTPとも公開できる | コンテナで隔離して実行 |
| private networkの上流 | 対象（Proxyが同じマシンで中継） | ドキュメントに対応の記載あり。localhostだけで待ち受けるHTTPの上流に届くかは未確認 | 未確認 | 未確認 |
| 追加で必要なもの | Proxyの常駐 | Gateway routing、private hostname | OAuthサーバーの運用 | コンテナ実行環境。個人用途には重い |
| ChatGPTとの接続 | 未実施（Access discoveryは検証済み） | 未確認 | 検証済みとされる | 未確認 |

判断の基準:

- Portalsで、OpenScreenをprivate network経由・固定Bearer付きでChatGPTから使え、上流の秘密をCloudflareに預けることを許容できるなら、自前の汎用化は行わない。このProxyは現行のOpenScreen用として維持するか廃止する。
- 上流で利用者を確かめる必要があるか、秘密をローカルに留めたい場合は、このProxyをRoute単位に汎用化する。
- sigbit/mcp-auth-proxyはOAuthサーバーを自前で持つため、ADR 0001と方針が衝突する。Access以外の認証基盤へ移る場合にだけ再検討する。ToolHiveは個人用途には重く、比較対象に留める。

## Acceptance Criteria

方針がどちらに決まっても、次を満たす。

- 本人がRouteを1つ宣言して起動すると、外部agentはそのRouteのMCPのtoolを一覧でき、呼び出せる。コードの変更は不要。
- Route AのAccess appで得た認可では、Route Bへのリクエストが拒否される。
- Route Aで確立したMCPセッションのIDをRoute Bへ送っても、Route Bの上流には中継されない。
- 上流の秘密は、外部agentへの応答・ログ・git管理下のファイルのいずれにも平文で現れない。
- 汎用化後もOpenScreenは同じ公開URLで使える。変わる場合は移行手順がある。

## Success Metrics

- 2つ目のローカルMCPを公開する作業が、Routeの宣言とAccess appの作成だけで済む。
- 2つ目のRouteを実際に公開し、1週間、外部agentから日常的に使う。

## 未決事項

- Portalsが、localhostだけで待ち受けるMCPへTunnel経由で届くか。HTTPの上流を受け付けるか。
- ChatGPTが、Portals（stateless MCP `2026-07-28`対応のclient向け`/mcp`）と接続できるか。
- 上流の秘密をCloudflareに預けることを許容するか。
